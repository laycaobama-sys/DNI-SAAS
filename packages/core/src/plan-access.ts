/**
 * What each plan unlocks. Single source of truth for the API guard (403 «plan_required») and for the
 * app menu (locked modules show the plan that unlocks them). Numeric limits stay in plans.limits_json.
 */
export const PLAN_ORDER = ["free", "starter", "growth", "pro", "agency"] as const;
export type PlanCode = (typeof PLAN_ORDER)[number];

export const PLAN_LABEL: Record<PlanCode, string> = { free: "Gratis", starter: "Starter", growth: "Growth", pro: "Pro", agency: "Agency" };

/** One-line promise per plan, shown on the plan page. Honest: no results guaranteed. */
export const PLAN_PITCH: Record<PlanCode, string> = {
  free: "Prueba la auditoría, el plan de 30 días, el asesor IA, Search Console y el CRM básico.",
  starter: "Para un negocio: SEO técnico, keywords, visibilidad en IA, contenidos, landings e informes.",
  growth: "Crecimiento completo: backlinks, creatividades, vídeo, automatizaciones, atribución y GA4.",
  pro: "Equipos con publicidad: Ads Manager con Spend Guardian y límites más altos.",
  agency: "Agencias: organizaciones cliente aisladas y marca blanca.",
};

/** Minimum plan per module (app path segment). Modules not listed are included in every plan. */
export const MODULE_MIN_PLAN: Record<string, PlanCode> = {
  "seo-tecnico": "starter",
  keywords: "starter",
  "ai-visibility": "starter",
  content: "starter",
  landings: "starter",
  reports: "starter",
  authority: "growth",
  creative: "growth",
  video: "growth",
  automations: "growth",
  attribution: "growth",
  analytics: "growth",
  ads: "pro",
  agency: "agency",
};

/** Fair-use AI requests per organisation per day (UTC). Keeps one tenant from draining the shared free quota. */
export const AI_DAILY_REQUESTS: Record<PlanCode, number> = { free: 10, starter: 60, growth: 150, pro: 300, agency: 600 };

export function isPlanCode(v: string): v is PlanCode {
  return (PLAN_ORDER as readonly string[]).includes(v);
}

export function planRank(code: string): number {
  return isPlanCode(code) ? PLAN_ORDER.indexOf(code) : 0;
}

export function requiredPlan(module: string): PlanCode {
  return MODULE_MIN_PLAN[module] ?? "free";
}

export function planIncludes(planCode: string, module: string): boolean {
  return planRank(planCode) >= planRank(requiredPlan(module));
}

/**
 * Whether the app menu lists a module. Customers see only what their plan includes (no locked teasers);
 * a platform admin sees everything unless «Ver como cliente» is on. Modules outside the matrix are base.
 */
export function menuShowsModule(planCode: string, module: string, adminBypass: boolean): boolean {
  return adminBypass || planIncludes(planCode, module);
}

export function aiDailyLimit(planCode: string): number {
  return AI_DAILY_REQUESTS[isPlanCode(planCode) ? planCode : "free"];
}

/** AI requests per person per organisation per day (UTC): one member cannot use the whole team's quota. */
export const AI_USER_DAILY_REQUESTS: Record<PlanCode, number> = { free: 10, starter: 40, growth: 60, pro: 100, agency: 150 };
/** Generated images per organisation per day (UTC). Images are the most expensive AI operation. */
export const AI_IMAGES_DAILY: Record<PlanCode, number> = { free: 0, starter: 0, growth: 15, pro: 30, agency: 60 };

export function aiUserDailyLimit(planCode: string): number {
  return AI_USER_DAILY_REQUESTS[isPlanCode(planCode) ? planCode : "free"];
}
export function aiImagesDailyLimit(planCode: string): number {
  return AI_IMAGES_DAILY[isPlanCode(planCode) ? planCode : "free"];
}

/** Next plan up (null on the top plan): what we suggest when a limit is reached. */
export function nextPlan(planCode: string): PlanCode | null {
  const i = planRank(planCode);
  return i < PLAN_ORDER.length - 1 ? PLAN_ORDER[i + 1]! : null;
}

/**
 * Cheapest plan whose value for a numeric limit is strictly higher than the current one, given a
 * lookup of that limit per plan. Used to say «Pasa a Growth: 150 al día» instead of a vague upsell.
 */
export function planThatRaises(planCode: string, valueOf: (p: PlanCode) => number): PlanCode | null {
  const current = valueOf(isPlanCode(planCode) ? planCode : "free");
  for (const p of PLAN_ORDER.slice(planRank(planCode) + 1)) if (valueOf(p) > current) return p;
  return null;
}

export type UsageLevel = "ok" | "warning" | "critical" | "exhausted";
/** 0–74 % ok · 75–89 % warning · 90–99 % critical · ≥100 % exhausted. A limit of 0 means «not included». */
export function usageLevel(used: number, limit: number): UsageLevel {
  if (limit <= 0) return "exhausted";
  const pct = used / limit;
  if (pct >= 1) return "exhausted";
  if (pct >= 0.9) return "critical";
  if (pct >= 0.75) return "warning";
  return "ok";
}

/** Modules a plan adds on top of the previous one (for the comparison table). */
export function modulesAddedBy(plan: PlanCode): string[] {
  return Object.entries(MODULE_MIN_PLAN)
    .filter(([, p]) => p === plan)
    .map(([m]) => m);
}

const API_MODULES: Array<[RegExp, string]> = [
  [/^\/seo\//, "seo-tecnico"],
  [/^\/keywords(\/|\.csv|$)/, "keywords"],
  [/^\/brands\/[^/]+\/geo\//, "ai-visibility"],
  [/^\/content(\/|$)/, "content"],
  [/^\/landings(\/|$)/, "landings"],
  [/^\/reports(\/|$)/, "reports"],
  [/^\/backlinks(\/|\.csv|$)/, "authority"],
  [/^\/creative\//, "creative"],
  [/^\/video\//, "video"],
  [/^\/automations\//, "automations"],
  [/^\/crm\/attribution(\/|$)/, "attribution"],
  [/^\/analytics(\/|$)/, "analytics"],
  [/^\/ads\//, "ads"],
  [/^\/agency\//, "agency"],
];

/**
 * Module guarded by an API path relative to /orgs/:orgId. Reading /branding stays open (the app
 * shell loads it for every organisation); changing it is white label, which belongs to Agency.
 * Deleting is never gated: after a downgrade the customer can still erase their data (GDPR).
 */
export function moduleForApiPath(path: string, method = "GET"): string | null {
  if (method === "DELETE") return null;
  if (path.startsWith("/branding")) return method === "GET" || method === "HEAD" ? null : "agency";
  for (const [re, m] of API_MODULES) if (re.test(path)) return m;
  return null;
}
