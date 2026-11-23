import {
  assertResolvesPublic,
  crawlDelayFor,
  CRAWLER_USER_AGENT,
  extractBrand,
  extractPage,
  generateGrowthPlan,
  healthScore,
  imageInfo,
  isAllowed,
  issueScore,
  normalizeForCrawl,
  parseRobots,
  parseSitemap,
  prioritize,
  runSeoRules,
  safeFetch,
  sha256Hex,
  validatePublicUrl,
  type CrawledPage,
  type OgImageCheck,
  type RobotsTxt,
  type SafeFetchResult,
} from "@dni/core";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { batchChunks, nowIso, uuid } from "../lib/util";
import { PermanentJobError, type JobContext } from "./consumer";

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|gz|mp4|mp3|webm|mov|docx?|xlsx?|pptx?|css|js|json|xml|woff2?|ttf|txt|md|csv|rss|atom)$/i;
const isHtml = (contentType: string) => /text\/html|application\/xhtml/.test(contentType);
const MAX_DELAY_MS = 5000;

export interface AnalysisInput {
  url: string;
  brandId: string;
  siteId: string;
}

/**
 * F1 pipeline: SSRF-safe crawl (robots, sitemap, llms.txt, ≤N pages) → deterministic SEO rules →
 * prioritised opportunities → brand facts draft → editable 30-day growth plan.
 * Only public, non-intrusive GETs; robots.txt honoured for our user agent.
 */
export async function runSiteAnalysis(ctx: JobContext, input: AnalysisInput) {
  const { env, deps, job } = ctx;
  const db = env.DB;
  const orgId = job.organization_id;
  const plan = await orgPlan(db, orgId);
  const pagesLimit = plan.limits.pagesPerCrawl;

  await ctx.event("info", "validating", "Validando URL y DNS (protección SSRF)");
  const start = validatePublicUrl(input.url);
  await assertResolvesPublic(start, deps.resolve);
  await ctx.progress(5);

  const crawlId = uuid();
  await db
    .prepare("INSERT INTO web_crawls (id, organization_id, site_id, job_id, pages_limit) VALUES (?, ?, ?, ?, ?)")
    .bind(crawlId, orgId, input.siteId, job.id, pagesLimit)
    .run();

  const fetchOpts = { resolve: deps.resolve, fetchImpl: deps.fetchImpl, timeoutMs: 10_000 };
  const tryFetch = async (url: string, accept?: string): Promise<SafeFetchResult | null> => {
    try {
      return await safeFetch(url, { ...fetchOpts, accept, maxBytes: 2_000_000 });
    } catch (e) {
      await ctx.event("warn", "fetch_failed", `No se pudo obtener ${url}`, { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  // Homepage first: establishes the canonical origin after redirects (http→https, www).
  const home = await safeFetch(start.toString(), { ...fetchOpts, maxBytes: 2_000_000 });
  const origin = new URL(home.finalUrl).origin;
  const servedOverHttps = new URL(home.finalUrl).protocol === "https:";
  await ctx.event("info", "homepage", `Página principal: HTTP ${home.status}`, { finalUrl: home.finalUrl, redirects: home.redirects.length });

  // robots.txt
  const robotsRes = await tryFetch(`${origin}/robots.txt`, "text/plain");
  const robotsFound = !!robotsRes && robotsRes.status === 200 && /text\/plain|^$/.test(robotsRes.contentType.split(";")[0] ?? "");
  const robots: RobotsTxt = robotsFound ? parseRobots(robotsRes!.body) : { groups: [], sitemaps: [] };
  const robotsBlocksAll = robotsFound && !isAllowed(robots, "Googlebot", "/");
  const delayMs = Math.min(MAX_DELAY_MS, Math.max(1000, (crawlDelayFor(robots, CRAWLER_USER_AGENT) ?? 1) * 1000));
  await ctx.progress(12);

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
  await ctx.event("info", "discovery", "robots.txt, sitemap y llms.txt revisados", { robotsFound, sitemapFound, sitemapUrls: sitemapUrls.length, llmsTxtFound });
  await ctx.progress(18);

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
    await ctx.event("warn", "robots_disallow", "robots.txt no permite rastrear la home a nuestro bot; solo se analizan metadatos públicos.");
  } else {
    pages.push(toPage(home, homeUrl));
  }
  for (const l of pages[0]?.extraction?.links ?? []) if (l.internal && !/nofollow/.test(l.rel)) enqueue(l.href, 1);
  for (const s of sitemapUrls.slice(0, 200)) enqueue(s, 1);

  while (queue.length && pages.length < pagesLimit) {
    await ctx.checkpoint();
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
    await ctx.progress(18 + (62 * pages.length) / pagesLimit);
  }
  await ctx.event("info", "crawled", `${pages.length} página(s) analizadas`, { skipped: skipped.length, limit: pagesLimit });
  await ctx.checkpoint();

  // og:image of the home (B6): download its first bytes (SSRF-safe) to check format and size.
  const ogImage = await checkOgImage(pages[0]?.extraction?.og["image"] ?? null, home.finalUrl, fetchOpts);
  if (ogImage) await ctx.event("info", "og_image", "Imagen para compartir (og:image) revisada", { format: ogImage.info?.format ?? null, status: ogImage.status });

  // Deterministic rules + prioritisation
  const site = { origin, homepageUrl: homeUrl, servedOverHttps, robotsFound, robotsBlocksAll, sitemapFound, sitemapUrlCount: sitemapUrls.length, llmsTxtFound, pages, ogImage };
  const issues = runSeoRules(site);
  const opportunities = prioritize(issues, 10);
  const health = healthScore(issues);

  const pageStmts = await Promise.all(
    pages.map(async (p) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO crawl_pages (id, organization_id, crawl_id, url, final_url, status_code, content_type, duration_ms, title, description, h1, canonical, lang, word_count, content_hash, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uuid(), orgId, crawlId, p.url, p.finalUrl, p.status, p.contentType.slice(0, 100), p.durationMs,
          p.extraction?.title ?? null, p.extraction?.metaDescription ?? null, p.extraction?.h1[0] ?? null, p.extraction?.canonical ?? null,
          p.extraction?.lang ?? null, p.extraction?.wordCount ?? null, p.extraction ? await sha256Hex(p.extraction.textSample) : null,
          JSON.stringify({
            h1: p.extraction?.h1 ?? [],
            h2: p.extraction?.h2.slice(0, 10) ?? [],
            jsonLdTypes: p.extraction?.jsonLdTypes ?? [],
            og: p.extraction?.og ?? {},
            imagesTotal: p.extraction?.images.length ?? 0,
            internalLinks: p.extraction?.links.filter((l) => l.internal).length ?? 0,
            redirects: p.redirects,
          }),
        ),
    ),
  );
  const issueStmts = issues.map((i) =>
    db
      .prepare("INSERT INTO seo_issues (id, organization_id, crawl_id, url, rule_key, severity, category, evidence_json, priority_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), orgId, crawlId, i.url, i.ruleKey, i.severity, i.category, JSON.stringify(i.evidence), issueScore(i)),
  );
  await batchChunks(db, [...pageStmts, ...issueStmts]);
  await ctx.progress(88);

  // Brand facts draft (never overwrites a profile the user already confirmed).
  // Brand colours come from the CSS (B10): read up to 2 same-site stylesheets of the home, as untrusted text.
  let css = "";
  for (const href of (pages[0]?.extraction?.stylesheets ?? []).slice(0, 2)) {
    if (safeOrigin(href) !== origin) continue;
    const r = await tryFetch(href, "text/css");
    if (r && r.status === 200 && /css|^$/.test(r.contentType)) css += `
${r.body.slice(0, 300_000)}`;
  }
  const brand = extractBrand(pages.map((p) => p.extraction).filter((e): e is NonNullable<typeof e> => !!e), { css });
  const existing = await db.prepare("SELECT id, confirmed_at FROM brand_profiles WHERE organization_id = ? AND brand_id = ?").bind(orgId, input.brandId).first<{ id: string; confirmed_at: string | null }>();
  const brandRow = await db.prepare("SELECT domain FROM brands WHERE organization_id = ? AND id = ?").bind(orgId, input.brandId).first<{ domain: string | null }>();
  const bare = (h: string) => h.replace(/^www\./, "").toLowerCase();
  // Auditing another domain (e.g. a competitor) inside an existing brand never rewrites that brand's profile.
  const otherDomain = !!brandRow?.domain && bare(brandRow.domain) !== bare(new URL(origin).hostname);
  if (otherDomain && existing) {
    await ctx.event("info", "brand_kept", "Dominio distinto al de la marca: el perfil de marca no se modifica.");
  } else if (!existing) {
    const profileId = uuid();
    await db.batch([
      db
        .prepare("INSERT INTO brand_profiles (id, organization_id, brand_id, facts_json, missing_json, warnings_json, source_crawl_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(profileId, orgId, input.brandId, JSON.stringify(brand.facts), JSON.stringify(brand.missing), JSON.stringify(brand.warnings), crawlId),
      auditStmt(db, { organizationId: orgId, actorUserId: job.actor_user_id, action: "brand.profile_created", entityType: "brand_profile", entityId: profileId, after: { brandId: input.brandId, crawlId, suggestions: brand.facts.length } }),
    ]);
  } else if (!existing.confirmed_at) {
    await db
      .prepare("UPDATE brand_profiles SET facts_json = ?, missing_json = ?, warnings_json = ?, source_crawl_id = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ?")
      .bind(JSON.stringify(brand.facts), JSON.stringify(brand.missing), JSON.stringify(brand.warnings), crawlId, nowIso(), orgId, existing.id)
      .run();
  } else {
    await ctx.event("info", "brand_kept", "El perfil de marca ya estaba confirmado: no se sobrescribe.");
  }

  // Growth plan draft
  const integrations = await db.prepare("SELECT provider FROM integrations WHERE organization_id = ? AND status = 'connected'").bind(orgId).all<{ provider: string }>();
  const connected = new Set(integrations.results.map((r) => r.provider));
  const tasks = generateGrowthPlan({
    opportunities,
    brandConfirmed: !!existing?.confirmed_at,
    integrations: { searchConsole: connected.has("google_search_console"), ga4: connected.has("ga4"), meta: connected.has("meta_ads"), cms: connected.has("wordpress") },
  });
  const planId = uuid();
  await batchChunks(db, [
    db
      .prepare("INSERT INTO growth_plans (id, organization_id, brand_id, crawl_id, title, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(planId, orgId, input.brandId, crawlId, `Plan de crecimiento 30 días · ${new URL(origin).hostname}`, job.actor_user_id),
    auditStmt(db, { organizationId: orgId, actorUserId: job.actor_user_id, action: "plan.created", entityType: "growth_plan", entityId: planId, after: { crawlId, tasks: tasks.length } }),
    ...tasks.map((t, idx) =>
      db
        .prepare(
          "INSERT INTO growth_tasks (id, organization_id, plan_id, title, description, channel, week, estimate_hours, source_rule, status, blocked_reason, requires_approval, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(uuid(), orgId, planId, t.title, t.description, t.channel, t.week, t.estimateHours, t.sourceRule, t.status, t.blockedReason, t.requiresApproval ? 1 : 0, idx),
    ),
    db
      .prepare(
        `UPDATE web_crawls SET status = 'completed', pages_count = ?, robots_found = ?, robots_txt = ?, sitemap_found = ?, sitemap_url_count = ?, llms_txt_found = ?,
         served_over_https = ?, health_score = ?, health_method = ?, opportunities_json = ?, skipped_json = ?, completed_at = ? WHERE organization_id = ? AND id = ?`,
      )
      .bind(
        pages.length, robotsFound ? 1 : 0, robotsFound ? robotsRes!.body.slice(0, 5000) : null, sitemapFound ? 1 : 0, sitemapUrls.length, llmsTxtFound ? 1 : 0,
        servedOverHttps ? 1 : 0, health.score, health.method, JSON.stringify(opportunities), JSON.stringify(skipped.slice(0, 100)), nowIso(), orgId, crawlId,
      ),
  ]);
  if (pages.length === 0 && skipped.length === 0) throw new PermanentJobError("no_pages", "No se pudo analizar ninguna página.");
  return { crawlId, planId, brandId: input.brandId, pages: pages.length, issues: issues.length, healthScore: health.score, creditsUsed: Math.max(1, pages.length) };
}

function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

async function checkOgImage(raw: string | null, base: string, fetchOpts: { resolve: JobContext["deps"]["resolve"]; fetchImpl: JobContext["deps"]["fetchImpl"]; timeoutMs: number }): Promise<OgImageCheck | null> {
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
