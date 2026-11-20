import { Hono } from "hono";
import { isPlanCode, PLAN_LABEL, PLAN_ORDER, planIncludes, planThatRaises, usageLevel, AI_DAILY_REQUESTS, AI_IMAGES_DAILY, AI_USER_DAILY_REQUESTS, type PlanCode, type PlanDef } from "@dni/core";
import type { AppEnv } from "../env";
import { analysesThisMonth, creditBalance, ensureMonthlyGrant, getPlan, orgPlan } from "../lib/billing";
import { aiUsageToday } from "../lib/quotas";
import { monthStartIso, nowIso } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * «Uso y límites» of the CURRENT organisation and person: every quota of the plan, how much is used,
 * a level (ok / warning ≥75 % / critical ≥90 % / exhausted) and the cheapest plan that raises it.
 * Feeds the usage page, the warning banner and every «pasa a…» call to action. No AI internals.
 */
export const usage = new Hono<AppEnv>();

const nextUtcMidnight = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
};
const nextMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

usage.get("/usage", requireScope("org:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const plan = await orgPlan(db, t.orgId);
  await ensureMonthlyGrant(db, t.orgId, plan);
  const code: PlanCode = isPlanCode(plan.code) ? plan.code : "free";
  const plans = Object.fromEntries(await Promise.all(PLAN_ORDER.map(async (p) => [p, await getPlan(db, p)] as const))) as Record<PlanCode, PlanDef>;
  const count = async (sql: string) => (await db.prepare(sql).bind(t.orgId).first<{ n: number }>())?.n ?? 0;
  const [ai, balance, spentMonth, audits, brands, seats, prompts, forms, landings, rules, videos] = await Promise.all([
    aiUsageToday(c.env, t.orgId, t.userId),
    creditBalance(db, t.orgId),
    db.prepare("SELECT COALESCE(-SUM(amount), 0) AS n FROM credit_ledger WHERE organization_id = ? AND entry_kind = 'settle' AND created_at >= ?").bind(t.orgId, monthStartIso()).first<{ n: number }>(),
    analysesThisMonth(db, t.orgId),
    count("SELECT COUNT(*) AS n FROM brands WHERE organization_id = ?"),
    count("SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ? AND status = 'active'"),
    count("SELECT COUNT(*) AS n FROM tracked_prompts WHERE organization_id = ? AND archived_at IS NULL"),
    count("SELECT COUNT(*) AS n FROM lead_forms WHERE organization_id = ? AND status != 'archived'"),
    count("SELECT COUNT(*) AS n FROM landing_pages WHERE organization_id = ? AND status != 'archived'"),
    count("SELECT COUNT(*) AS n FROM automation_rules WHERE organization_id = ?"),
    count("SELECT COUNT(*) AS n FROM video_projects WHERE organization_id = ? AND status != 'archived'"),
  ]);
  const L = (p: PlanCode) => plans[p].limits as unknown as Record<string, number | undefined>;
  const fromPlan = (key: string) => (p: PlanCode) => Number(L(p)[key] ?? 0);
  type Item = { key: string; label: string; used: number; limit: number; unit: string; period: "day" | "month" | "total"; resetsAt: string | null; module?: string; raise: (p: PlanCode) => number; overridden?: boolean };
  const items: Item[] = [
    { key: "ai_org_day", label: "Consultas de IA del equipo hoy", used: ai.used.org, limit: ai.limits.orgDaily, unit: "consultas", period: "day", resetsAt: nextUtcMidnight(), raise: (p) => AI_DAILY_REQUESTS[p], overridden: ai.limits.overrides.ai_daily !== undefined },
    { key: "ai_user_day", label: "Tus consultas de IA hoy", used: ai.used.user, limit: ai.limits.userDaily, unit: "consultas", period: "day", resetsAt: nextUtcMidnight(), raise: (p) => AI_USER_DAILY_REQUESTS[p], overridden: ai.limits.overrides.ai_user_daily !== undefined },
    { key: "ai_images_day", label: "Imágenes generadas hoy", used: ai.used.images, limit: ai.limits.imagesDaily, unit: "imágenes", period: "day", resetsAt: nextUtcMidnight(), module: "creative", raise: (p) => AI_IMAGES_DAILY[p], overridden: ai.limits.overrides.ai_images_daily !== undefined },
    { key: "credits_month", label: "Créditos de IA usados este mes", used: Math.max(0, spentMonth?.n ?? 0), limit: Math.max(plan.limits.monthlyCredits, 0), unit: "créditos", period: "month", resetsAt: nextMonth(), raise: fromPlan("monthlyCredits") },
    { key: "audits_month", label: "Auditorías web este mes", used: audits, limit: plan.limits.analysesPerMonth, unit: "auditorías", period: "month", resetsAt: nextMonth(), raise: fromPlan("analysesPerMonth") },
    { key: "brands", label: "Marcas", used: brands, limit: plan.limits.brands, unit: "marcas", period: "total", resetsAt: null, raise: fromPlan("brands") },
    { key: "seats", label: "Personas del equipo", used: seats, limit: plan.limits.seats, unit: "personas", period: "total", resetsAt: null, raise: fromPlan("seats") },
    { key: "tracked_prompts", label: "Preguntas de visibilidad en IA", used: prompts, limit: Number(plan.limits.trackedPrompts ?? 0), unit: "preguntas", period: "total", resetsAt: null, module: "ai-visibility", raise: fromPlan("trackedPrompts") },
    { key: "lead_forms", label: "Formularios de captación", used: forms, limit: Number(plan.limits.leadForms ?? 1), unit: "formularios", period: "total", resetsAt: null, raise: fromPlan("leadForms") },
    { key: "landing_pages", label: "Landing pages", used: landings, limit: Number(plan.limits.landingPages ?? 1), unit: "landings", period: "total", resetsAt: null, module: "landings", raise: fromPlan("landingPages") },
    { key: "automation_rules", label: "Reglas de automatización", used: rules, limit: Number(plan.limits.automationRules ?? 0), unit: "reglas", period: "total", resetsAt: null, module: "automations", raise: fromPlan("automationRules") },
    { key: "video_projects", label: "Proyectos de vídeo", used: videos, limit: Number(plan.limits.videoProjects ?? 0), unit: "proyectos", period: "total", resetsAt: null, module: "video", raise: fromPlan("videoProjects") },
  ];
  const out = items
    // Only what this plan includes: no meters for modules the customer does not have.
    .filter((i) => !i.module || planIncludes(code, i.module))
    .map(({ raise, module: _m, ...i }) => {
      const up = i.overridden ? null : planThatRaises(code, raise);
      return {
        ...i,
        pct: i.limit > 0 ? Math.min(100, Math.round((i.used / i.limit) * 100)) : 100,
        level: usageLevel(i.used, i.limit),
        upgrade: up ? { plan: up, label: PLAN_LABEL[up], limit: raise(up), priceEurMonth: plans[up].priceEurMonth } : null,
      };
    });
  return c.json({
    plan: { code, label: PLAN_LABEL[code], priceEurMonth: plan.priceEurMonth },
    creditsBalance: balance,
    items: out,
    // A one-unit allowance that is simply in use (the owner's own seat, the one brand of Free) is not
    // news: it would warn every day. Those raise a clear upgrade message when someone tries to add more.
    alerts: out.filter((i) => i.level !== "ok" && !(i.period === "total" && i.limit <= 1 && i.used <= i.limit)),
    observedAt: nowIso(),
    measurement: "observed",
    source: "Contadores de uso de DNI Growth (por organización y persona, días en UTC)",
  });
});
