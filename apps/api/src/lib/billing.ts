import type { PlanDef } from "@dni/core";
import { ApiError } from "./http";
import { monthKey, monthStartIso, parseJson, uuid } from "./util";

export async function getPlan(db: D1Database, code: string): Promise<PlanDef> {
  const row = await db.prepare("SELECT code, name, price_eur_month, limits_json FROM plans WHERE code = ?").bind(code).first<{
    code: string;
    name: string;
    price_eur_month: number | null;
    limits_json: string;
  }>();
  if (!row) throw new ApiError(500, "plan_missing", "Plan no configurado.");
  return { code: row.code, name: row.name, priceEurMonth: row.price_eur_month, limits: parseJson(row.limits_json, {} as PlanDef["limits"]) };
}

export async function orgPlan(db: D1Database, orgId: string): Promise<PlanDef> {
  const row = await db.prepare("SELECT plan_code FROM organizations WHERE id = ?").bind(orgId).first<{ plan_code: string }>();
  return getPlan(db, row?.plan_code ?? "free");
}

export function grantStmt(db: D1Database, orgId: string, amount: number, sourceEventId: string, category = "monthly_allowance", provider = "internal") {
  return db
    .prepare("INSERT OR IGNORE INTO credit_ledger (id, organization_id, category, amount, entry_kind, provider, source_event_id) VALUES (?, ?, ?, ?, 'grant', ?, ?)")
    .bind(uuid(), orgId, category, amount, provider, sourceEventId);
}

/** Idempotent monthly allowance (one grant per org per calendar month). */
export async function ensureMonthlyGrant(db: D1Database, orgId: string, plan: PlanDef) {
  await grantStmt(db, orgId, plan.limits.monthlyCredits, `grant:${orgId}:${monthKey()}:${plan.code}`).run();
}

export async function creditBalance(db: D1Database, orgId: string): Promise<number> {
  const r = await db.prepare("SELECT COALESCE(SUM(amount), 0) AS b FROM credit_ledger WHERE organization_id = ?").bind(orgId).first<{ b: number }>();
  return r?.b ?? 0;
}

export function ledgerStmt(
  db: D1Database,
  e: { orgId: string; jobId: string; kind: "reserve" | "settle" | "release"; amount: number; category: string },
) {
  return db
    .prepare("INSERT OR IGNORE INTO credit_ledger (id, organization_id, job_id, category, amount, entry_kind, source_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), e.orgId, e.jobId, e.category, e.amount, e.kind, `job:${e.jobId}:${e.kind}`);
}

export async function analysesThisMonth(db: D1Database, orgId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND kind = 'site_analysis' AND created_at >= ?")
    .bind(orgId, monthStartIso())
    .first<{ n: number }>();
  return r?.n ?? 0;
}
