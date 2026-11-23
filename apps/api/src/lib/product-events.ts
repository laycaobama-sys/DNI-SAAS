import { sha256Hex } from "@dni/core";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { log, nowIso, uuid } from "./util";

/**
 * Own product analytics (ADR 0021): cookieless, no third parties, no personal data. Events are counted for
 * the platform funnel only; tenants never read this table. Nothing here may throw into a business flow.
 */
export const PRODUCT_EVENTS = [
  "audit_started",
  "audit_teaser_viewed",
  "signup",
  "onboarding_step",
  "gsc_connected",
  "cms_connected",
  "first_article_published",
  "trial_started",
  "subscribed",
  "upgraded",
  "canceled",
  "paused",
] as const;
export type ProductEvent = (typeof PRODUCT_EVENTS)[number];

export const isProductEvent = (v: unknown): v is ProductEvent => typeof v === "string" && (PRODUCT_EVENTS as readonly string[]).includes(v);

/** Spanish labels and funnel stage for the platform console. Churn events are shown apart from the funnel. */
export const PRODUCT_EVENT_INFO: Record<ProductEvent, { label: string; stage: "funnel" | "churn" }> = {
  audit_started: { label: "Auditoría iniciada", stage: "funnel" },
  audit_teaser_viewed: { label: "Avance de auditoría visto", stage: "funnel" },
  signup: { label: "Registro", stage: "funnel" },
  onboarding_step: { label: "Paso de bienvenida", stage: "funnel" },
  gsc_connected: { label: "Search Console conectado", stage: "funnel" },
  cms_connected: { label: "CMS conectado", stage: "funnel" },
  first_article_published: { label: "Primer artículo publicado", stage: "funnel" },
  trial_started: { label: "Prueba iniciada", stage: "funnel" },
  subscribed: { label: "Suscripción", stage: "funnel" },
  upgraded: { label: "Mejora de plan", stage: "funnel" },
  canceled: { label: "Cancelación", stage: "churn" },
  paused: { label: "Pausa", stage: "churn" },
};

/**
 * Where each event is recorded today. An event that nothing records yet is shown as «sin instrumentar» in the
 * console, so a zero is never mistaken for «nobody did it».
 */
export const INSTRUMENTED: Partial<Record<ProductEvent, string>> = {
  audit_started: "servidor: análisis creado en la app · navegador: formulario de la portada",
  signup: "servidor: registro con correo o con Google",
  onboarding_step: "servidor: correo verificado y organización creada",
  gsc_connected: "servidor: conexión de Search Console completada",
};

/** Events are deleted after 13 months (cron in src/index.ts). */
export const PRODUCT_EVENTS_RETENTION_DAYS = 395;

export type EventProps = Record<string, string | number | boolean>;

const PROP_KEY = /^[a-z][a-z0-9_]{0,31}$/;
// Free text is limited to short labels: no @ (emails), no long digit runs (phones, ids), no URLs.
const PROP_TEXT = /^[\p{L}\p{N} _.:/-]{0,64}$/u;

/** Keeps at most 6 small, non-personal properties; anything else is dropped silently. */
export function sanitizeProps(input: unknown): EventProps {
  const out: EventProps = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= 6) break;
    if (!PROP_KEY.test(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === "string" && PROP_TEXT.test(v) && !/\d{6,}/.test(v) && !/https?:|www\./i.test(v)) out[k] = v;
  }
  return JSON.stringify(out).length <= 512 ? out : {};
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Path only (no origin, query or fragment), ids masked, at most 200 characters. Null when unusable. */
export function sanitizePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let p = input.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    return null;
  }
  p = p.split(/[?#]/)[0] ?? "";
  if (!p.startsWith("/")) return null;
  p = p.replace(UUID_RE, ":id").replace(/\d{6,}/g, ":n");
  if (!/^[\w\-./~:%]*$/.test(p)) return null;
  return p.slice(0, 200);
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Daily visitor hash: sha256(salt | day | IP | user agent), 32 hex characters. The IP is never stored. Null
 * when there is no IP, when the browser sends a privacy signal, or when the salt secret is missing outside
 * development (a hash without a secret could be reversed by brute force over the IPv4 space).
 */
export async function visitorHash(env: Env, ip: string | null | undefined, ua: string | null | undefined, opts: { privacySignal?: boolean; at?: Date } = {}): Promise<string | null> {
  if (!ip || opts.privacySignal) return null;
  const salt = env.IP_HASH_SALT ?? (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test" ? "dev-salt" : null);
  if (!salt) return null;
  return (await sha256Hex(`${salt}|${dayKey(opts.at ?? new Date())}|${ip}|${(ua ?? "").slice(0, 300)}`)).slice(0, 32);
}

/** Global Privacy Control or Do Not Track. */
export const privacySignal = (c: Context<AppEnv>) => c.req.header("sec-gpc") === "1" || c.req.header("dnt") === "1";

/** The daily visitor hash of the current request (see visitorHash). */
export const requestVisitorHash = (c: Context<AppEnv>) => visitorHash(c.env, c.req.header("cf-connecting-ip"), c.req.header("user-agent"), { privacySignal: privacySignal(c) });

export interface TrackInput {
  event: ProductEvent;
  organizationId?: string | null;
  props?: unknown;
  path?: unknown;
  visitorHash?: string | null;
  source?: "server" | "client";
  at?: Date;
}

/**
 * Records one product event. Reusable by any backend flow: it validates and sanitises its input, never
 * throws and returns whether the row was written (analytics must never break signup, audits or billing).
 */
export async function trackEvent(db: D1Database, e: TrackInput): Promise<boolean> {
  try {
    if (!isProductEvent(e.event)) return false;
    const hash = typeof e.visitorHash === "string" && /^[0-9a-f]{32}$/.test(e.visitorHash) ? e.visitorHash : null;
    await db
      .prepare("INSERT INTO product_events (id, organization_id, event, source, props_json, path, visitor_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), e.organizationId ?? null, e.event, e.source ?? "server", JSON.stringify(sanitizeProps(e.props)), sanitizePath(e.path), hash, nowIso(e.at))
      .run();
    return true;
  } catch (err) {
    log("warn", "product_event.failed", { event: String(e.event).slice(0, 40), error: String(err).slice(0, 120) });
    return false;
  }
}

/** trackEvent for a server flow inside a request: adds the daily visitor hash of that request. */
export async function trackFromRequest(c: Context<AppEnv>, event: ProductEvent, extra: { organizationId?: string | null; props?: EventProps } = {}): Promise<boolean> {
  const hash = await requestVisitorHash(c).catch(() => null);
  return trackEvent(c.env.DB, { event, organizationId: extra.organizationId ?? null, props: extra.props, path: c.req.path, visitorHash: hash, source: "server" });
}

/** Retention sweep (cron): deletes events older than PRODUCT_EVENTS_RETENTION_DAYS. */
export async function purgeProductEvents(db: D1Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PRODUCT_EVENTS_RETENTION_DAYS * 86400_000).toISOString();
  const r = await db.prepare("DELETE FROM product_events WHERE created_at < ?").bind(cutoff).run();
  return r.meta.changes ?? 0;
}

export interface FunnelStep {
  event: ProductEvent;
  label: string;
  stage: "funnel" | "churn";
  /** Recorded by the server (verified). */
  server: number;
  /** Declared by a browser through the public endpoint. */
  client: number;
  total: number;
  /** Distinct daily visitor hashes (visitor-days), null when no event of this kind carried a hash. */
  visitorDays: number | null;
  instrumented: boolean;
  instrumentedBy: string | null;
}

/** Funnel per event for the last `days` days (platform console). Aggregates only: no rows are returned. */
export async function productFunnel(db: D1Database, days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * 86400_000).toISOString();
  const [{ results }, { results: steps }] = await Promise.all([
    db
      .prepare("SELECT event, SUM(source = 'server') AS server, SUM(source = 'client') AS client, COUNT(DISTINCT visitor_hash) AS v FROM product_events WHERE created_at >= ? GROUP BY event")
      .bind(since)
      .all<{ event: string; server: number; client: number; v: number }>(),
    db
      .prepare("SELECT json_extract(props_json, '$.step') AS step, COUNT(*) AS n FROM product_events WHERE event = 'onboarding_step' AND created_at >= ? GROUP BY step ORDER BY n DESC LIMIT 20")
      .bind(since)
      .all<{ step: string | null; n: number }>(),
  ]);
  const out: FunnelStep[] = PRODUCT_EVENTS.map((event) => {
    const row = results.find((r) => r.event === event);
    const server = Number(row?.server ?? 0);
    const client = Number(row?.client ?? 0);
    const v = Number(row?.v ?? 0);
    return {
      event,
      ...PRODUCT_EVENT_INFO[event],
      server,
      client,
      total: server + client,
      visitorDays: v > 0 ? v : null,
      instrumented: !!INSTRUMENTED[event],
      instrumentedBy: INSTRUMENTED[event] ?? null,
    };
  });
  return { days, since, steps: out, onboardingSteps: steps.map((s) => ({ step: s.step ?? "sin paso", n: s.n })) };
}
