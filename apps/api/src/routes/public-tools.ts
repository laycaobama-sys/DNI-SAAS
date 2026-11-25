import {
  aiReadiness,
  extractPage,
  imageInfo,
  keywordGap,
  LINK_CHECK_BATCH,
  linkTargets,
  linkVerdict,
  ogImageProblems,
  pageTerms,
  safeFetch,
  UrlBlockedError,
  validatePublicUrl,
  type OgImageCheck,
  type Resolver,
  type SafeFetchResult,
} from "@dni/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { hashIp } from "../lib/util";

/**
 * Free tools that read a public web page for a visitor without an account (/herramientas/*): share image
 * (og:image), broken links, keyword gap against a competitor and readiness for AI assistants.
 * - Same SSRF protection as the crawler (public hosts only, DNS re-checked, redirects re-validated).
 * - Limits per hashed IP and a global daily cap, so nobody can use us to hammer a site.
 * - Deterministic: no AI, no credits. The page content is DATA, only counted and compared.
 */
export const publicTools = new Hono<AppEnv>();

const IP_PER_HOUR = 30;
const IP_PER_DAY = 120;
const GLOBAL_PER_DAY = 3000;
const UA = "DNIGrowthTools/1.0 (+https://dnigrowth.com/herramientas)";

const small = bodyLimit({
  maxSize: 8192,
  onError: () => {
    throw new ApiError(413, "payload_too_large", "Petición demasiado grande.");
  },
});

function sameOrigin(c: Context<AppEnv>) {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin && origin !== c.env.APP_ORIGIN) throw new ApiError(403, "origin_not_allowed", "Origen no permitido.");
}

async function guard(c: Context<AppEnv>, cost = 1) {
  sameOrigin(c);
  const ip = (await hashIp(c.env, c.req.header("cf-connecting-ip"))) ?? "noip";
  for (let i = 0; i < cost; i++) {
    await rateLimit(c.env.DB, `ptools:ip:${ip}`, IP_PER_HOUR, 3600);
    await rateLimit(c.env.DB, `ptools:ipday:${ip}`, IP_PER_DAY, 86400);
  }
  try {
    await rateLimit(c.env.DB, "ptools:global", GLOBAL_PER_DAY, 86400);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) throw new ApiError(429, "tools_daily_cap", "Hoy ya se han usado todas las comprobaciones gratuitas. Vuelve mañana o crea tu cuenta gratis.", e.extra);
    throw e;
  }
}

/**
 * Network access for the tools. Our own site is served by this same Worker (a Worker cannot fetch its own
 * zone over the internet: Cloudflare answers 522), so visitors can also check dnigrowth.com.
 */
function toolFetch(c: Context<AppEnv>): typeof fetch {
  const base = c.get("deps").fetchImpl;
  const self = c.get("selfFetch");
  const own = new Set([new URL(c.req.url).host, new URL(c.env.APP_ORIGIN).host]);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (self && own.has(url.host) && url.protocol === "https:") return self(new Request(url, init));
    return base(input, init);
  }) as typeof fetch;
}

/** One DNS answer per host per request (each lookup is a subrequest). */
function memoResolver(resolve: Resolver): Resolver {
  const cache = new Map<string, Promise<string[]>>();
  return (host) => {
    let p = cache.get(host);
    if (!p) {
      p = resolve(host);
      cache.set(host, p);
    }
    return p;
  };
}

function target(raw: string): URL {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return validatePublicUrl(withScheme);
  } catch (e) {
    if (e instanceof UrlBlockedError) throw new ApiError(422, "url_not_allowed", "Esa dirección no se puede comprobar. Usa la dirección pública de una web (https://…).");
    throw new ApiError(422, "url_not_allowed", "Escribe una dirección válida, por ejemplo https://tuweb.com.");
  }
}

const friendly = (e: unknown) => {
  if (e instanceof UrlBlockedError) return "Esa dirección no es pública o redirige a un sitio no permitido.";
  if (e instanceof Error && /abort/i.test(e.name + e.message)) return "La web tardó demasiado en responder.";
  return "No pudimos descargar la página.";
};

async function fetchPage(c: Context<AppEnv>, url: URL, resolve: Resolver): Promise<SafeFetchResult> {
  try {
    return await safeFetch(url.toString(), { resolve, fetchImpl: toolFetch(c), userAgent: UA, timeoutMs: 10_000, maxBytes: 1_500_000, maxRedirects: 4 });
  } catch (e) {
    throw new ApiError(422, "page_unreachable", friendly(e));
  }
}

const htmlOf = (r: SafeFetchResult) => (r.status < 400 && /html/.test(r.contentType) ? r.body : null);

const UrlInput = z.strictObject({ url: z.string().trim().min(3).max(500) });

// ── Share image (og:image) ────────────────────────────────────────────────────────────────────────
publicTools.post("/tools/og-image", small, async (c) => {
  const { url } = await parseBody(c, UrlInput);
  const u = target(url);
  await guard(c);
  const resolve = memoResolver(c.get("deps").resolve);
  const r = await fetchPage(c, u, resolve);
  const html = htmlOf(r);
  if (!html) throw new ApiError(422, "page_unreachable", r.status >= 400 ? `La página responde con HTTP ${r.status}.` : "La dirección no es una página HTML.");
  const p = extractPage(html, r.finalUrl);
  const raw = p.og.image ?? p.twitter.image ?? null;
  let image: (OgImageCheck & { problems: string[] }) | null = null;
  if (raw) {
    let abs: string | null = null;
    try {
      abs = new URL(raw, r.finalUrl).toString();
    } catch {
      /* invalid */
    }
    let check: OgImageCheck;
    if (!abs) check = { url: raw.slice(0, 300), status: null, contentType: "", contentLength: null, info: null, error: "invalid_url" };
    else {
      try {
        const ir = await safeFetch(abs, { resolve, fetchImpl: toolFetch(c), userAgent: UA, accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", timeoutMs: 10_000, maxBytes: 300_000, binaryPrefixBytes: 262_144, maxRedirects: 3 });
        const len = Number(ir.headers["content-length"] ?? "");
        const bytes = ir.bytes ?? new TextEncoder().encode(ir.body.slice(0, 1024));
        check = { url: abs, status: ir.status, contentType: ir.contentType.split(";")[0] ?? "", contentLength: Number.isFinite(len) && len > 0 ? len : null, info: ir.status < 400 ? imageInfo(bytes, ir.contentType) : null };
      } catch (e) {
        check = { url: abs, status: null, contentType: "", contentLength: null, info: null, error: e instanceof Error ? e.name : "fetch_failed" };
      }
    }
    image = { ...check, problems: ogImageProblems(check) };
  }
  const tags = { title: p.og.title ?? null, description: p.og.description ?? null, url: p.og.url ?? null, type: p.og.type ?? null, siteName: p.og.site_name ?? null, twitterCard: p.twitter.card ?? null };
  const problems: string[] = [];
  if (!raw) problems.push("No tienes og:image: al compartir la página, redes y WhatsApp no muestran imagen (o eligen una al azar).");
  if (!tags.title) problems.push(p.title ? "Falta og:title: se usará el título de la página." : "Falta og:title y la página no tiene título.");
  if (!tags.description) problems.push("Falta og:description.");
  if (!tags.twitterCard) problems.push("Falta twitter:card (en X la vista previa sale pequeña o sin imagen). Usa «summary_large_image».");
  return c.json({ url: r.finalUrl, pageTitle: p.title, tags, image, problems, checkedAt: new Date().toISOString() });
});

// ── Broken links: 1) list the links of a page, 2) check them in batches of 10 ─────────────────────
publicTools.post("/tools/links", small, async (c) => {
  const { url } = await parseBody(c, UrlInput);
  const u = target(url);
  await guard(c);
  const r = await fetchPage(c, u, memoResolver(c.get("deps").resolve));
  const html = htmlOf(r);
  if (!html) throw new ApiError(422, "page_unreachable", r.status >= 400 ? `La página responde con HTTP ${r.status}.` : "La dirección no es una página HTML.");
  const p = extractPage(html, r.finalUrl);
  const all = new Set(p.links.map((l) => l.href)).size;
  return c.json({ url: r.finalUrl, links: linkTargets(p), total: all, batch: LINK_CHECK_BATCH });
});

const CheckInput = z.strictObject({ urls: z.array(z.string().trim().min(8).max(2000)).min(1).max(LINK_CHECK_BATCH) });

publicTools.post("/tools/links/check", small, async (c) => {
  const { urls } = await parseBody(c, CheckInput);
  await guard(c);
  const resolve = memoResolver(c.get("deps").resolve);
  const fetchImpl = toolFetch(c);
  const one = async (raw: string) => {
    let u: URL;
    try {
      u = validatePublicUrl(raw);
    } catch {
      return { url: raw, status: null, verdict: "error" as const, note: "Dirección no comprobable (no es pública)." };
    }
    const opts = { resolve, fetchImpl, userAgent: UA, timeoutMs: 8_000, maxBytes: 4096, maxRedirects: 0 };
    try {
      let r = await safeFetch(u.toString(), { ...opts, method: "HEAD" });
      // Some servers do not implement HEAD; ask again with GET (body capped at 4 kB).
      if (r.status === 405 || r.status === 501 || r.status === 404 || r.status === 403) r = await safeFetch(u.toString(), opts);
      return { url: raw, status: r.status, verdict: linkVerdict(r.status), location: r.status >= 300 && r.status < 400 ? (r.headers.location ?? null) : null };
    } catch (e) {
      if (e instanceof UrlBlockedError && e.reason === "too_many_redirects") return { url: raw, status: 301, verdict: "redirect" as const };
      return { url: raw, status: null, verdict: "error" as const, note: friendly(e) };
    }
  };
  const results = [];
  // 3 at a time: polite to the target site and within the per-request subrequest budget.
  for (let i = 0; i < urls.length; i += 3) results.push(...(await Promise.all(urls.slice(i, i + 3).map(one))));
  return c.json({ results, checkedAt: new Date().toISOString() });
});

// ── Keyword gap ───────────────────────────────────────────────────────────────────────────────────
const GapInput = z.strictObject({ mine: z.string().trim().min(3).max(500), competitor: z.string().trim().min(3).max(500) });

publicTools.post("/tools/keyword-gap", small, async (c) => {
  const body = await parseBody(c, GapInput);
  const mineU = target(body.mine);
  const compU = target(body.competitor);
  if (mineU.toString() === compU.toString()) throw new ApiError(422, "same_page", "Escribe dos páginas distintas: la tuya y la de tu competidor.");
  await guard(c, 2);
  const resolve = memoResolver(c.get("deps").resolve);
  const [a, b] = await Promise.all([fetchPage(c, mineU, resolve), fetchPage(c, compU, resolve)]);
  const ha = htmlOf(a);
  const hb = htmlOf(b);
  if (!ha) throw new ApiError(422, "page_unreachable", `Tu página no se pudo leer${a.status >= 400 ? ` (HTTP ${a.status})` : ""}.`);
  if (!hb) throw new ApiError(422, "page_unreachable", `La página del competidor no se pudo leer${b.status >= 400 ? ` (HTTP ${b.status})` : ""}.`);
  const gap = keywordGap(pageTerms(ha, a.finalUrl), pageTerms(hb, b.finalUrl));
  return c.json({ mine: a.finalUrl, competitor: b.finalUrl, ...gap, checkedAt: new Date().toISOString() });
});

// ── Readiness for AI assistants ───────────────────────────────────────────────────────────────────
publicTools.post("/tools/ai-readiness", small, async (c) => {
  const { url } = await parseBody(c, UrlInput);
  const u = target(url);
  await guard(c);
  const resolve = memoResolver(c.get("deps").resolve);
  const fetchImpl = toolFetch(c);
  /** found = text file; missing = 404/410 or an HTML page instead of the file; unknown = could not tell. */
  const side = async (path: string): Promise<{ body: string | null; unknown: boolean }> => {
    try {
      const r = await safeFetch(new URL(path, u).toString(), { resolve, fetchImpl, userAgent: UA, timeoutMs: 8_000, maxBytes: 200_000, maxRedirects: 2, accept: "text/plain,*/*;q=0.5" });
      if (r.status === 200 && !/html/.test(r.contentType)) return { body: r.body, unknown: false };
      return { body: null, unknown: r.status >= 500 || r.status === 429 };
    } catch {
      return { body: null, unknown: true };
    }
  };
  const [page, robotsTxt, llmsTxt] = await Promise.all([
    safeFetch(u.toString(), { resolve, fetchImpl, userAgent: UA, timeoutMs: 10_000, maxBytes: 1_500_000, maxRedirects: 4 }).catch(() => null),
    side("/robots.txt"),
    side("/llms.txt"),
  ]);
  const html = page ? htmlOf(page) : null;
  const report = aiReadiness({
    page: html && page ? extractPage(html, page.finalUrl) : null,
    status: page?.status ?? null,
    https: (page ? new URL(page.finalUrl) : u).protocol === "https:",
    robotsTxt: robotsTxt.body,
    llmsTxt: llmsTxt.body,
    robotsUnknown: robotsTxt.unknown,
    llmsUnknown: llmsTxt.unknown,
  });
  return c.json({ url: page?.finalUrl ?? u.toString(), ...report, checkedAt: new Date().toISOString() });
});
