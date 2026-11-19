import { Hono } from "hono";
import { BrandingInput, CreateOrgInput, GEO_PROMPT_LIMITS, LANDING_LIMITS } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { analysesThisMonth, creditBalance, getPlan, grantStmt, orgPlan } from "../lib/billing";
import { ApiError, forbidden, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { monthKey, nowIso, slugify, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * F8 Agency: client organisations (isolated tenants linked by agency_org_id), white label for the
 * app shell and reports, and the plan entitlements view (used vs. limit for every plan feature).
 * Custom domains are blocked on purpose: Cloudflare for SaaS hostnames may cost money.
 */
export const agency = new Hono<AppEnv>();

// ── Entitlements: what the current plan includes and how much is used ─────────────────────────
agency.get("/entitlements", requireScope("org:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const plan = await orgPlan(db, t.orgId);
  const count = async (sql: string) => ((await db.prepare(sql).bind(t.orgId).first<{ n: number }>())?.n ?? 0);
  const org = await db.prepare("SELECT plan_code, agency_org_id FROM organizations WHERE id = ?").bind(t.orgId).first<{ plan_code: string; agency_org_id: string | null }>();
  const L = plan.limits;
  const rows = [
    { key: "brands", label: "Marcas", used: await count("SELECT COUNT(*) AS n FROM brands WHERE organization_id = ?"), limit: L.brands },
    { key: "seats", label: "Personas del equipo", used: await count("SELECT COUNT(*) AS n FROM memberships WHERE organization_id = ? AND status = 'active'"), limit: L.seats },
    { key: "analysesPerMonth", label: "Auditorías este mes", used: await analysesThisMonth(db, t.orgId), limit: L.analysesPerMonth },
    { key: "pagesPerCrawl", label: "Páginas por auditoría", used: null, limit: L.pagesPerCrawl },
    { key: "monthlyCredits", label: "Créditos de IA al mes", used: null, limit: L.monthlyCredits, balance: await creditBalance(db, t.orgId) },
    { key: "trackedPrompts", label: "Preguntas GEO seguidas", used: await count("SELECT COUNT(*) AS n FROM tracked_prompts WHERE organization_id = ? AND archived_at IS NULL"), limit: L.trackedPrompts ?? GEO_PROMPT_LIMITS[plan.code] ?? 0 },
    { key: "leadForms", label: "Formularios de captación", used: await count("SELECT COUNT(*) AS n FROM lead_forms WHERE organization_id = ? AND status != 'archived'"), limit: L.leadForms ?? 1 },
    { key: "landingPages", label: "Landing pages", used: await count("SELECT COUNT(*) AS n FROM landing_pages WHERE organization_id = ? AND status != 'archived'"), limit: L.landingPages ?? LANDING_LIMITS[plan.code] ?? 1 },
    { key: "automationRules", label: "Reglas de automatización", used: await count("SELECT COUNT(*) AS n FROM automation_rules WHERE organization_id = ?"), limit: L.automationRules ?? 2 },
    { key: "videoProjects", label: "Proyectos de vídeo", used: await count("SELECT COUNT(*) AS n FROM video_projects WHERE organization_id = ? AND status != 'archived'"), limit: L.videoProjects ?? 2 },
    { key: "backlinks", label: "Enlaces seguidos (backlinks)", used: await count("SELECT COUNT(*) AS n FROM backlinks WHERE organization_id = ?"), limit: L.backlinks ?? 50 },
    { key: "clientOrgs", label: "Organizaciones cliente (agencia)", used: await count("SELECT COUNT(*) AS n FROM organizations WHERE agency_org_id = ?"), limit: org?.agency_org_id ? 0 : (L.clientOrgs ?? 0) },
  ];
  return c.json({ plan: { code: plan.code, name: plan.name, priceEurMonth: plan.priceEurMonth }, ownPlan: org?.plan_code ?? "free", inheritedFromAgency: !!org?.agency_org_id && org.plan_code === "free" && plan.code !== "free", rows, observedAt: nowIso() });
});

// ── Agency clients ──────────────────────────────────────────────────────────────────────────────
async function agencyContext(db: D1Database, orgId: string) {
  const org = await db.prepare("SELECT agency_org_id FROM organizations WHERE id = ?").bind(orgId).first<{ agency_org_id: string | null }>();
  const plan = await orgPlan(db, orgId);
  const limit = org?.agency_org_id ? 0 : (plan.limits.clientOrgs ?? 0);
  const used = (await db.prepare("SELECT COUNT(*) AS n FROM organizations WHERE agency_org_id = ?").bind(orgId).first<{ n: number }>())?.n ?? 0;
  return { isClient: !!org?.agency_org_id, limit, used, plan };
}

agency.get("/agency/clients", requireScope("org:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const ctx = await agencyContext(db, t.orgId);
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  // Only clients where the current user is an active member are listed (no cross-tenant reads).
  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, o.slug, o.created_at, m.role,
         (SELECT COUNT(*) FROM leads l WHERE l.organization_id = o.id AND l.is_test = 0 AND l.created_at >= ?) AS leads30,
         (SELECT COALESCE(SUM(l.value_cents), 0) FROM leads l WHERE l.organization_id = o.id AND l.is_test = 0 AND l.stage = 'won' AND l.created_at >= ?) AS won_cents30,
         (SELECT w.health_score FROM web_crawls w WHERE w.organization_id = o.id AND w.status = 'completed' ORDER BY w.started_at DESC LIMIT 1) AS health,
         (SELECT COUNT(*) FROM crm_tasks k WHERE k.organization_id = o.id AND k.status = 'open' AND k.due_at < ?) AS overdue_tasks,
         (SELECT COUNT(*) FROM memberships x WHERE x.organization_id = o.id AND x.status = 'active' AND x.role = 'client_viewer') AS client_viewers
       FROM organizations o JOIN memberships m ON m.organization_id = o.id AND m.user_id = ? AND m.status = 'active'
       WHERE o.agency_org_id = ? ORDER BY o.name`,
    )
    .bind(since, since, nowIso(), t.userId, t.orgId)
    .all<{ won_cents30: number }>();
  return c.json({
    clients: results.map((r) => ({ ...r, wonValue30: r.won_cents30 / 100 })),
    usage: { used: ctx.used, limit: ctx.limit },
    isClient: ctx.isClient,
    note: "Cada cliente es una organización aislada con sus propios datos. Invita a tu cliente con el rol «Cliente (solo lectura)» desde Equipo dentro de su organización.",
    blocked: [{ key: "custom_domain", label: "Dominio propio para el portal de clientes", reason: "Requiere Cloudflare for SaaS (posible coste). Desactivado hasta que lo autorices." }],
  });
});

agency.post("/agency/clients", requireScope("org:update"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const db = c.env.DB;
  await rateLimit(db, `agency-client:${t.orgId}`, 20, 86400);
  const ctx = await agencyContext(db, t.orgId);
  if (ctx.isClient) throw forbidden("Una organización cliente no puede crear otros clientes.");
  if (ctx.used >= ctx.limit) throw new ApiError(402, "plan_limit", ctx.limit ? `Tu plan permite ${ctx.limit} organizaciones cliente.` : "Las organizaciones cliente están incluidas en los planes Pro y Agency.");
  const { name } = await parseBody(c, CreateOrgInput);
  const id = uuid();
  const slug = `${slugify(name)}-${id.slice(0, 6)}`;
  const free = await getPlan(db, "free");
  const inherited = ctx.plan;
  await db.batch([
    db.prepare("INSERT INTO organizations (id, name, slug, created_by, agency_org_id) VALUES (?, ?, ?, ?, ?)").bind(id, name, slug, user.id, t.orgId),
    db.prepare("INSERT INTO memberships (id, organization_id, user_id, role) VALUES (?, ?, ?, 'owner')").bind(uuid(), id, user.id),
    db.prepare("INSERT INTO subscriptions (id, organization_id, plan_code, provider, status) VALUES (?, ?, 'free', 'internal', 'active')").bind(uuid(), id),
    grantStmt(db, id, inherited.limits.monthlyCredits ?? free.limits.monthlyCredits, `grant:${id}:${monthKey()}:${inherited.code}`),
    auditStmt(db, { organizationId: id, actorUserId: user.id, action: "org.create", entityType: "organization", entityId: id, after: { name, agencyOrgId: t.orgId }, requestId: c.get("requestId") }),
    auditStmt(db, { organizationId: t.orgId, actorUserId: user.id, action: "agency.client_create", entityType: "organization", entityId: id, after: { name }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id, name, slug }, 201);
});

// ── White label ─────────────────────────────────────────────────────────────────────────────────
type BrandingRow = { display_name: string | null; logo_url: string | null; accent: string | null; report_footer: string | null; support_email: string | null; updated_at: string };

async function effectiveBranding(db: D1Database, orgId: string) {
  // A client org shows its agency's white label unless it has its own.
  const org = await db.prepare("SELECT agency_org_id FROM organizations WHERE id = ?").bind(orgId).first<{ agency_org_id: string | null }>();
  const own = await db.prepare("SELECT display_name, logo_url, accent, report_footer, support_email, updated_at FROM org_branding WHERE organization_id = ?").bind(orgId).first<BrandingRow>();
  const parent = org?.agency_org_id ? await db.prepare("SELECT display_name, logo_url, accent, report_footer, support_email, updated_at FROM org_branding WHERE organization_id = ?").bind(org.agency_org_id).first<BrandingRow>() : null;
  const b = own ?? parent;
  return { own: !!own, inherited: !own && !!parent, displayName: b?.display_name ?? null, logoUrl: b?.logo_url ?? null, accent: b?.accent ?? null, reportFooter: b?.report_footer ?? null, supportEmail: b?.support_email ?? null };
}

agency.get("/branding", requireScope("org:read"), async (c) => c.json(await effectiveBranding(c.env.DB, c.get("tenant").orgId)));

agency.put("/branding", requireScope("org:update"), async (c) => {
  const t = c.get("tenant");
  const plan = await orgPlan(c.env.DB, t.orgId);
  if (!["pro", "agency"].includes(plan.code)) throw new ApiError(402, "plan_limit", "La marca blanca está incluida en los planes Pro y Agency.");
  const b = await parseBody(c, BrandingInput);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO org_branding (organization_id, display_name, logo_url, accent, report_footer, support_email, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET display_name = excluded.display_name, logo_url = excluded.logo_url, accent = excluded.accent, report_footer = excluded.report_footer, support_email = excluded.support_email, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(t.orgId, b.displayName ?? null, b.logoUrl ?? null, b.accent ?? null, b.reportFooter ?? null, b.supportEmail ?? null, t.userId, now),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "org.branding_update", entityType: "organization", entityId: t.orgId, after: { displayName: b.displayName ?? null, logo: !!b.logoUrl, accent: b.accent ?? null }, requestId: c.get("requestId") }),
  ]);
  return c.json(await effectiveBranding(c.env.DB, t.orgId));
});

agency.delete("/branding", requireScope("org:update"), async (c) => {
  const t = c.get("tenant");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_branding WHERE organization_id = ?").bind(t.orgId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "org.branding_reset", entityType: "organization", entityId: t.orgId, requestId: c.get("requestId") }),
  ]);
  return c.json(await effectiveBranding(c.env.DB, t.orgId));
});
