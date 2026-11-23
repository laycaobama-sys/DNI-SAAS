import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError, parseBody } from "../lib/http";
import { PRODUCT_EVENTS, requestVisitorHash, trackEvent } from "../lib/product-events";
import { rateLimit } from "../lib/ratelimit";
import { hashIp } from "../lib/util";

/**
 * POST /api/v1/public/events: cookieless product events declared by our own pages (ADR 0021).
 * Allow-listed events only, small sanitised props, path without query, no personal data, no organisation
 * (a browser can never attribute an event to a tenant), rate-limited per hashed IP. Stored as source
 * «client» so the console tells them apart from the events the server records itself.
 */
export const eventsPublic = new Hono<AppEnv>();

const EventInput = z.strictObject({
  event: z.enum(PRODUCT_EVENTS),
  path: z.string().max(400).optional(),
  props: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
});

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|curl|wget|python|httpclient/i;

// 2 KB cap whether or not the client declares Content-Length (a streamed body is cut while it is read).
const smallBody = bodyLimit({
  maxSize: 2048,
  onError: () => {
    throw new ApiError(413, "payload_too_large", "Evento demasiado grande.");
  },
});

eventsPublic.post("/events", smallBody, async (c) => {
  // Only our own pages may declare events (a browser on another site sends its own Origin).
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin && origin !== c.env.APP_ORIGIN) throw new ApiError(403, "origin_not_allowed", "Origen no permitido.");
  const ipKey = (await hashIp(c.env, c.req.header("cf-connecting-ip"))) ?? "noip";
  await rateLimit(c.env.DB, `events:ip:${ipKey}`, 60, 600);
  await rateLimit(c.env.DB, `events:ipday:${ipKey}`, 600, 86400);
  const input = await parseBody(c, EventInput);
  const headers = { "cache-control": "no-store" };
  // Crawlers and automated clients are not visitors: accepted (no retry storms) but not counted.
  if (BOT_UA.test(c.req.header("user-agent") ?? "")) return c.json({ ok: true, recorded: false }, 202, headers);
  const recorded = await trackEvent(c.env.DB, {
    event: input.event,
    organizationId: null,
    props: input.props,
    path: input.path,
    visitorHash: await requestVisitorHash(c),
    source: "client",
  });
  return c.json({ ok: true, recorded }, 202, headers);
});
