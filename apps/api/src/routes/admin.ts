import { Hono } from "hono";
import { z } from "zod";
import { freeGate } from "@dni/core";
import type { AppEnv } from "../env";
import { AiUnavailableError, generateText, logInvocation } from "../lib/ai";
import { auditStmt } from "../lib/audit";
import { ApiError, parseBody } from "../lib/http";
import {
  callOpenRouterChat,
  getState,
  loadModel,
  OpenRouterCallError,
  openRouterAvailability,
  quotaScopes,
  refreshKeyInfo,
  releaseQuota,
  reserveQuota,
  setState,
  syncOpenRouterCatalog,
} from "../lib/openrouter";
import { rateLimit } from "../lib/ratelimit";
import { addSeconds, nowIso, uuid } from "../lib/util";
import { requirePlatform, requirePlatformAdmin, requireStepUp, requireUser } from "../middleware";
import { accountStatus, archiveProducts, billingAccess, ensureWebhookEndpoint, foreignProducts, getSetting, StripeApiError, stripeMode, syncStripeCatalog, taxConfig, webhookSecrets } from "../lib/stripe";
import { providerStatus } from "./aihub";

/** Platform SuperAdmin endpoints for the AI Model Hub. 404 for everyone else. */
export const admin = new Hono<AppEnv>();
admin.use("*", requireUser, requirePlatformAdmin);

admin.get("/ai/overview", async (c) => {
  const db = c.env.DB;
  const since = addSeconds(-7 * 86400);
  const [{ results: perTenant }, { results: perModel }, { results: changes }, totals] = await Promise.all([
    db
      .prepare(
        `SELECT i.organization_id, o.name AS organization, COUNT(*) AS calls, SUM(CASE WHEN i.provider = 'openrouter' THEN 1 ELSE 0 END) AS openrouter_calls
         FROM ai_invocations i LEFT JOIN organizations o ON o.id = i.organization_id WHERE i.created_at > ? GROUP BY i.organization_id ORDER BY calls DESC LIMIT 50`,
      )
      .bind(since)
      .all(),
    db
      .prepare(
        `SELECT provider, model, task, COUNT(*) AS calls, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN error_code='http_429' THEN 1 ELSE 0 END) AS rate_limited, ROUND(AVG(CASE WHEN status='ok' THEN latency_ms END)) AS avg_latency_ms,
                SUM(CASE WHEN is_fallback=1 AND status='ok' THEN 1 ELSE 0 END) AS served_as_fallback
         FROM ai_invocations WHERE created_at > ? GROUP BY provider, model, task ORDER BY calls DESC LIMIT 100`,
      )
      .bind(since)
      .all(),
    db.prepare("SELECT model_id, change, detail, created_at FROM ai_model_changes ORDER BY created_at DESC LIMIT 50").all(),
    db
      .prepare(
        `SELECT COUNT(*) AS calls, SUM(CASE WHEN provider='openrouter' AND cost_state='billed' THEN 1 ELSE 0 END) AS billed_calls,
                SUM(COALESCE(reported_cost_usd,0)) AS reported_cost_usd, SUM(CASE WHEN error_code='http_429' THEN 1 ELSE 0 END) AS rate_limited,
                SUM(CASE WHEN is_fallback=1 AND status='ok' THEN 1 ELSE 0 END) AS fallback_ok, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok
         FROM ai_invocations WHERE created_at > ?`,
      )
      .bind(since)
      .first(),
  ]);
  return c.json({ period: "últimos 7 días", measurement: "observed", status: await providerStatus(c.env), totals, perTenant, perModel, changes });
});

admin.post("/ai/models/sync", async (c) => {
  await rateLimit(c.env.DB, `or-sync:${c.get("user")!.id}`, 6, 3600);
  const summary = await syncOpenRouterCatalog(c.env, c.get("deps"), { force: true });
  await refreshKeyInfo(c.env, c.get("deps"));
  await auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: "ai.catalog_sync", entityType: "ai_models", entityId: "openrouter", after: summary, requestId: c.get("requestId") }).run();
  if (!summary.ok) throw new ApiError(502, "sync_failed", "No se pudo sincronizar el catálogo de OpenRouter. Se conserva la última versión válida.", { error: summary.error });
  return c.json(summary);
});

const ToggleInput = z.strictObject({ enabled: z.boolean() });
admin.post("/ai/openrouter/kill-switch", async (c) => {
  const { enabled } = await parseBody(c, ToggleInput);
  await setState(c.env.DB, "or_enabled", enabled);
  await auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: enabled ? "ai.openrouter_enable" : "ai.openrouter_kill_switch", entityType: "platform", entityId: "openrouter", after: { enabled }, requestId: c.get("requestId") }).run();
  return c.json({ enabled });
});

admin.post("/ai/openrouter/reset-halt", async (c) => {
  const halt = await getState(c.env.DB, "or_halt", null);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ai_platform_state WHERE k IN ('or_halt','or_cooldown_until')"),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: "ai.openrouter_reset_halt", entityType: "platform", entityId: "openrouter", before: halt, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

/** Opt-in health check of ONE model: one tiny request, at most once per model per 24 h. */
admin.post("/ai/models/health-check", async (c) => {
  const { modelId } = await parseBody(c, z.strictObject({ modelId: z.string().max(120) }));
  const db = c.env.DB;
  await rateLimit(db, "or-health-global", 10, 86400);
  const row = await loadModel(db, modelId);
  if (!row || !freeGate(row, "classification").ok) throw new ApiError(422, "model_not_allowed", "Solo se comprueban modelos gratuitos elegibles.");
  if (row.healthCheckedAt && Date.now() - Date.parse(row.healthCheckedAt) < 86_400_000) throw new ApiError(429, "recently_checked", "Este modelo ya se comprobó en las últimas 24 horas.");
  const avail = await openRouterAvailability(c.env);
  if (!avail.usable) throw new ApiError(503, "openrouter_unavailable", `OpenRouter no está disponible: ${avail.reason}.`);
  const scopes = await quotaScopes(c.env, null, null);
  const q = await reserveQuota(db, scopes);
  if (!q.ok) throw new ApiError(429, "quota_exhausted", "La cuota gratuita de OpenRouter se ha agotado.");
  const ref = uuid();
  try {
    const r = await callOpenRouterChat(c.env, c.get("deps"), modelId, "classification", [{ role: "user", content: "Responde únicamente con la palabra: OK" }], { maxTokens: 16, temperature: 0, privacyFirst: false });
    await db.prepare("UPDATE ai_models SET health_status = 'ok', health_checked_at = ?, health_error = NULL WHERE model_id = ?").bind(nowIso(), modelId).run();
    await logInvocation(c.env, { orgId: null, userId: c.get("user")!.id, requestRef: ref, task: "health_check", strategy: "manual_free", provider: "openrouter", model: modelId, servedModel: r.servedModel, status: "ok", latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, reportedCostUsd: r.reportedCostUsd, costState: r.reportedCostUsd === 0 ? "zero_confirmed" : "zero_expected", isFallback: false });
    return c.json({ ok: true, latencyMs: r.latencyMs, servedModel: r.servedModel, reportedCostUsd: r.reportedCostUsd });
  } catch (e) {
    const code = e instanceof OpenRouterCallError ? e.code : "error";
    if (code.startsWith("gate:")) await releaseQuota(db, scopes);
    await db.prepare("UPDATE ai_models SET health_status = 'failed', health_checked_at = ?, health_error = ? WHERE model_id = ?").bind(nowIso(), code, modelId).run();
    await logInvocation(c.env, { orgId: null, userId: c.get("user")!.id, requestRef: ref, task: "health_check", strategy: "manual_free", provider: "openrouter", model: modelId, status: "failed", errorCode: code, costState: "zero_expected", isFallback: false });
    return c.json({ ok: false, error: code }, 200);
  }
});

/**
 * «Probar conexión» of one free provider (Workers AI, Groq or Gemini): one tiny request with the real
 * secret, no cache and no fallback. At most 20 checks a day for the whole platform; audited. The key is
 * never returned or logged: only provider, model, latency and the error code.
 */
admin.post("/ai/providers/test", async (c) => {
  const { provider } = await parseBody(c, z.strictObject({ provider: z.enum(["workers_ai", "groq", "gemini"]) }));
  await rateLimit(c.env.DB, "ai-provider-test", 20, 86400);
  const user = c.get("user")!;
  let out: { ok: boolean; provider: string; model?: string; latencyMs: number; error?: string };
  const started = Date.now();
  try {
    const r = await generateText(c.env, c.get("deps"), [{ role: "user", content: "Responde únicamente con la palabra: OK" }], { task: "classification", maxTokens: 16, userId: user.id, onlyProvider: provider, cache: false });
    out = { ok: true, provider: r.provider, model: r.model, latencyMs: Date.now() - started };
  } catch (e) {
    const attempts = e instanceof AiUnavailableError ? e.attempts : [];
    out = { ok: false, provider, latencyMs: Date.now() - started, error: (attempts.at(-1) ?? "error").slice(0, 80) };
  }
  await auditStmt(c.env.DB, { organizationId: null, actorUserId: user.id, action: "ai.provider_test", entityType: "platform", entityId: provider, after: out, requestId: c.get("requestId") }).run();
  return c.json(out);
});

// ── Stripe (platform admins only) ─────────────────────────────────────────────────────────────────
admin.get("/billing/stripe", async (c) => {
  const { results: plans } = await c.env.DB.prepare("SELECT code, name, price_eur_month, price_eur_year, trial_days, stripe_price_id, stripe_price_id_year FROM plans WHERE active = 1 ORDER BY position").all();
  const mode = stripeMode(c.env);
  return c.json({
    account: await accountStatus(c.env),
    tax: mode ? await taxConfig(c.env) : null,
    lastAutoSync: mode ? await getSetting(c.env.DB, `stripe_autosync_last_${mode}`) : null,
    billingFlagValue: c.env.BILLING_ENABLED ?? null,
    mode: mode ?? "none",
    access: billingAccess(c.env),
    secretKeyPresent: !!c.env.STRIPE_SECRET_KEY,
    webhookSecretPresent: !!c.env.STRIPE_WEBHOOK_SECRET,
    webhookVerifiable: (await webhookSecrets(c.env)).length > 0,
    webhookEndpoint: mode ? JSON.parse((await getSetting(c.env.DB, `stripe_webhook_endpoint_${mode}`)) ?? "null") : null,
    billingEnabledFlag: c.env.BILLING_ENABLED === "true",
    webhookUrl: `${c.env.APP_ORIGIN}/api/v1/webhooks/stripe`,
    portalConfigurationId: mode ? await getSetting(c.env.DB, `stripe_portal_config_${mode}`) : null,
    plans,
  });
});

admin.post("/billing/stripe/sync", async (c) => {
  await rateLimit(c.env.DB, "stripe-sync", 10, 3600);
  if (!stripeMode(c.env)) throw new ApiError(503, "provider_not_configured", "Falta STRIPE_SECRET_KEY (sk_test_… o sk_live_…).");
  try {
    const catalog = await syncStripeCatalog(c.env, c.get("deps"), c.env.APP_ORIGIN);
    const webhook = await ensureWebhookEndpoint(c.env, c.get("deps"), c.env.APP_ORIGIN);
    const r = { ...catalog, webhook };
    await auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: "platform.stripe_catalog_sync", entityType: "plan", after: r, requestId: c.get("requestId") }).run();
    return c.json(r);
  } catch (e) {
    if (e instanceof StripeApiError) throw new ApiError(502, "provider_error", `Stripe rechazó la sincronización (${e.code}).`);
    throw e;
  }
});

/** Products in the Stripe account that DNI Growth does not manage: preview first, then archive (reversible). */
admin.get("/billing/stripe/foreign-products", async (c) => {
  if (!stripeMode(c.env)) throw new ApiError(503, "provider_not_configured", "Falta STRIPE_SECRET_KEY.");
  try {
    return c.json({ items: await foreignProducts(c.env, c.get("deps")) });
  } catch (e) {
    if (e instanceof StripeApiError) throw new ApiError(502, "provider_error", `Stripe rechazó la consulta (${e.code}).`);
    throw e;
  }
});

admin.post("/billing/stripe/archive-products", async (c) => {
  const { ids } = await parseBody(c, z.strictObject({ ids: z.array(z.string().regex(/^prod_[A-Za-z0-9]{6,40}$/)).min(1).max(50) }));
  await rateLimit(c.env.DB, "stripe-archive", 10, 3600);
  if (!stripeMode(c.env)) throw new ApiError(503, "provider_not_configured", "Falta STRIPE_SECRET_KEY.");
  try {
    const archived = await archiveProducts(c.env, c.get("deps"), ids);
    await auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: "platform.stripe_products_archived", entityType: "plan", after: { mode: stripeMode(c.env), archived }, requestId: c.get("requestId") }).run();
    return c.json({ archived });
  } catch (e) {
    if (e instanceof StripeApiError) throw new ApiError(502, "provider_error", `Stripe rechazó el archivado (${e.code}).`);
    throw e;
  }
});

// ── Platform control panel (owner / SuperAdmin) ────────────────────────────────────────────────────
// Read-only platform metrics (observed from D1) plus one audited write: assigning an internal plan.
// Organisation content (leads, brands, texts) is never returned here: only counts and metadata.

admin.get("/overview", async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const d7 = new Date(now - 7 * 86400_000).toISOString();
  const d30 = new Date(now - 30 * 86400_000).toISOString();
  const day = new Date(now - 86400_000).toISOString();
  const one = <T,>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();
  const [users, orgs, byPlan, subs, ai, jobs, leads, recent, signups] = await Promise.all([
    one<{ total: number; verified: number; admins: number; new7: number; new30: number }>(
      `SELECT COUNT(*) AS total, SUM(email_verified_at IS NOT NULL) AS verified, SUM(is_platform_admin = 1) AS admins,
              SUM(created_at >= ?) AS new7, SUM(created_at >= ?) AS new30 FROM users`,
      d7,
      d30,
    ),
    one<{ total: number; new30: number; clients: number }>("SELECT COUNT(*) AS total, SUM(created_at >= ?) AS new30, SUM(agency_org_id IS NOT NULL) AS clients FROM organizations", d30),
    db.prepare("SELECT p.code, p.name, p.price_eur_month AS price, COUNT(o.id) AS orgs FROM plans p LEFT JOIN organizations o ON o.plan_code = p.code GROUP BY p.code ORDER BY p.position").all<{ code: string; name: string; price: number; orgs: number }>(),
    db
      .prepare(
        `SELECT s.provider, s.status, s.plan_code, p.price_eur_month AS price, COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.code = s.plan_code
         GROUP BY s.provider, s.status, s.plan_code`,
      )
      .all<{ provider: string; status: string; plan_code: string; price: number; n: number }>(),
    one<{ calls24: number; calls7: number; failed7: number; cache7: number }>(
      "SELECT SUM(created_at >= ?) AS calls24, COUNT(*) AS calls7, SUM(status = 'failed') AS failed7, SUM(provider = 'cache') AS cache7 FROM ai_invocations WHERE created_at >= ?",
      day,
      d7,
    ),
    one<{ audits30: number; failed7: number; running: number }>(
      "SELECT SUM(kind = 'site_analysis' AND created_at >= ?) AS audits30, SUM(state = 'failed' AND created_at >= ?) AS failed7, SUM(state IN ('queued','running')) AS running FROM jobs",
      d30,
      d7,
    ),
    one<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?", d30),
    db
      .prepare(
        `SELECT a.action, a.entity_type, a.created_at, o.name AS organization FROM audit_logs a LEFT JOIN organizations o ON o.id = a.organization_id
         ORDER BY a.created_at DESC LIMIT 25`,
      )
      .all<{ action: string; entity_type: string; created_at: string; organization: string | null }>(),
    db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day").bind(d30).all<{ day: string; n: number }>(),
  ]);
  const paying = subs.results.filter((s) => s.provider === "stripe" && ["active", "trialing", "past_due"].includes(s.status));
  const mode = stripeMode(c.env);
  return c.json({
    observedAt: nowIso(),
    measurement: "observed",
    users,
    organizations: { ...orgs, byPlan: byPlan.results },
    subscriptions: {
      rows: subs.results,
      paying: paying.reduce((a, s) => a + s.n, 0),
      // Derived: list price × active Stripe subscriptions. In test mode it is test data, not revenue.
      mrrEur: paying.reduce((a, s) => a + s.n * (s.price ?? 0), 0),
      stripeMode: mode ?? "none",
      billingEnabled: c.env.BILLING_ENABLED === "true",
      caveat:
        mode === "live"
          ? "Precio de lista × suscripciones activas; no descuenta impuestos, cupones ni impagos."
          : "Stripe está en modo prueba: estas cifras son datos de prueba, no ingresos.",
    },
    ai: { ...ai, dailyBudgetUsd: Number(c.env.AI_DAILY_BUDGET_USD ?? "0.10") },
    jobs,
    leads30: leads?.n ?? 0,
    signups: signups.results,
    recent: recent.results,
  });
});

const ListQuery = z.object({ q: z.string().trim().max(120).optional(), plan: z.string().max(20).optional() });
const likeOf = (q: string | undefined) => (q ? `%${q.replace(/[%_]/g, "")}%` : null);

admin.get("/organizations", async (c) => {
  const { q, plan } = ListQuery.parse({ q: c.req.query("q") || undefined, plan: c.req.query("plan") || undefined });
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.plan_code, o.status, o.deleted_at, o.purge_after, o.created_at, o.agency_org_id, a.name AS agency_name,
            (SELECT COUNT(*) FROM memberships m WHERE m.organization_id = o.id AND m.status = 'active') AS members,
            (SELECT COUNT(*) FROM brands b WHERE b.organization_id = o.id) AS brands,
            (SELECT COUNT(*) FROM leads l WHERE l.organization_id = o.id) AS leads,
            (SELECT MAX(created_at) FROM audit_logs al WHERE al.organization_id = o.id) AS last_activity,
            (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email,
            s.provider AS sub_provider, s.status AS sub_status, s.cancel_at_period_end, s.current_period_end
     FROM organizations o LEFT JOIN organizations a ON a.id = o.agency_org_id LEFT JOIN subscriptions s ON s.organization_id = o.id
     WHERE (?1 IS NULL OR o.name LIKE ?1 OR o.slug LIKE ?1) AND (?2 IS NULL OR o.plan_code = ?2)
     ORDER BY o.created_at DESC LIMIT 200`,
  )
    .bind(likeOf(q), plan ?? null)
    .all();
  return c.json({ items: results, observedAt: nowIso() });
});

admin.get("/users", async (c) => {
  const { q } = ListQuery.parse({ q: c.req.query("q") || undefined });
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.email_verified_at IS NOT NULL AS verified, u.is_platform_admin AS admin, u.created_at, u.locked_until,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id AND m.status = 'active') AS orgs,
            (SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen
     FROM users u WHERE (?1 IS NULL OR u.email LIKE ?1 OR u.name LIKE ?1) ORDER BY u.created_at DESC LIMIT 200`,
  )
    .bind(likeOf(q))
    .all();
  return c.json({ items: results, observedAt: nowIso() });
});

/**
 * Internal plan (no charge): for the owner's own organisations, partners or support. Refused when the
 * organisation pays through Stripe, so a manual change can never contradict a real subscription.
 */
admin.post("/organizations/:id/plan", requirePlatform("platform:billing:manage"), requireStepUp, async (c) => {
  const user = c.get("user")!;
  const orgId = c.req.param("id");
  const { planCode, reason } = await parseBody(c, z.strictObject({ planCode: z.enum(["free", "starter", "growth", "pro", "agency"]), reason: z.string().trim().min(3).max(200) }));
  await rateLimit(c.env.DB, `admin-plan:${user.id}`, 30, 3600);
  const db = c.env.DB;
  const org = await db.prepare("SELECT id, plan_code FROM organizations WHERE id = ?").bind(orgId).first<{ id: string; plan_code: string }>();
  if (!org) throw new ApiError(404, "not_found", "Organización no encontrada.");
  const sub = await db.prepare("SELECT provider, status FROM subscriptions WHERE organization_id = ?").bind(orgId).first<{ provider: string; status: string }>();
  if (sub?.provider === "stripe" && ["active", "trialing", "past_due", "incomplete"].includes(sub.status))
    throw new ApiError(409, "stripe_subscription", "Esta organización paga con Stripe: cambia el plan desde su suscripción, no a mano.");
  if (org.plan_code === planCode) return c.json({ ok: true, planCode, changed: false });
  await db.batch([
    db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(planCode, orgId),
    db.prepare("UPDATE subscriptions SET plan_code = ?, updated_at = ? WHERE organization_id = ? AND provider = 'internal'").bind(planCode, nowIso(), orgId),
    auditStmt(db, {
      organizationId: orgId,
      actorUserId: user.id,
      action: "platform.plan_assign",
      entityType: "organization",
      entityId: orgId,
      before: { plan: org.plan_code },
      after: { plan: planCode, reason, charge: "none" },
      requestId: c.get("requestId"),
    }),
  ]);
  return c.json({ ok: true, planCode, changed: true });
});
