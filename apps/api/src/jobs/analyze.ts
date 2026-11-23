import { extractBrand, generateGrowthPlan, healthScore, issueScore, prioritize, runSeoRules, sha256Hex } from "@dni/core";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { batchChunks, nowIso, uuid } from "../lib/util";
import { PermanentJobError, type JobContext } from "./consumer";
import { crawlSite, safeOrigin } from "./crawl";

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

  const crawlId = uuid();
  const { site, skipped, robotsTxt, tryFetch } = await crawlSite(deps, input.url, pagesLimit, {
    event: ctx.event,
    progress: ctx.progress,
    checkpoint: ctx.checkpoint,
    afterValidate: async () => {
      await db
        .prepare("INSERT INTO web_crawls (id, organization_id, site_id, job_id, pages_limit) VALUES (?, ?, ?, ?, ?)")
        .bind(crawlId, orgId, input.siteId, job.id, pagesLimit)
        .run();
    },
  });
  const { origin, pages, robotsFound, sitemapFound, sitemapUrlCount, llmsTxtFound, servedOverHttps } = site;

  // Deterministic rules + prioritisation
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
        pages.length, robotsFound ? 1 : 0, robotsTxt ? robotsTxt.slice(0, 5000) : null, sitemapFound ? 1 : 0, sitemapUrlCount, llmsTxtFound ? 1 : 0,
        servedOverHttps ? 1 : 0, health.score, health.method, JSON.stringify(opportunities), JSON.stringify(skipped.slice(0, 100)), nowIso(), orgId, crawlId,
      ),
  ]);
  if (pages.length === 0 && skipped.length === 0) throw new PermanentJobError("no_pages", "No se pudo analizar ninguna página.");
  return { crawlId, planId, brandId: input.brandId, pages: pages.length, issues: issues.length, healthScore: health.score, creditsUsed: Math.max(1, pages.length) };
}
