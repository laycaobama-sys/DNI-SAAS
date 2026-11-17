import { Hono } from "hono";
import { planToMarkdown, RULES, UpdateBrandProfileInput, UpdateTaskInput, type PlanTaskDraft } from "@dni/core";
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

insights.get("/crawls/:crawlId", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const crawlId = assertUuid(c.req.param("crawlId"), "Auditoría");
  const crawl = await c.env.DB.prepare(
    `SELECT w.*, s.origin, s.brand_id, s.verification_status FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
     WHERE w.organization_id = ? AND w.id = ?`,
  ).bind(t.orgId, crawlId).first<Record<string, unknown> & { opportunities_json: string; skipped_json: string }>();
  if (!crawl) throw notFound("Auditoría");
  const [issues, pages, plan] = await Promise.all([
    c.env.DB.prepare("SELECT id, url, rule_key, severity, category, evidence_json, priority_score, status FROM seo_issues WHERE organization_id = ? AND crawl_id = ? ORDER BY priority_score DESC, rule_key, url")
      .bind(t.orgId, crawlId)
      .all<{ rule_key: string; evidence_json: string }>(),
    c.env.DB.prepare("SELECT id, url, final_url, status_code, title, description, h1, canonical, lang, word_count, duration_ms, fetched_at FROM crawl_pages WHERE organization_id = ? AND crawl_id = ? ORDER BY fetched_at")
      .bind(t.orgId, crawlId)
      .all(),
    c.env.DB.prepare("SELECT id FROM growth_plans WHERE organization_id = ? AND crawl_id = ?").bind(t.orgId, crawlId).first<{ id: string }>(),
  ]);
  const { opportunities_json, skipped_json, robots_txt: _r, ...rest } = crawl;
  return c.json({
    crawl: { ...rest, opportunities: parseJson(opportunities_json, []), skipped: parseJson(skipped_json, []) },
    issues: issues.results.map(({ evidence_json, ...i }) => ({ ...i, evidence: parseJson(evidence_json, {}), title: RULES[i.rule_key]?.title ?? i.rule_key, fix: RULES[i.rule_key]?.fix ?? "" })),
    pages: pages.results,
    planId: plan?.id ?? null,
    methodology: {
      measurement: "observed",
      source: "Rastreo público DNI Growth (DNIGrowthBot) respetando robots.txt",
      limitations: [
        "Se analiza el HTML inicial; el contenido renderizado por JavaScript puede no estar incluido.",
        "Los tiempos de respuesta son una medición puntual desde la red de Cloudflare, no datos de usuarios reales (CrUX).",
        "Ninguna corrección garantiza posiciones en buscadores ni menciones en motores de IA.",
      ],
    },
  });
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

async function loadPlan(c: { env: AppEnv["Bindings"] }, orgId: string, planId: string) {
  const plan = await c.env.DB.prepare(
    `SELECT g.id, g.title, g.status, g.created_at, g.updated_at, g.crawl_id, g.brand_id, s.origin
     FROM growth_plans g JOIN web_crawls w ON w.organization_id = g.organization_id AND w.id = g.crawl_id
     JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id WHERE g.organization_id = ? AND g.id = ?`,
  ).bind(orgId, planId).first<{ id: string; title: string; status: string; created_at: string; origin: string }>();
  if (!plan) throw notFound("Plan");
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
    disclaimer: "Planificación editable, no una promesa de resultados ni de plazos. Las horas son estimaciones (measurement: estimated).",
  });
});

insights.patch("/plans/:planId/tasks/:taskId", requireScope("plan:write"), async (c) => {
  const t = c.get("tenant");
  const planId = assertUuid(c.req.param("planId"), "Plan");
  const taskId = assertUuid(c.req.param("taskId"), "Tarea");
  const input = await parseBody(c, UpdateTaskInput);
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
