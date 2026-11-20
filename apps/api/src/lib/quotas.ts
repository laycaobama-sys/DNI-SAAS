import { aiDailyLimit, aiImagesDailyLimit, aiUserDailyLimit, AI_DAILY_REQUESTS, AI_IMAGES_DAILY, AI_USER_DAILY_REQUESTS, isPlanCode, planThatRaises, type PlanCode } from "@dni/core";
import type { Env } from "../env";
import { orgPlan } from "./billing";
import { quotaUsage, releaseQuota, reserveQuota, type QuotaScope } from "./openrouter";

/**
 * Per-plan AI quotas, enforced on the server BEFORE any provider is called, with an atomic counter
 * per scope (see reserveQuota: conditional upsert, so 100 parallel requests never pass the limit).
 * A reservation is released when the request ends without an answer, so failures never consume quota.
 * Cache hits never reserve.
 */
export type AiQuotaKind = "org" | "user" | "images";
export const AI_LIMIT_CODE: Record<AiQuotaKind, string> = { org: "ai_plan_daily_limit", user: "ai_user_daily_limit", images: "ai_images_daily_limit" };

export class AiQuotaError extends Error {
  constructor(
    readonly kind: AiQuotaKind,
    readonly planCode: string,
    readonly limit: number,
    readonly upgradePlan: PlanCode | null,
    readonly upgradeLimit: number | null,
  ) {
    super(AI_LIMIT_CODE[kind]);
  }
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

export interface AiLimits {
  plan: string;
  orgDaily: number;
  userDaily: number;
  imagesDaily: number;
  overrides: Partial<Record<"ai_daily" | "ai_user_daily" | "ai_images_daily", number>>;
}

export async function aiLimitsFor(env: Env, orgId: string): Promise<AiLimits> {
  const [plan, { results }] = await Promise.all([
    orgPlan(env.DB, orgId),
    env.DB.prepare("SELECT limit_key, value FROM organization_limit_overrides WHERE organization_id = ? AND (expires_at IS NULL OR expires_at > ?)")
      .bind(orgId, new Date().toISOString())
      .all<{ limit_key: "ai_daily" | "ai_user_daily" | "ai_images_daily"; value: number }>(),
  ]);
  const overrides = Object.fromEntries(results.map((r) => [r.limit_key, r.value])) as AiLimits["overrides"];
  return {
    plan: plan.code,
    orgDaily: overrides.ai_daily ?? aiDailyLimit(plan.code),
    userDaily: Math.min(overrides.ai_user_daily ?? aiUserDailyLimit(plan.code), overrides.ai_daily ?? aiDailyLimit(plan.code)),
    imagesDaily: overrides.ai_images_daily ?? aiImagesDailyLimit(plan.code),
    overrides,
  };
}

const scopeKey = (kind: AiQuotaKind, orgId: string, userId: string | null) =>
  kind === "org" ? `plan:org:${orgId}` : kind === "user" ? `plan:user:${orgId}:${userId}` : `plan:img:${orgId}`;

const upgrade = (plan: string, kind: AiQuotaKind) => {
  const table = kind === "org" ? AI_DAILY_REQUESTS : kind === "user" ? AI_USER_DAILY_REQUESTS : AI_IMAGES_DAILY;
  const p = planThatRaises(plan, (x) => table[x]);
  return { plan: p, limit: p ? table[p] : null };
};

/** Reserves one AI request (text) or one image for today. Throws AiQuotaError naming the next plan. */
export async function reserveAi(env: Env, orgId: string, userId: string | null, what: "text" | "image"): Promise<QuotaScope[]> {
  const l = await aiLimitsFor(env, orgId);
  const window = utcDay();
  const wanted: Array<[AiQuotaKind, number]> = what === "image" ? [["images", l.imagesDaily]] : [["org", l.orgDaily], ...(userId ? ([["user", l.userDaily]] as Array<[AiQuotaKind, number]>) : [])];
  const scopes: QuotaScope[] = wanted.map(([kind, limit]) => ({ scope: scopeKey(kind, orgId, userId), window, limit }));
  const r = await reserveQuota(env.DB, scopes);
  if (!r.ok) {
    const idx = scopes.findIndex((s) => s.scope === r.scope);
    const [kind, limit] = wanted[idx >= 0 ? idx : 0]!;
    const up = upgrade(l.plan, kind);
    throw new AiQuotaError(kind, l.plan, limit, l.overrides[kind === "org" ? "ai_daily" : kind === "user" ? "ai_user_daily" : "ai_images_daily"] !== undefined ? null : up.plan, up.limit);
  }
  return scopes;
}

export const releaseAi = (env: Env, scopes: QuotaScope[]) => (scopes.length ? releaseQuota(env.DB, scopes) : Promise.resolve());

/** Today's AI usage for the usage page and the warnings (no provider detail). */
export async function aiUsageToday(env: Env, orgId: string, userId: string) {
  const l = await aiLimitsFor(env, orgId);
  const day = utcDay();
  const [org, user, images] = await Promise.all([
    quotaUsage(env.DB, scopeKey("org", orgId, null), day),
    quotaUsage(env.DB, scopeKey("user", orgId, userId), day),
    quotaUsage(env.DB, scopeKey("images", orgId, null), day),
  ]);
  return { limits: l, used: { org, user, images }, plan: isPlanCode(l.plan) ? l.plan : "free" };
}

/** Global AI stop decided by the platform owner (platform_settings «ai_global_halt»). */
export async function aiGlobalHalt(env: Env): Promise<{ reason: string; at: string } | null> {
  const r = await env.DB.prepare("SELECT v FROM platform_settings WHERE k = 'ai_global_halt'").first<{ v: string }>();
  if (!r) return null;
  try {
    const v = JSON.parse(r.v) as { reason: string; at: string } | null;
    return v && v.reason ? v : null;
  } catch {
    return null;
  }
}
