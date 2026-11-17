import { Hono } from "hono";
import { canAssignRole, CreateOrgInput, InviteInput, randomToken, scopesFor, sha256Hex, UpdateMemberInput, type Role } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { creditBalance, ensureMonthlyGrant, getPlan, grantStmt, orgPlan, analysesThisMonth } from "../lib/billing";
import { ApiError, assertUuid, forbidden, notFound, parseBody } from "../lib/http";
import { emailHtml, sendMail } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { addSeconds, monthKey, nowIso, slugify, uuid } from "../lib/util";
import { requireScope, requireUser } from "../middleware";

/** Routes outside a tenant: create/list orgs, accept invitations. */
export const orgsPublic = new Hono<AppEnv>();


orgsPublic.post("/orgs", requireUser, async (c) => {
  const user = c.get("user")!;
  await rateLimit(c.env.DB, `org-create:${user.id}`, 5, 86400);
  const { name } = await parseBody(c, CreateOrgInput);
  const owned = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'").bind(user.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= 10) throw new ApiError(409, "org_limit", "Has alcanzado el máximo de organizaciones propias.");
  const id = uuid();
  const slug = `${slugify(name)}-${id.slice(0, 6)}`;
  const plan = await getPlan(c.env.DB, "free");
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO organizations (id, name, slug, created_by) VALUES (?, ?, ?, ?)").bind(id, name, slug, user.id),
    c.env.DB.prepare("INSERT INTO memberships (id, organization_id, user_id, role) VALUES (?, ?, ?, 'owner')").bind(uuid(), id, user.id),
    c.env.DB.prepare("INSERT INTO subscriptions (id, organization_id, plan_code, provider, status) VALUES (?, ?, 'free', 'internal', 'active')").bind(uuid(), id),
    grantStmt(c.env.DB, id, plan.limits.monthlyCredits, `grant:${id}:${monthKey()}:free`),
    auditStmt(c.env.DB, { organizationId: id, actorUserId: user.id, action: "org.create", entityType: "organization", entityId: id, after: { name }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id, name, slug }, 201);
});

orgsPublic.post("/invitations/accept", requireUser, async (c) => {
  const user = c.get("user")!;
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (!body.token || !/^[0-9a-f]{64}$/.test(body.token)) throw new ApiError(400, "invalid_or_expired_token", "Invitación no válida o caducada.");
  const inv = await c.env.DB.prepare(
    "SELECT id, organization_id, email, role, invited_by FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(body.token), nowIso())
    .first<{ id: string; organization_id: string; email: string; role: Role; invited_by: string }>();
  if (!inv) throw new ApiError(400, "invalid_or_expired_token", "Invitación no válida o caducada.");
  // The invitation is bound to the invited email: a leaked link cannot be used by another account.
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden("Esta invitación es para otra dirección de correo.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invitations SET accepted_at = ? WHERE organization_id = ? AND id = ? AND accepted_at IS NULL").bind(nowIso(), inv.organization_id, inv.id),
    c.env.DB.prepare("INSERT OR IGNORE INTO memberships (id, organization_id, user_id, role, invited_by) VALUES (?, ?, ?, ?, ?)").bind(uuid(), inv.organization_id, user.id, inv.role, inv.invited_by),
    auditStmt(c.env.DB, { organizationId: inv.organization_id, actorUserId: user.id, action: "member.join", entityType: "membership", entityId: user.id, after: { role: inv.role }, requestId: c.get("requestId") }),
  ]);
  return c.json({ organizationId: inv.organization_id });
});

/** Tenant-scoped routes: /api/v1/orgs/:orgId/... */
export const org = new Hono<AppEnv>();
// Tenant middleware (requireUser + requireMembership) is applied by the parent router in app.ts.

org.get("/", requireScope("org:read"), async (c) => {
  const t = c.get("tenant");
  const o = await c.env.DB.prepare("SELECT id, name, slug, currency, region, plan_code, created_at FROM organizations WHERE id = ?").bind(t.orgId).first();
  const plan = await orgPlan(c.env.DB, t.orgId);
  return c.json({ organization: o, role: t.role, scopes: scopesFor(t.role), plan });
});

org.get("/dashboard", requireScope("org:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const plan = await orgPlan(db, t.orgId);
  await ensureMonthlyGrant(db, t.orgId, plan);
  const [brands, crawls, openIssues, latest, jobs, tasks, balance, used] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM brands WHERE organization_id = ?").bind(t.orgId).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM web_crawls WHERE organization_id = ? AND status = 'completed'").bind(t.orgId).first<{ n: number }>(),
    db.prepare(
      `SELECT severity, COUNT(*) AS n FROM seo_issues WHERE organization_id = ? AND status = 'open'
       AND crawl_id IN (SELECT id FROM (SELECT id, site_id, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY started_at DESC) rn FROM web_crawls WHERE organization_id = ? AND status = 'completed') WHERE rn = 1)
       GROUP BY severity`,
    ).bind(t.orgId, t.orgId).all<{ severity: string; n: number }>(),
    db.prepare(
      `SELECT w.id, w.health_score, w.pages_count, w.completed_at, s.origin, s.brand_id FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
       WHERE w.organization_id = ? AND w.status = 'completed' ORDER BY w.completed_at DESC LIMIT 1`,
    ).bind(t.orgId).first<{ id: string; health_score: number; pages_count: number; completed_at: string; origin: string; brand_id: string }>(),
    db.prepare("SELECT id, kind, state, progress, created_at, finished_at, failure_code FROM jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 5").bind(t.orgId).all(),
    db.prepare("SELECT status, COUNT(*) AS n FROM growth_tasks WHERE organization_id = ? GROUP BY status").bind(t.orgId).all<{ status: string; n: number }>(),
    creditBalance(db, t.orgId),
    analysesThisMonth(db, t.orgId),
  ]);
  const observedAt = nowIso();
  const metric = (metric: string, value: number | null, unit: string, measurement: "observed" | "derived", source: string, limitations: string[] = []) => ({
    metric,
    value,
    unit,
    measurement,
    source,
    observedAt,
    limitations,
  });
  return c.json({
    metrics: [
      metric("brands", brands?.n ?? 0, "marcas", "observed", "DNI Growth DB"),
      metric("completed_audits", crawls?.n ?? 0, "auditorías", "observed", "DNI Growth DB"),
      metric("health_score", latest?.health_score ?? null, "/100", "derived", latest ? `Auditoría ${latest.id.slice(0, 8)} · ${latest.origin}` : "Sin auditorías", [
        "Indicador interno basado en reglas técnicas; no predice posiciones en buscadores.",
      ]),
      metric("credits_balance", balance, "créditos", "observed", "Ledger de créditos"),
      metric("analyses_used", used, `de ${plan.limits.analysesPerMonth} este mes`, "observed", `Plan ${plan.name}`),
    ],
    issuesBySeverity: openIssues.results,
    latestAudit: latest ?? null,
    recentJobs: jobs.results,
    tasksByStatus: tasks.results,
    unavailable: [
      { key: "organic_traffic", label: "Tráfico orgánico", reason: "Google Search Console no conectado (fase F3)." },
      { key: "ai_visibility", label: "Visibilidad en IA", reason: "Monitor GEO no disponible (fase F3)." },
      { key: "ad_spend", label: "Gasto publicitario", reason: "Meta Ads no conectado (fase F6)." },
      { key: "attributed_revenue", label: "Ingresos atribuidos", reason: "CRM y atribución no disponibles (fases F5–F7)." },
    ],
  });
});

org.get("/members", requireScope("members:read"), async (c) => {
  const t = c.get("tenant");
  const [members, invites] = await Promise.all([
    c.env.DB.prepare(
      "SELECT m.id, m.role, m.status, m.created_at, u.id AS user_id, u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at",
    ).bind(t.orgId).all(),
    c.env.DB.prepare(
      "SELECT id, email, role, expires_at, created_at FROM invitations WHERE organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    ).bind(t.orgId, nowIso()).all(),
  ]);
  return c.json({ members: members.results, invitations: invites.results });
});

org.post("/invitations", requireScope("members:invite"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  await rateLimit(c.env.DB, `invite:${t.orgId}`, 30, 3600);
  const input = await parseBody(c, InviteInput);
  if (!canAssignRole(t.role, input.role)) throw forbidden("No puedes asignar un rol igual o superior al tuyo.");
  const plan = await orgPlan(c.env.DB, t.orgId);
  const seats = await c.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM memberships WHERE organization_id = ?1) + (SELECT COUNT(*) FROM invitations WHERE organization_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS n",
  ).bind(t.orgId, nowIso()).first<{ n: number }>();
  if ((seats?.n ?? 0) >= plan.limits.seats) throw new ApiError(402, "plan_limit", `Tu plan ${plan.name} permite ${plan.limits.seats} usuario(s).`);
  const token = randomToken(32);
  const id = uuid();
  const orgRow = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(t.orgId).first<{ name: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      id, t.orgId, input.email, input.role, await sha256Hex(token), user.id, addSeconds(7 * 86400),
    ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "member.invite", entityType: "invitation", entityId: id, after: { email: input.email, role: input.role }, requestId: c.get("requestId") }),
  ]);
  const url = `${c.env.APP_ORIGIN}/app/invite?token=${token}`;
  const orgName = orgRow?.name ?? "una organización";
  const result = await sendMail(
    c.env,
    {
      to: input.email,
      subject: `Invitación a ${orgName} en DNI Growth`,
      text: `${user.name} te invita a unirte a ${orgName} en DNI Growth.\n\nAcepta aquí (caduca en 7 días):\n${url}`,
      html: emailHtml(`Te invitan a ${orgName}`, [`${user.name} te invita a unirte a ${orgName} en DNI Growth.`, "La invitación caduca en 7 días."], { label: "Aceptar invitación", url }),
    },
    { kind: "invitation", idempotencyKey: `invitation:${id}`, organizationId: t.orgId },
  );
  const delivery = result === "not_configured" ? "not_configured" : result === "dev_mailbox" ? "dev_mailbox" : result === "accepted" ? "sent" : "queued";
  return c.json({ id, delivery }, 201);
});

org.delete("/invitations/:invId", requireScope("members:invite"), async (c) => {
  const t = c.get("tenant");
  const invId = assertUuid(c.req.param("invId"), "Invitación");
  const r = await c.env.DB.prepare("UPDATE invitations SET revoked_at = ? WHERE organization_id = ? AND id = ? AND accepted_at IS NULL AND revoked_at IS NULL")
    .bind(nowIso(), t.orgId, invId)
    .run();
  if (!r.meta.changes) throw notFound("Invitación");
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "member.invite_revoke", entityType: "invitation", entityId: invId, requestId: c.get("requestId") }).run();
  return c.json({ ok: true });
});

async function ownerCount(db: D1Database, orgId: string) {
  return (await db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ? AND role = 'owner' AND status = 'active'").bind(orgId).first<{ n: number }>())?.n ?? 0;
}

org.patch("/members/:memberId", requireScope("members:manage"), async (c) => {
  const t = c.get("tenant");
  const memberId = assertUuid(c.req.param("memberId"), "Miembro");
  const { role } = await parseBody(c, UpdateMemberInput);
  const m = await c.env.DB.prepare("SELECT id, user_id, role FROM memberships WHERE organization_id = ? AND id = ?").bind(t.orgId, memberId).first<{ id: string; user_id: string; role: Role }>();
  if (!m) throw notFound("Miembro");
  if (!canAssignRole(t.role, role) || (m.role !== role && !canAssignRole(t.role, m.role))) throw forbidden("No puedes cambiar este rol.");
  if (m.role === "owner" && role !== "owner" && (await ownerCount(c.env.DB, t.orgId)) <= 1) throw new ApiError(409, "last_owner", "Debe quedar al menos un propietario.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE memberships SET role = ? WHERE organization_id = ? AND id = ?").bind(role, t.orgId, memberId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "member.role_change", entityType: "membership", entityId: memberId, before: { role: m.role }, after: { role }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

org.delete("/members/:memberId", requireScope("members:manage"), async (c) => {
  const t = c.get("tenant");
  const memberId = assertUuid(c.req.param("memberId"), "Miembro");
  const m = await c.env.DB.prepare("SELECT id, user_id, role FROM memberships WHERE organization_id = ? AND id = ?").bind(t.orgId, memberId).first<{ id: string; user_id: string; role: Role }>();
  if (!m) throw notFound("Miembro");
  if (!canAssignRole(t.role, m.role)) throw forbidden("No puedes eliminar a este miembro.");
  if (m.role === "owner" && (await ownerCount(c.env.DB, t.orgId)) <= 1) throw new ApiError(409, "last_owner", "Debe quedar al menos un propietario.");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM memberships WHERE organization_id = ? AND id = ?").bind(t.orgId, memberId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "member.remove", entityType: "membership", entityId: memberId, before: { role: m.role }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

org.get("/audit-logs", requireScope("audit:read"), async (c) => {
  const t = c.get("tenant");
  const before = c.req.query("before") ?? "9999";
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.before_redacted, a.after_redacted, a.request_id, a.created_at, u.name AS actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.organization_id = ? AND a.created_at < ? ORDER BY a.created_at DESC LIMIT 50`,
  ).bind(t.orgId, before).all();
  return c.json({ items: results, nextCursor: results.length === 50 ? (results[49] as { created_at: string }).created_at : null });
});

