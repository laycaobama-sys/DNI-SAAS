import { Hono, type Context } from "hono";
import { z } from "zod";
import { maskEmail, PLAN_LABEL, isPlanCode } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { creditBalance, ledgerStmt, orgPlan } from "../lib/billing";
import { ApiError, notFound, parseBody } from "../lib/http";
import { aiGlobalHalt, aiUsageToday, utcDay } from "../lib/quotas";
import { rateLimit } from "../lib/ratelimit";
import { getSetting, setSetting } from "../lib/stripe";
import { nowIso, uuid } from "../lib/util";
import { requirePlatform, requirePlatformAdmin, requireStepUp, requireUser } from "../middleware";
import { ORG_RESTORE_DAYS } from "./orgs";

/**
 * DNI Growth Platform Control Center (owner only). Mounted under /api/v1/admin next to the legacy
 * admin routes. Every route: platform role with the right scope (404 for everyone else), every write:
 * TOTP step-up within 15 minutes + audit row. Customer content is never returned: counts, statuses
 * and masked e-mails only. Nothing here charges money or calls a paid service.
 */
export const control = new Hono<AppEnv>();
control.use("*", requireUser, requirePlatformAdmin);

const OrgId = z.string().uuid();
const Reason = z.string().trim().min(3).max(300);

async function loadOrg(db: D1Database, id: string) {
  if (!OrgId.safeParse(id).success) throw notFound("Organización");
  const o = await db
    .prepare("SELECT id, name, slug, plan_code, status, status_reason, status_changed_at, deleted_at, purge_after, created_at, agency_org_id FROM organizations WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; slug: string; plan_code: string; status: string; status_reason: string | null; status_changed_at: string | null; deleted_at: string | null; purge_after: string | null; created_at: string; agency_org_id: string | null }>();
  if (!o) throw notFound("Organización");
  return o;
}

const audit = (c: Context<AppEnv>, orgId: string | null, action: string, after?: unknown, before?: unknown) =>
  auditStmt(c.env.DB, { organizationId: orgId, actorUserId: c.get("user")!.id, action, entityType: "organization", entityId: orgId ?? undefined, before, after, requestId: c.get("requestId") });

// ── Organisation detail ────────────────────────────────────────────────────────────────────────────
control.get("/organizations/:id", requirePlatform("platform:orgs:read"), async (c) => {
  const db = c.env.DB;
  const o = await loadOrg(db, c.req.param("id"));
  const cnt = (sql: string) => db.prepare(sql).bind(o.id).first<{ n: number }>().then((r) => r?.n ?? 0);
  const [members, plan, balance, overrides, grants, sub, brands, leads, jobs, ai7, last] = await Promise.all([
    db
      .prepare(
        `SELECT m.user_id, m.role, m.status, m.created_at, u.email, u.name, (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at`,
      )
      .bind(o.id)
      .all<{ user_id: string; role: string; status: string; created_at: string; email: string; name: string | null; last_seen: string | null }>(),
    orgPlan(db, o.id),
    creditBalance(db, o.id),
    db.prepare("SELECT limit_key, value, reason, expires_at, updated_at FROM organization_limit_overrides WHERE organization_id = ?").bind(o.id).all(),
    db
      .prepare(
        `SELECT g.id, g.reason, g.ticket, g.expires_at, g.revoked_at, g.created_at, u.email FROM support_access_grants g JOIN users u ON u.id = g.user_id
         WHERE g.organization_id = ? ORDER BY g.created_at DESC LIMIT 20`,
      )
      .bind(o.id)
      .all<{ id: string; reason: string; ticket: string | null; expires_at: string; revoked_at: string | null; created_at: string; email: string }>(),
    db.prepare("SELECT provider, status, plan_code, cancel_at_period_end, current_period_end FROM subscriptions WHERE organization_id = ?").bind(o.id).first(),
    cnt("SELECT COUNT(*) AS n FROM brands WHERE organization_id = ?"),
    cnt("SELECT COUNT(*) AS n FROM leads WHERE organization_id = ?"),
    db.prepare("SELECT state, COUNT(*) AS n FROM jobs WHERE organization_id = ? GROUP BY state").bind(o.id).all<{ state: string; n: number }>(),
    db
      .prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n, SUM(status = 'failed') AS failed FROM ai_invocations WHERE organization_id = ? AND created_at >= ? GROUP BY day ORDER BY day")
      .bind(o.id, new Date(Date.now() - 7 * 86400_000).toISOString())
      .all<{ day: string; n: number; failed: number }>(),
    db.prepare("SELECT action, created_at FROM audit_logs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 15").bind(o.id).all<{ action: string; created_at: string }>(),
  ]);
  const owner = members.results.find((m) => m.role === "owner");
  const usage = owner ? await aiUsageToday(c.env, o.id, owner.user_id) : null;
  return c.json({
    organization: o,
    plan: { code: plan.code, label: PLAN_LABEL[isPlanCode(plan.code) ? plan.code : "free"], limits: plan.limits },
    subscription: sub ?? null,
    creditsBalance: balance,
    members: members.results.map((m) => ({ userId: m.user_id, role: m.role, status: m.status, email: maskEmail(m.email), since: m.created_at, lastSeen: m.last_seen })),
    counts: { brands, leads, jobs: jobs.results },
    aiToday: usage ? { org: usage.used.org, orgLimit: usage.limits.orgDaily, images: usage.used.images, imagesLimit: usage.limits.imagesDaily, userLimit: usage.limits.userDaily } : null,
    ai7d: ai7.results,
    overrides: overrides.results,
    supportGrants: grants.results.map((g) => ({ ...g, email: maskEmail(g.email), active: !g.revoked_at && g.expires_at > nowIso() })),
    recentActions: last.results,
    observedAt: nowIso(),
    measurement: "observed",
  });
});

// ── Lifecycle: rename, suspend / reactivate, delete / restore (all reversible) ───────────────────────
control.post("/organizations/:id/rename", requirePlatform("platform:orgs:manage"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const { name, reason } = await parseBody(c, z.strictObject({ name: z.string().trim().min(2).max(120), reason: Reason }));
  await c.env.DB.batch([c.env.DB.prepare("UPDATE organizations SET name = ? WHERE id = ?").bind(name, o.id), audit(c, o.id, "platform.org_rename", { name, reason }, { name: o.name })]);
  return c.json({ ok: true, name });
});

control.post("/organizations/:id/status", requirePlatform("platform:orgs:manage"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const { status, reason } = await parseBody(c, z.strictObject({ status: z.enum(["active", "suspended"]), reason: Reason }));
  if (o.deleted_at) throw new ApiError(409, "organization_deleted", "La organización está eliminada: restáurala primero.");
  if (o.status === status) return c.json({ ok: true, status, changed: false });
  const now = nowIso();
  const stmts = [
    c.env.DB.prepare("UPDATE organizations SET status = ?, status_reason = ?, status_changed_at = ? WHERE id = ?").bind(status, status === "suspended" ? reason : null, now, o.id),
    audit(c, o.id, status === "suspended" ? "platform.org_suspend" : "platform.org_reactivate", { status, reason }, { status: o.status }),
  ];
  if (status === "suspended")
    stmts.push(c.env.DB.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE organization_id = ? AND state IN ('queued','validating','running') AND cancel_requested_at IS NULL").bind(now, o.id));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, status, changed: true });
});

control.post("/organizations/:id/delete", requirePlatform("platform:orgs:manage"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const { confirmName, reason } = await parseBody(c, z.strictObject({ confirmName: z.string().trim().min(1).max(120), reason: Reason }));
  if (o.name.trim() !== confirmName) throw new ApiError(400, "confirm_name_mismatch", "Escribe el nombre exacto de la organización para confirmar.");
  if (o.deleted_at) return c.json({ ok: true, changed: false, purgeAfter: o.purge_after });
  const live = await c.env.DB.prepare("SELECT 1 AS x FROM subscriptions WHERE organization_id = ? AND provider = 'stripe' AND status IN ('active','trialing','past_due') LIMIT 1").bind(o.id).first();
  if (live) throw new ApiError(409, "subscription_active", "Tiene una suscripción de pago activa: cancélala antes en Stripe.");
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + ORG_RESTORE_DAYS * 86400_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organizations SET deleted_at = ?, purge_after = ?, status_changed_at = ? WHERE id = ? AND deleted_at IS NULL").bind(now.toISOString(), purgeAfter, now.toISOString(), o.id),
    c.env.DB.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE organization_id = ? AND state IN ('queued','validating','running') AND cancel_requested_at IS NULL").bind(now.toISOString(), o.id),
    audit(c, o.id, "platform.org_delete", { purgeAfter, reason, by: "platform" }),
  ]);
  return c.json({ ok: true, changed: true, purgeAfter });
});

control.post("/organizations/:id/restore", requirePlatform("platform:orgs:manage"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const now = nowIso();
  const r = await c.env.DB.prepare("UPDATE organizations SET deleted_at = NULL, purge_after = NULL, status_changed_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_after > ? RETURNING id")
    .bind(now, o.id, now)
    .first();
  if (!r) throw new ApiError(409, "not_restorable", "Esta organización no está eliminada o ya no se puede restaurar.");
  await audit(c, o.id, "platform.org_restore", { restoredAt: now }).run();
  return c.json({ ok: true });
});

// ── Per-organisation AI limits (override the plan; null = back to the plan) ─────────────────────────
const LimitValue = z.number().int().min(0).max(100_000).nullable().optional();
control.put("/organizations/:id/limits", requirePlatform("platform:ai:control"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const body = await parseBody(
    c,
    z.strictObject({ ai_daily: LimitValue, ai_user_daily: LimitValue, ai_images_daily: LimitValue, reason: Reason, expiresAt: z.string().datetime().nullable().optional() }),
  );
  const user = c.get("user")!;
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const key of ["ai_daily", "ai_user_daily", "ai_images_daily"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    stmts.push(
      v === null
        ? c.env.DB.prepare("DELETE FROM organization_limit_overrides WHERE organization_id = ? AND limit_key = ?").bind(o.id, key)
        : c.env.DB.prepare(
            `INSERT INTO organization_limit_overrides (organization_id, limit_key, value, reason, expires_at, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (organization_id, limit_key) DO UPDATE SET value = excluded.value, reason = excluded.reason, expires_at = excluded.expires_at, set_by = excluded.set_by, updated_at = excluded.updated_at`,
          ).bind(o.id, key, v, body.reason, body.expiresAt ?? null, user.id, now),
    );
  }
  if (!stmts.length) throw new ApiError(400, "nothing_to_change", "Indica al menos un límite.");
  stmts.push(audit(c, o.id, "platform.limits_set", { ai_daily: body.ai_daily, ai_user_daily: body.ai_user_daily, ai_images_daily: body.ai_images_daily, expiresAt: body.expiresAt ?? null, reason: body.reason }));
  await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// ── Credit adjustment (internal credits, never money). Idempotent per key; balance never below 0 ──────
control.post("/organizations/:id/credits", requirePlatform("platform:billing:manage"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const { amount, reason, idempotencyKey } = await parseBody(
    c,
    z.strictObject({ amount: z.number().int().min(-10_000).max(10_000).refine((n) => n !== 0, "No puede ser 0"), reason: Reason, idempotencyKey: z.string().trim().min(8).max(80) }),
  );
  await rateLimit(c.env.DB, `platform-credits:${c.get("user")!.id}`, 30, 3600);
  const sourceId = `platform-adj:${o.id}:${idempotencyKey}`;
  const r = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO credit_ledger (id, organization_id, category, amount, entry_kind, provider, source_event_id)
     SELECT ?, ?, 'platform_adjustment', ?, 'adjustment', 'internal', ?
     WHERE (SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE organization_id = ?) + ? >= 0`,
  )
    .bind(uuid(), o.id, amount, sourceId, o.id, amount)
    .run();
  if (!r.meta.changes) {
    const dup = await c.env.DB.prepare("SELECT 1 AS x FROM credit_ledger WHERE organization_id = ? AND source_event_id = ?").bind(o.id, sourceId).first();
    if (dup) return c.json({ ok: true, duplicate: true, balance: await creditBalance(c.env.DB, o.id) });
    throw new ApiError(409, "balance_negative", "El saldo no puede quedar en negativo.");
  }
  await audit(c, o.id, "platform.credits_adjust", { amount, reason, charge: "none" }).run();
  return c.json({ ok: true, balance: await creditBalance(c.env.DB, o.id) });
});

// ── Temporary, read-only, audited support access ────────────────────────────────────────────────────
control.post("/organizations/:id/support", requirePlatform("platform:support"), requireStepUp, async (c) => {
  const o = await loadOrg(c.env.DB, c.req.param("id"));
  const { reason, ticket, hours } = await parseBody(c, z.strictObject({ reason: Reason, ticket: z.string().trim().max(80).optional(), hours: z.number().int().min(1).max(24).default(2) }));
  const user = c.get("user")!;
  const id = uuid();
  const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE support_access_grants SET revoked_at = ? WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL").bind(nowIso(), o.id, user.id),
    c.env.DB.prepare("INSERT INTO support_access_grants (id, organization_id, user_id, reason, ticket, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, o.id, user.id, reason, ticket ?? null, expiresAt, nowIso()),
    audit(c, o.id, "platform.support_access_start", { grantId: id, reason, ticket: ticket ?? null, expiresAt, mode: "read_only" }),
  ]);
  return c.json({ ok: true, grantId: id, expiresAt });
});

control.delete("/support/:grantId", requirePlatform("platform:support"), async (c) => {
  const g = await c.env.DB.prepare("UPDATE support_access_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING organization_id")
    .bind(nowIso(), c.req.param("grantId"))
    .first<{ organization_id: string }>();
  if (!g) return c.json({ ok: true, changed: false });
  await audit(c, g.organization_id, "platform.support_access_end", { grantId: c.req.param("grantId") }).run();
  return c.json({ ok: true, changed: true });
});

// ── AI centre: usage by plan / organisation, global kill switch ─────────────────────────────────────
control.get("/ai/usage", requirePlatform("platform:ai:read"), async (c) => {
  const db = c.env.DB;
  const day = utcDay();
  const d7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [halt, byOrg, byProvider, byDay, byPlan] = await Promise.all([
    aiGlobalHalt(c.env),
    db
      .prepare(
        `SELECT o.id, o.name, o.plan_code, q.count AS today FROM ai_quota_counters q JOIN organizations o ON q.scope = 'plan:org:' || o.id
         WHERE q.window_key = ? ORDER BY q.count DESC LIMIT 50`,
      )
      .bind(day)
      .all<{ id: string; name: string; plan_code: string; today: number }>(),
    db
      .prepare("SELECT provider, status, COUNT(*) AS n, ROUND(SUM(estimated_cost_usd), 4) AS est_usd, ROUND(AVG(latency_ms)) AS avg_ms FROM ai_invocations WHERE created_at >= ? GROUP BY provider, status")
      .bind(d7)
      .all(),
    db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n, SUM(status = 'failed') AS failed FROM ai_invocations WHERE created_at >= ? GROUP BY day ORDER BY day").bind(d7).all(),
    db
      .prepare(
        `SELECT o.plan_code, COUNT(*) AS n FROM ai_invocations i JOIN organizations o ON o.id = i.organization_id
         WHERE i.created_at >= ? AND i.status = 'ok' GROUP BY o.plan_code`,
      )
      .bind(d7)
      .all(),
  ]);
  return c.json({
    halt,
    today: byOrg.results.map((r) => ({ ...r, limit: null })),
    providers7d: byProvider.results,
    days7d: byDay.results,
    plans7d: byPlan.results,
    observedAt: nowIso(),
    measurement: "observed",
    source: "ai_quota_counters (hoy, UTC) y ai_invocations (7 días)",
    caveats: ["El coste es estimado por proveedor; solo se usan niveles gratuitos.", "Una consulta puede tener varios intentos si un proveedor falla."],
  });
});

control.post("/ai/halt", requirePlatform("platform:ai:control"), requireStepUp, async (c) => {
  const { halted, reason } = await parseBody(c, z.strictObject({ halted: z.boolean(), reason: Reason }));
  const before = await getSetting(c.env.DB, "ai_global_halt");
  await setSetting(c.env.DB, "ai_global_halt", JSON.stringify(halted ? { reason, at: nowIso(), by: c.get("user")!.id } : null));
  await audit(c, null, halted ? "platform.ai_halt" : "platform.ai_resume", { reason }, { state: before ? "set" : "none" }).run();
  return c.json({ ok: true, halted });
});

// ── Operations: jobs, e-mail outbox, webhooks (status only, never payloads) ─────────────────────────
control.get("/ops", requirePlatform("platform:ops:read"), async (c) => {
  const db = c.env.DB;
  const stuckBefore = new Date(Date.now() - 30 * 60_000).toISOString();
  const d7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [jobs, stuck, failed, outbox, hooks, d1] = await Promise.all([
    db.prepare("SELECT kind, state, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY kind, state").bind(d7).all(),
    db
      .prepare(
        `SELECT j.id, j.kind, j.state, j.attempts, j.created_at, j.started_at, o.name AS organization FROM jobs j JOIN organizations o ON o.id = j.organization_id
         WHERE j.state IN ('queued','validating','running') AND COALESCE(j.started_at, j.created_at) < ? ORDER BY j.created_at LIMIT 50`,
      )
      .bind(stuckBefore)
      .all(),
    db
      .prepare(
        `SELECT j.id, j.kind, j.failure_code, j.finished_at, o.name AS organization FROM jobs j JOIN organizations o ON o.id = j.organization_id
         WHERE j.state = 'failed' AND j.created_at >= ? ORDER BY j.finished_at DESC LIMIT 25`,
      )
      .bind(d7)
      .all(),
    db.prepare("SELECT kind, status, COUNT(*) AS n FROM email_outbox WHERE created_at >= ? GROUP BY kind, status").bind(d7).all(),
    db.prepare("SELECT status, COUNT(*) AS n FROM webhook_deliveries WHERE created_at >= ? GROUP BY status").bind(d7).all(),
    db.prepare("SELECT (SELECT COUNT(*) FROM organizations) AS orgs, (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM audit_logs) AS audit_rows").first(),
  ]);
  return c.json({
    jobs7d: jobs.results,
    stuckJobs: stuck.results,
    failedJobs: failed.results,
    outbox7d: outbox.results,
    webhooks7d: hooks.results,
    database: d1,
    unavailable: [{ key: "r2_storage", reason: "El tamaño de R2 y las métricas de Workers necesitan un token de analíticas de Cloudflare que no está configurado." }],
    observedAt: nowIso(),
    measurement: "observed",
  });
});

control.post("/jobs/:id/cancel", requirePlatform("platform:ops:control"), requireStepUp, async (c) => {
  const id = c.req.param("id");
  const { reason } = await parseBody(c, z.strictObject({ reason: Reason }));
  const job = await c.env.DB.prepare("SELECT organization_id, state, cost_estimate FROM jobs WHERE id = ?").bind(id).first<{ organization_id: string; state: string; cost_estimate: number }>();
  if (!job) throw notFound("Trabajo");
  if (!["queued", "validating", "running"].includes(job.state)) return c.json({ ok: true, changed: false });
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE organization_id = ? AND id = ?").bind(now, job.organization_id, id),
    c.env.DB.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE organization_id = ? AND id = ? AND state = 'queued'").bind(now, job.organization_id, id),
    auditStmt(c.env.DB, { organizationId: job.organization_id, actorUserId: c.get("user")!.id, action: "platform.job_cancel", entityType: "job", entityId: id, after: { reason }, requestId: c.get("requestId") }),
  ]);
  const after = await c.env.DB.prepare("SELECT state FROM jobs WHERE organization_id = ? AND id = ?").bind(job.organization_id, id).first<{ state: string }>();
  if (job.state === "queued" && after?.state === "cancelled" && job.cost_estimate)
    await ledgerStmt(c.env.DB, { orgId: job.organization_id, jobId: id, kind: "release", amount: job.cost_estimate, category: "site_analysis" }).run();
  return c.json({ ok: true, changed: true });
});

// ── Platform audit log (who did what, never the content) ────────────────────────────────────────────
control.get("/audit", requirePlatform("platform:audit:read"), async (c) => {
  const q = z.object({ scope: z.enum(["platform", "all"]).default("platform"), org: z.string().uuid().optional() }).parse({ scope: c.req.query("scope") || undefined, org: c.req.query("org") || undefined });
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.after_redacted, a.created_at, o.name AS organization, u.email AS actor
     FROM audit_logs a LEFT JOIN organizations o ON o.id = a.organization_id LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE (?1 = 'all' OR a.action LIKE 'platform.%') AND (?2 IS NULL OR a.organization_id = ?2)
     ORDER BY a.created_at DESC LIMIT 200`,
  )
    .bind(q.scope, q.org ?? null)
    .all<{ actor: string | null; [k: string]: unknown }>();
  return c.json({ items: results.map((r) => ({ ...r, actor: r.actor ? maskEmail(r.actor) : null })), observedAt: nowIso() });
});
