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
  // A client organisation managed by an agency (agency_org_id) uses the agency's plan limits
  // unless it has its own paid plan. Client orgs cannot create further clients (see agency routes).
  const row = await db
    .prepare("SELECT o.plan_code, a.plan_code AS agency_plan FROM organizations o LEFT JOIN organizations a ON a.id = o.agency_org_id WHERE o.id = ?")
    .bind(orgId)
    .first<{ plan_code: string; agency_plan: string | null }>();
  const own = row?.plan_code ?? "free";
  return getPlan(db, own === "free" && row?.agency_plan ? row.agency_plan : own);
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

/**
 * Atomic credit reservation for synchronous usage (AI requests): a single INSERT…SELECT that only
 * writes when the balance covers the amount, so concurrent requests cannot overspend.
 * Lifecycle: reserve → (settle + release) on success, or release on failure. Idempotent by refId.
 */
export async function reserveCredits(db: D1Database, e: { orgId: string; refId: string; amount: number; category: string }): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO credit_ledger (id, organization_id, category, amount, entry_kind, source_event_id)
       SELECT ?, ?, ?, ?, 'reserve', ?
       WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE organization_id = ?) >= ?`,
    )
    .bind(uuid(), e.orgId, e.category, -Math.abs(e.amount), `usage:${e.refId}:reserve`, e.orgId, Math.abs(e.amount))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export function usageLedgerStmt(db: D1Database, e: { orgId: string; refId: string; kind: "settle" | "release"; amount: number; category: string; provider?: string }) {
  return db
    .prepare("INSERT OR IGNORE INTO credit_ledger (id, organization_id, category, amount, entry_kind, provider, source_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), e.orgId, e.category, e.kind === "settle" ? -Math.abs(e.amount) : Math.abs(e.amount), e.kind, e.provider ?? "internal", `usage:${e.refId}:${e.kind}`);
}
