import {
  assertResolvesPublic,
  crawlDelayFor,
  CRAWLER_USER_AGENT,
  extractPage,
  imageInfo,
  isAllowed,
  normalizeForCrawl,
  parseRobots,
  parseSitemap,
  safeFetch,
  validatePublicUrl,
  type CrawledPage,
  type OgImageCheck,
  type RobotsTxt,
  type SafeFetchResult,
  type SiteContext,
} from "@dni/core";
import type { Deps } from "../env";

/**
 * SSRF-safe crawl shared by the full analysis (jobs/analyze.ts) and the free audit without an account
 * (jobs/public-audit.ts): robots.txt, sitemap and llms.txt, then a BFS (depth ≤ 2) of at most `pagesLimit`
 * HTML pages of the same origin, honouring robots for our user agent and waiting between requests.
 * Only public, non-intrusive GETs. Everything fetched is untrusted data.
 */
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|gz|mp4|mp3|webm|mov|docx?|xlsx?|pptx?|css|js|json|xml|woff2?|ttf|txt|md|csv|rss|atom)$/i;
export const isHtml = (contentType: string) => /text\/html|application\/xhtml/.test(contentType);
const MAX_DELAY_MS = 5000;

export interface CrawlHooks {
  event(level: "info" | "warn" | "error", kind: string, message: string, data?: Record<string, unknown>): Promise<void>;
  progress(pct: number): Promise<void>;
  /** Throws to stop the crawl (e.g. the user cancelled the job). */
  checkpoint(): Promise<void>;
  /** Called once the URL and its DNS are validated, before the first request. */
  afterValidate?(): Promise<void>;
}

export interface CrawlOutput {
  site: SiteContext;
  skipped: Array<{ url: string; reason: string }>;
  robotsTxt: string | null;
  /** SSRF-safe GET that never throws (null on failure), for extra same-site resources. */
  tryFetch(url: string, accept?: string): Promise<SafeFetchResult | null>;
}

export function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

export async function crawlSite(deps: Deps, startUrl: string, pagesLimit: number, hooks: CrawlHooks, opts: { timeoutMs?: number } = {}): Promise<CrawlOutput> {
  await hooks.event("info", "validating", "Validando URL y DNS (protección SSRF)");
  const start = validatePublicUrl(startUrl);
  await assertResolvesPublic(start, deps.resolve);
  await hooks.progress(5);
  await hooks.afterValidate?.();

  const fetchOpts = { resolve: deps.resolve, fetchImpl: deps.fetchImpl, timeoutMs: opts.timeoutMs ?? 10_000 };
  const tryFetch = async (url: string, accept?: string): Promise<SafeFetchResult | null> => {
    try {
      return await safeFetch(url, { ...fetchOpts, accept, maxBytes: 2_000_000 });
    } catch (e) {
      await hooks.event("warn", "fetch_failed", `No se pudo obtener ${url}`, { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  // Homepage first: establishes the canonical origin after redirects (http→https, www).
  const home = await safeFetch(start.toString(), { ...fetchOpts, maxBytes: 2_000_000 });
  const origin = new URL(home.finalUrl).origin;
  const servedOverHttps = new URL(home.finalUrl).protocol === "https:";
  await hooks.event("info", "homepage", `Página principal: HTTP ${home.status}`, { finalUrl: home.finalUrl, redirects: home.redirects.length });

  // robots.txt
  const robotsRes = await tryFetch(`${origin}/robots.txt`, "text/plain");
  const robotsFound = !!robotsRes && robotsRes.status === 200 && /text\/plain|^$/.test(robotsRes.contentType.split(";")[0] ?? "");
  const robots: RobotsTxt = robotsFound ? parseRobots(robotsRes!.body) : { groups: [], sitemaps: [] };
  const robotsBlocksAll = robotsFound && !isAllowed(robots, "Googlebot", "/");
  const delayMs = Math.min(MAX_DELAY_MS, Math.max(1000, (crawlDelayFor(robots, CRAWLER_USER_AGENT) ?? 1) * 1000));
  await hooks.progress(12);

  // sitemap(s) — same origin only
  const sitemapCandidates = [...robots.sitemaps.filter((s) => safeOrigin(s) === origin), `${origin}/sitemap.xml`].slice(0, 3);
  let sitemapUrls: string[] = [];
  let sitemapFound = false;
  for (const sm of sitemapCandidates) {
    const r = await tryFetch(sm, "application/xml,text/xml");
    if (!r || r.status !== 200) continue;
    let parsed = parseSitemap(r.body);
    if (parsed.kind === "unknown") continue;
    sitemapFound = true;
    if (parsed.kind === "index") {
      const child = parsed.locs.find((l) => safeOrigin(l) === origin);
      const cr = child ? await tryFetch(child, "application/xml,text/xml") : null;
      parsed = cr && cr.status === 200 ? parseSitemap(cr.body) : { kind: "urlset", locs: [] };
    }
    sitemapUrls = parsed.locs.filter((l) => safeOrigin(l) === origin);
    break;
  }
  const llms = await tryFetch(`${origin}/llms.txt`, "text/plain");
  const llmsTxtFound = !!llms && llms.status === 200 && /text\/(plain|markdown)/.test(llms.contentType);
  await hooks.event("info", "discovery", "robots.txt, sitemap y llms.txt revisados", { robotsFound, sitemapFound, sitemapUrls: sitemapUrls.length, llmsTxtFound });
  await hooks.progress(18);

  // Crawl (BFS, depth ≤ 2), honouring robots for our UA, delay between requests.
  const pages: CrawledPage[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [];
  const enqueue = (u: string, depth: number) => {
    let n: string;
    try {
      n = normalizeForCrawl(u);
    } catch {
      return;
    }
    if (seen.has(n) || safeOrigin(n) !== origin || SKIP_EXT.test(new URL(n).pathname)) return;
    seen.add(n);
    queue.push({ url: n, depth });
  };

  const homeUrl = normalizeForCrawl(home.finalUrl);
  seen.add(homeUrl);
  const homePath = new URL(homeUrl);
  if (robotsFound && !isAllowed(robots, CRAWLER_USER_AGENT, homePath.pathname + homePath.search)) {
    skipped.push({ url: homeUrl, reason: "robots_disallow" });
    await hooks.event("warn", "robots_disallow", "robots.txt no permite rastrear la home a nuestro bot; solo se analizan metadatos públicos.");
  } else {
    pages.push(toPage(home, homeUrl));
  }
  for (const l of pages[0]?.extraction?.links ?? []) if (l.internal && !/nofollow/.test(l.rel)) enqueue(l.href, 1);
  for (const s of sitemapUrls.slice(0, 200)) enqueue(s, 1);

  while (queue.length && pages.length < pagesLimit) {
    await hooks.checkpoint();
    const next = queue.shift()!;
    const u = new URL(next.url);
    if (robotsFound && !isAllowed(robots, CRAWLER_USER_AGENT, u.pathname + u.search)) {
      skipped.push({ url: next.url, reason: "robots_disallow" });
      continue;
    }
    await deps.sleep(delayMs);
    const r = await tryFetch(next.url);
    if (!r) {
      skipped.push({ url: next.url, reason: "fetch_failed" });
      continue;
    }
    if (safeOrigin(r.finalUrl) !== origin) {
      skipped.push({ url: next.url, reason: "redirect_offsite" });
      continue;
    }
    // Only HTML documents are pages (B5): llms.txt, feeds or files linked from the site are checked apart or ignored.
    if (r.status < 400 && !isHtml(r.contentType)) {
      skipped.push({ url: next.url, reason: "not_html" });
      continue;
    }
    const finalNorm = normalizeForCrawl(r.finalUrl);
    if (finalNorm !== next.url && pages.some((p) => p.finalUrl === finalNorm)) continue;
    const page = toPage(r, finalNorm);
    pages.push(page);
    if (next.depth < 2) for (const l of page.extraction?.links ?? []) if (l.internal && !/nofollow/.test(l.rel)) enqueue(l.href, next.depth + 1);
    await hooks.progress(18 + (62 * pages.length) / pagesLimit);
  }
  await hooks.event("info", "crawled", `${pages.length} página(s) analizadas`, { skipped: skipped.length, limit: pagesLimit });
  await hooks.checkpoint();

  // og:image of the home (B6): download its first bytes (SSRF-safe) to check format and size.
  const ogImage = await checkOgImage(pages[0]?.extraction?.og["image"] ?? null, home.finalUrl, fetchOpts);
  if (ogImage) await hooks.event("info", "og_image", "Imagen para compartir (og:image) revisada", { format: ogImage.info?.format ?? null, status: ogImage.status });

  const site: SiteContext = { origin, homepageUrl: homeUrl, servedOverHttps, robotsFound, robotsBlocksAll, sitemapFound, sitemapUrlCount: sitemapUrls.length, llmsTxtFound, pages, ogImage };
  return { site, skipped, robotsTxt: robotsFound ? robotsRes!.body : null, tryFetch };
}

async function checkOgImage(raw: string | null, base: string, fetchOpts: { resolve: Deps["resolve"]; fetchImpl: Deps["fetchImpl"]; timeoutMs: number }): Promise<OgImageCheck | null> {
  if (!raw) return null;
  let url: string;
  try {
    url = new URL(raw, base).toString();
  } catch {
    return { url: raw.slice(0, 300), status: null, contentType: "", contentLength: null, info: null, error: "invalid_url" };
  }
  try {
    const r = await safeFetch(url, { ...fetchOpts, accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", maxBytes: 300_000, binaryPrefixBytes: 262_144 });
    const len = Number(r.headers["content-length"] ?? "");
    const bytes = r.bytes ?? new TextEncoder().encode(r.body.slice(0, 1024));
    return { url, status: r.status, contentType: r.contentType.split(";")[0] ?? "", contentLength: Number.isFinite(len) && len > 0 ? len : null, info: r.status < 400 ? imageInfo(bytes, r.contentType) : null };
  } catch (e) {
    return { url, status: null, contentType: "", contentLength: null, info: null, error: e instanceof Error ? e.name : "fetch_failed" };
  }
}

function toPage(r: SafeFetchResult, normalized: string): CrawledPage {
  return {
    url: r.requestedUrl,
    finalUrl: normalized,
    status: r.status,
    contentType: r.contentType,
    durationMs: r.durationMs,
    truncated: r.truncated,
    redirects: r.redirects,
    extraction: isHtml(r.contentType) && r.status < 400 ? extractPage(r.body, r.finalUrl) : null,
  };
}
