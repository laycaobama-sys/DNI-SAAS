import { Hono } from "hono";
import {
  auditReportMarkdown,
  buildFindingDraft,
  classifyPage,
  describeEvidence,
  estimateHours,
  markdownToSafeHtml,
  organicPotential,
  planToMarkdown,
  RULES,
  UpdateBrandProfileInput,
  UpdateTaskInput,
  type Opportunity,
  type PageType,
  type PlanTaskDraft,
} from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { nowIso, parseJson } from "../lib/util";
import { requireScope } from "../middleware";

/** Audit results, brand profile and growth plans (mounted under /orgs/:orgId). */
export const insights = new Hono<AppEnv>();

insights.get("/crawls", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.status, w.pages_count, w.health_score, w.started_at, w.completed_at, w.job_id, s.origin, s.brand_id,
       (SELECT COUNT(*) FROM seo_issues i WHERE i.organization_id = w.organization_id AND i.crawl_id = w.id) AS issues_count,
       (SELECT id FROM growth_plans g WHERE g.organization_id = w.organization_id AND g.crawl_id = w.id) AS plan_id
     FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
     WHERE w.organization_id = ? ORDER BY w.started_at DESC LIMIT 50`,
  ).bind(t.orgId).all();
  return c.json({ items: results });
});

const METHODOLOGY = {
  measurement: "observed",
  source: "Rastreo público DNI Growth (DNIGrowthBot) respetando robots.txt",
  limitations: [
    "Se analiza el HTML inicial; el contenido renderizado por JavaScript puede no estar incluido.",
    "Los tiempos de respuesta son una medición puntual desde la red de Cloudflare, no datos de usuarios reales (CrUX).",
    "Ninguna corrección garantiza posiciones en buscadores ni menciones en motores de IA.",
  ],
};

type StoredOpportunity = Opportunity & { estimateHours?: number; legalOnly?: boolean; pageTypes?: Partial<Record<PageType, number>> };

/** Everything the audit page, the report export and the advisor need, from one tenant-scoped read. */
async function crawlView(db: D1Database, orgId: string, crawlId: string) {
  const crawl = await db
    .prepare(
      `SELECT w.*, s.origin, s.brand_id, s.verification_status FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
     WHERE w.organization_id = ? AND w.id = ?`,
    )
    .bind(orgId, crawlId)
    .first<Record<string, unknown> & { origin: string; opportunities_json: string; skipped_json: string }>();
  if (!crawl) throw notFound("Auditoría");
  const [issues, pages, plan] = await Promise.all([
    db.prepare("SELECT id, url, rule_key, severity, category, evidence_json, priority_score, status FROM seo_issues WHERE organization_id = ? AND crawl_id = ? ORDER BY priority_score DESC, rule_key, url")
      .bind(orgId, crawlId)
      .all<{ id: string; url: string | null; rule_key: string; severity: string; category: string; evidence_json: string; priority_score: number; status: string }>(),
    db.prepare("SELECT id, url, final_url, status_code, content_type, title, description, h1, canonical, lang, word_count, duration_ms, fetched_at, metadata_json FROM crawl_pages WHERE organization_id = ? AND crawl_id = ? ORDER BY fetched_at")
      .bind(orgId, crawlId)
      .all<{ final_url: string; status_code: number; content_type: string | null; word_count: number | null; metadata_json: string | null }>(),
    db.prepare("SELECT id FROM growth_plans WHERE organization_id = ? AND crawl_id = ?").bind(orgId, crawlId).first<{ id: string }>(),
  ]);
  const { opportunities_json, skipped_json, robots_txt: _r, ...rest } = crawl;
  // Older crawls stored non-HTML responses (llms.txt) as pages (B5): they are not pages, so they are not listed.
  const htmlPages = pages.results.filter((p) => p.status_code >= 400 || !p.content_type || /text\/html|application\/xhtml/.test(p.content_type));
  const homeUrl = htmlPages[0]?.final_url ?? null;
  const noindex = new Set(issues.results.filter((i) => i.rule_key === "noindex").map((i) => i.url));
  const potentialPages = htmlPages.map((p) => {
    const m = parseJson<{ h2?: string[]; jsonLdTypes?: string[]; internalLinks?: number }>(p.metadata_json ?? "{}", {});
    return { url: p.final_url, status: p.status_code, wordCount: p.word_count, h2: m.h2 ?? [], jsonLdTypes: m.jsonLdTypes ?? [], internalLinks: m.internalLinks ?? 0, noindex: noindex.has(p.final_url) };
  });
  const potential = organicPotential(potentialPages, { homepageUrl: homeUrl, sitemapUrlCount: Number(crawl["sitemap_url_count"] ?? 0) });
  const issuesView = issues.results.map(({ evidence_json, ...i }) => {
    const evidence = parseJson<Record<string, unknown>>(evidence_json, {});
    const pageType = (evidence["pageType"] as PageType | undefined) ?? (i.url ? classifyPage(i.url, homeUrl) : undefined);
    return { ...i, evidence, evidence_text: describeEvidence(i.rule_key, evidence), page_type: pageType ?? null, title: RULES[i.rule_key]?.title ?? i.rule_key, fix: RULES[i.rule_key]?.fix ?? "" };
  });
  // Older crawls have no page types or hour estimates: derive them now so legal pages never lead (B8).
  const opportunities = parseJson<StoredOpportunity[]>(opportunities_json, [])
    .map((o) => {
      const list = issuesView.filter((i) => i.rule_key === o.ruleKey).map((i) => ({ url: i.url, pageType: (i.page_type ?? undefined) as PageType | undefined }));
      const pageTypes = o.pageTypes ?? list.reduce<Partial<Record<PageType, number>>>((acc, i) => (i.url && i.pageType ? { ...acc, [i.pageType]: (acc[i.pageType] ?? 0) + 1 } : acc), {});
      const typed = Object.keys(pageTypes);
      return { ...o, pageTypes, legalOnly: o.legalOnly ?? (typed.length === 1 && typed[0] === "legal"), estimateHours: o.estimateHours ?? estimateHours(o.ruleKey, list) };
    })
    .sort((a, b) => Number(b.severity === "critical" && !b.legalOnly) - Number(a.severity === "critical" && !a.legalOnly) || Number(!!a.legalOnly) - Number(!!b.legalOnly));
  return {
    crawl: { ...rest, opportunities, skipped: parseJson(skipped_json, []) },
    issues: issuesView,
    pages: htmlPages.map(({ metadata_json: _m, content_type: _ct, ...p }, idx) => ({ ...p, page_type: classifyPage(p.final_url, homeUrl, potentialPages[idx]?.jsonLdTypes ?? []) })),
    potential,
    planId: plan?.id ?? null,
    methodology: METHODOLOGY,
  };
}

insights.get("/crawls/:crawlId", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  return c.json(await crawlView(c.env.DB, t.orgId, assertUuid(c.req.param("crawlId"), "Auditoría")));
});

const exportHeaders = (format: "md" | "html", filename: string) => ({
  "content-type": format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
  "content-disposition": `attachment; filename="${filename}"`,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
});
const REPORT_CSS = "body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#111}table{border-collapse:collapse;width:100%;font-size:.9em;margin:.5rem 0}th,td{border:1px solid #ccc;padding:.4rem;text-align:left;vertical-align:top}pre{background:#f4f4f4;padding:.75rem;overflow:auto}blockquote{border-left:4px solid #ccc;margin:0;padding-left:1rem;color:#444}";
const htmlDoc = (title: string, md: string) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title.replace(/[<>&"]/g, "")}</title><style>${REPORT_CSS}</style></head><body>${markdownToSafeHtml(md)}</body></html>`;

/** Audit report (Markdown or printable HTML): every plan, no AI, sources and measurement type on every figure. */
insights.get("/crawls/:crawlId/export", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const v = await crawlView(c.env.DB, t.orgId, assertUuid(c.req.param("crawlId"), "Auditoría"));
  const k = v.crawl as Record<string, unknown> & { origin: string; opportunities: StoredOpportunity[] };
  const md = auditReportMarkdown({
    origin: k.origin,
    crawlId: String(k["id"]),
    observedAt: String(k["completed_at"] ?? k["started_at"] ?? ""),
    pagesCount: Number(k["pages_count"] ?? 0),
    pagesLimit: Number(k["pages_limit"] ?? 0),
    health: { score: (k["health_score"] as number | null) ?? null, method: (k["health_method"] as string | null) ?? null },
    potential: v.potential,
    checks: { robots: !!k["robots_found"], sitemap: !!k["sitemap_found"], sitemapUrls: Number(k["sitemap_url_count"] ?? 0), https: !!k["served_over_https"], llms: !!k["llms_txt_found"] },
    opportunities: k.opportunities,
    issuesCount: v.issues.length,
    limitations: METHODOLOGY.limitations,
  });
  const format = c.req.query("format") === "html" ? "html" : "md";
  const host = new URL(k.origin).hostname;
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "audit.export", entityType: "web_crawl", entityId: String(k["id"]), after: { format }, requestId: c.get("requestId") }).run();
  return c.body(format === "html" ? htmlDoc(`Informe de auditoría · ${host}`, md) : md, 200, exportHeaders(format, `auditoria-${host}-${String(k["id"]).slice(0, 8)}.${format}`));
});

/** Brief for one finding as a file, without saving a draft: available on every plan (Content Studio is not needed). */
insights.get("/crawls/:crawlId/findings/:ruleKey/brief", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const crawlId = assertUuid(c.req.param("crawlId"), "Auditoría");
  const ruleKey = c.req.param("ruleKey");
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(ruleKey) || !RULES[ruleKey]) throw notFound("Hallazgo");
  const crawl = await db
    .prepare("SELECT w.id, w.completed_at, w.started_at, s.origin, s.brand_id FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id WHERE w.organization_id = ? AND w.id = ?")
    .bind(t.orgId, crawlId)
    .first<{ id: string; completed_at: string | null; started_at: string; origin: string; brand_id: string | null }>();
  if (!crawl) throw notFound("Auditoría");
  const { results } = await db.prepare("SELECT url, severity, evidence_json FROM seo_issues WHERE organization_id = ? AND crawl_id = ? AND rule_key = ? ORDER BY priority_score DESC, url LIMIT 200").bind(t.orgId, crawlId, ruleKey).all<{ url: string | null; severity: string; evidence_json: string }>();
  if (!results.length) throw notFound("Hallazgo");
  const brand = crawl.brand_id ? await db.prepare("SELECT name FROM brands WHERE organization_id = ? AND id = ?").bind(t.orgId, crawl.brand_id).first<{ name: string }>() : null;
  const order = ["critical", "high", "medium", "low", "info"];
  const draft = buildFindingDraft({
    ruleKey,
    severity: results.map((r) => r.severity).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0]!,
    origin: crawl.origin,
    crawlId: crawl.id,
    observedAt: crawl.completed_at ?? crawl.started_at,
    items: results.map((r) => ({ url: r.url, evidence: parseJson<Record<string, unknown>>(r.evidence_json, {}) })),
    brandName: brand?.name ?? null,
  });
  const format = c.req.query("format") === "html" ? "html" : "md";
  const md = `> BORRADOR NO APROBADO — revisar antes de publicar.\n\n${draft.bodyMd}`;
  return c.body(format === "html" ? htmlDoc(draft.title, md) : md, 200, exportHeaders(format, `brief-${ruleKey}-${crawl.id.slice(0, 8)}.${format}`));
});

insights.get("/brands/:brandId/profile", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brandId = assertUuid(c.req.param("brandId"), "Marca");
  const brand = await c.env.DB.prepare("SELECT id, name, domain FROM brands WHERE organization_id = ? AND id = ?").bind(t.orgId, brandId).first();
  if (!brand) throw notFound("Marca");
  const p = await c.env.DB.prepare(
    `SELECT p.*, u.name AS confirmed_by_name FROM brand_profiles p LEFT JOIN users u ON u.id = p.confirmed_by WHERE p.organization_id = ? AND p.brand_id = ?`,
  ).bind(t.orgId, brandId).first<Record<string, string | number | null>>();
  return c.json({
    brand,
    profile: p
      ? {
          id: p.id,
          version: p.version,
          facts: parseJson(p.facts_json as string, []),
          missing: parseJson(p.missing_json as string, []),
          warnings: parseJson(p.warnings_json as string, []),
          audience: p.audience,
          tone: p.tone,
          objective: p.objective,
          prohibitedClaims: parseJson(p.prohibited_claims_json as string, []),
          competitors: parseJson(p.competitors_json as string, []),
          sourceCrawlId: p.source_crawl_id,
          confirmedAt: p.confirmed_at,
          confirmedByName: p.confirmed_by_name,
          updatedAt: p.updated_at,
        }
      : null,
  });
});

insights.put("/brands/:brandId/profile", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const brandId = assertUuid(c.req.param("brandId"), "Marca");
  const input = await parseBody(c, UpdateBrandProfileInput);
  const existing = await c.env.DB.prepare("SELECT id, facts_json FROM brand_profiles WHERE organization_id = ? AND brand_id = ?").bind(t.orgId, brandId).first<{ id: string; facts_json: string }>();
  if (!existing) throw notFound("Perfil de marca");
  await c.env.DB.batch([
    // Editing a confirmed profile returns it to draft: it must be reconfirmed.
    c.env.DB.prepare(
      `UPDATE brand_profiles SET facts_json = ?, audience = ?, tone = ?, objective = ?, prohibited_claims_json = ?, competitors_json = ?,
         version = version + 1, confirmed_at = NULL, confirmed_by = NULL, updated_at = ? WHERE organization_id = ? AND id = ?`,
    ).bind(JSON.stringify(input.facts), input.audience, input.tone, input.objective, JSON.stringify(input.prohibitedClaims), JSON.stringify(input.competitors), nowIso(), t.orgId, existing.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "brand_profile.update", entityType: "brand_profile", entityId: existing.id, after: { facts: input.facts.length, objective: input.objective }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

insights.post("/brands/:brandId/profile/confirm", requireScope("brand:confirm"), async (c) => {
  const t = c.get("tenant");
  const brandId = assertUuid(c.req.param("brandId"), "Marca");
  const p = await c.env.DB.prepare("SELECT id, audience, objective, facts_json FROM brand_profiles WHERE organization_id = ? AND brand_id = ?").bind(t.orgId, brandId).first<{ id: string; audience: string; objective: string; facts_json: string }>();
  if (!p) throw notFound("Perfil de marca");
  const facts = parseJson<Array<{ key: string; status: string }>>(p.facts_json, []);
  const missing: string[] = [];
  if (!facts.some((f) => f.key === "name" && f.status !== "rejected")) missing.push("nombre de marca");
  if (!p.audience.trim()) missing.push("público objetivo");
  if (!p.objective) missing.push("objetivo comercial");
  if (missing.length) throw new ApiError(422, "profile_incomplete", `Completa antes de confirmar: ${missing.join(", ")}.`, { missing });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE brand_profiles SET confirmed_at = ?, confirmed_by = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.userId, t.orgId, p.id),
    c.env.DB.prepare(
      "UPDATE growth_tasks SET status = 'done', updated_at = ? WHERE organization_id = ? AND channel = 'brand' AND status IN ('todo','doing') AND plan_id IN (SELECT id FROM growth_plans WHERE organization_id = ? AND brand_id = ?)",
    ).bind(nowIso(), t.orgId, t.orgId, brandId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "brand_profile.confirm", entityType: "brand_profile", entityId: p.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

/**
 * Plans created before the modules shipped stored internal phase codes as block reasons ("fase F3").
 * Search Console, GA4 and Content Studio are available now, so those tasks become actionable; the paid task
 * keeps waiting for Meta, with a customer-facing reason. Idempotent: matches only the legacy wording.
 */
export async function healLegacyPhaseBlocks(db: D1Database, orgId: string, planId: string) {
  const now = nowIso();
  await db.batch([
    db.prepare("UPDATE growth_tasks SET status = 'todo', blocked_reason = NULL, updated_at = ? WHERE organization_id = ? AND plan_id = ? AND status = 'blocked' AND channel IN ('measurement', 'content') AND blocked_reason LIKE '%fase F%'").bind(now, orgId, planId),
    db.prepare("UPDATE growth_tasks SET blocked_reason = ?, updated_at = ? WHERE organization_id = ? AND plan_id = ? AND status = 'blocked' AND channel = 'paid' AND blocked_reason LIKE '%fase F%'").bind("Pendiente de conectar Meta Ads. Puedes preparar el borrador sin gasto en Ads Manager; publicarlo exige la conexión y tu aprobación.", now, orgId, planId),
  ]);
}

async function loadPlan(c: { env: AppEnv["Bindings"] }, orgId: string, planId: string) {
  const plan = await c.env.DB.prepare(
    `SELECT g.id, g.title, g.status, g.created_at, g.updated_at, g.crawl_id, g.brand_id, s.origin
     FROM growth_plans g JOIN web_crawls w ON w.organization_id = g.organization_id AND w.id = g.crawl_id
     JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id WHERE g.organization_id = ? AND g.id = ?`,
  ).bind(orgId, planId).first<{ id: string; title: string; status: string; created_at: string; origin: string }>();
  if (!plan) throw notFound("Plan");
  await healLegacyPhaseBlocks(c.env.DB, orgId, planId);
  const { results: tasks } = await c.env.DB.prepare(
    "SELECT id, title, description, channel, week, estimate_hours, source_rule, status, blocked_reason, requires_approval, position, updated_at FROM growth_tasks WHERE organization_id = ? AND plan_id = ? ORDER BY week, position",
  ).bind(orgId, planId).all<{ id: string; title: string; description: string; channel: string; week: number; estimate_hours: number; source_rule: string | null; status: string; blocked_reason: string | null; requires_approval: number }>();
  return { plan, tasks };
}

insights.get("/plans/:planId", requireScope("plan:read"), async (c) => {
  const t = c.get("tenant");
  const { plan, tasks } = await loadPlan(c, t.orgId, assertUuid(c.req.param("planId"), "Plan"));
  return c.json({
    plan,
    tasks: tasks.map((x) => ({ ...x, requires_approval: !!x.requires_approval })),
    disclaimer: "Planificación editable, no una promesa de resultados ni de plazos. Las horas son estimaciones orientativas.",
  });
});

insights.patch("/plans/:planId/tasks/:taskId", requireScope("plan:write"), async (c) => {
  const t = c.get("tenant");
  const planId = assertUuid(c.req.param("planId"), "Plan");
  const taskId = assertUuid(c.req.param("taskId"), "Tarea");
  const input = await parseBody(c, UpdateTaskInput);
  await healLegacyPhaseBlocks(c.env.DB, t.orgId, planId);
  const task = await c.env.DB.prepare("SELECT status FROM growth_tasks WHERE organization_id = ? AND plan_id = ? AND id = ?").bind(t.orgId, planId, taskId).first<{ status: string }>();
  if (!task) throw notFound("Tarea");
  if (task.status === "blocked" && input.status && input.status !== "dismissed") throw new ApiError(409, "task_blocked", "Esta tarea depende de un módulo o integración no disponible.");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE growth_tasks SET status = COALESCE(?, status), title = COALESCE(?, title), description = COALESCE(?, description), week = COALESCE(?, week),
       estimate_hours = COALESCE(?, estimate_hours), updated_at = ? WHERE organization_id = ? AND plan_id = ? AND id = ?`,
    ).bind(input.status ?? null, input.title ?? null, input.description ?? null, input.week ?? null, input.estimateHours ?? null, nowIso(), t.orgId, planId, taskId),
    c.env.DB.prepare("UPDATE growth_plans SET updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, planId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "plan_task.update", entityType: "growth_task", entityId: taskId, before: { status: task.status }, after: input, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

insights.get("/plans/:planId/export", requireScope("plan:read"), async (c) => {
  const t = c.get("tenant");
  const { plan, tasks } = await loadPlan(c, t.orgId, assertUuid(c.req.param("planId"), "Plan"));
  const format = c.req.query("format") === "json" ? "json" : "md";
  const filename = `plan-${plan.id.slice(0, 8)}.${format}`;
  c.header("content-disposition", `attachment; filename="${filename}"`);
  if (format === "json") {
    return c.json({ plan, tasks, measurement: "estimated", exportedAt: nowIso(), disclaimer: "Planificación editable; no garantiza resultados." });
  }
  const drafts = tasks.map((x) => ({
    title: x.title,
    description: x.description,
    channel: x.channel as PlanTaskDraft["channel"],
    week: x.week as PlanTaskDraft["week"],
    estimateHours: x.estimate_hours,
    sourceRule: x.source_rule,
    status: x.status as PlanTaskDraft["status"],
    blockedReason: x.blocked_reason,
    requiresApproval: !!x.requires_approval,
  }));
  return c.body(planToMarkdown({ title: plan.title, createdAt: plan.created_at, origin: plan.origin }, drafts), 200, { "content-type": "text/markdown; charset=utf-8" });
});
