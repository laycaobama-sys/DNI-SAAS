import { gscReady } from "../lib/gsc";
import { Hono, type Context } from "hono";
import {
  CANCEL_REASONS,
  CancelInput,
  CheckoutInput,
  evaluateGuarantee,
  GUARANTEE,
  PauseInput,
  PLAN_OFFERS,
  RETENTION_DISCOUNT,
  verifyStripeSignature,
  type GuaranteeResult,
  type ProviderManifestEntry,
} from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { creditBalance, ensureMonthlyGrant, getPlan, grantStmt, orgPlan } from "../lib/billing";
import { ApiError, parseBody } from "../lib/http";
import { emailHtml, mailMode, sendMail } from "../lib/mail";
import { trackEvent, trackFromRequest } from "../lib/product-events";
import { rateLimit } from "../lib/ratelimit";
import { accountStatus, billingAccess, billingFlag, getSetting, setSetting, stripeApi, StripeApiError, stripeMode, stripeReady, taxConfig, webhookSecrets, webhooksAcceptedAsync, type BillingAccess } from "../lib/stripe";
import { log, monthKey, nowIso, uuid } from "../lib/util";
import { isPlatformAdmin, requireScope } from "../middleware";

/** Key + webhook secret (owner-provided or platform-managed, see lib/stripe.ts). */
export const stripeConfigured = (env: Env) => stripeReady(env);
/** Payments for everyone when BILLING_ENABLED="true" (or "auto" with a live key); test keys allow platform-admin checkouts. */
export const billingEnabled = billingFlag;
const billingDisabled = () => new ApiError(503, "billing_disabled", "Los pagos todavía no están activados en DNI Growth. No se ha realizado ningún cargo.");

const ACCESS_NOTE: Record<BillingAccess, string> = {
  not_configured: "Stripe no está conectado: no se puede pagar y no se realiza ningún cargo.",
  off: "Los pagos están desactivados por la plataforma: no se realiza ningún cargo.",
  test_admin_only: "Modo prueba de Stripe: solo administradores de la plataforma pueden abrir el pago, con tarjetas de prueba. Nadie paga dinero real.",
  open: "Pagos activos con Stripe.",
};

const DAY_MS = 86_400_000;
const GRACE_DAYS = 7;
const TERMS_VERSION = "2026-11-23";
const iso = (unix: unknown) => (typeof unix === "number" ? new Date(unix * 1000).toISOString() : null);
const fmtDate = (isoDate: string) => new Date(isoDate).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" });

interface SubRow {
  plan_code: string;
  provider: string;
  provider_sub_id: string | null;
  provider_customer_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: number;
  billing_interval: string | null;
  trial_end: string | null;
  paused_until: string | null;
  payment_failed_at: string | null;
  grace_until: string | null;
  started_at: string | null;
}

const subRow = (db: D1Database, orgId: string) =>
  db
    .prepare(
      `SELECT plan_code, provider, provider_sub_id, provider_customer_id, status, current_period_end, cancel_at_period_end, billing_interval, trial_end, paused_until,
              payment_failed_at, grace_until, started_at FROM subscriptions WHERE organization_id = ?`,
    )
    .bind(orgId)
    .first<SubRow>();

/** People who receive billing notices: owners and billing admins of the organisation (never logged). */
async function billingRecipients(db: D1Database, orgId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.status = 'active' AND m.role IN ('owner','billing_admin')")
    .bind(orgId)
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

async function notifyBilling(env: Env, orgId: string, key: string, subject: string, paragraphs: string[]) {
  const url = `${env.APP_ORIGIN}/app/o/${orgId}/billing`;
  for (const to of await billingRecipients(env.DB, orgId)) {
    await sendMail(
      env,
      { to, subject, text: `${paragraphs.join("\n\n")}\n\nGestiona tu suscripción: ${url}`, html: emailHtml(subject, paragraphs, { label: "Abrir facturación", url }) },
      { kind: "notification", idempotencyKey: `${key}:${to.toLowerCase()}`, organizationId: orgId },
    ).catch((e) => log("warn", "billing.notice_failed", { key: key.split(":")[0], error: String(e).slice(0, 80) }));
  }
}

/** Tenant billing routes (mounted under /orgs/:orgId). */
export const billing = new Hono<AppEnv>();

billing.get("/billing", requireScope("billing:read"), async (c) => {
  const t = c.get("tenant");
  const plan = await orgPlan(c.env.DB, t.orgId);
  await ensureMonthlyGrant(c.env.DB, t.orgId, plan);
  const [sub, ledger, plans, balance, admin, org, account] = await Promise.all([
    c.env.DB.prepare(
      `SELECT plan_code, provider, status, current_period_end, updated_at, provider_customer_id IS NOT NULL AS has_customer, cancel_at_period_end,
              billing_interval, trial_end, paused_until, payment_failed_at, grace_until, started_at FROM subscriptions WHERE organization_id = ?`,
    )
      .bind(t.orgId)
      .first(),
    c.env.DB.prepare("SELECT id, job_id, category, amount, entry_kind, provider, created_at FROM credit_ledger WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").bind(t.orgId).all(),
    c.env.DB.prepare(
      "SELECT code, name, price_eur_month, price_eur_year, trial_days, limits_json, stripe_price_id IS NOT NULL AS purchasable, stripe_price_id_year IS NOT NULL AS purchasable_year FROM plans WHERE active = 1 ORDER BY position",
    ).all(),
    creditBalance(c.env.DB, t.orgId),
    isPlatformAdmin(c.env, c.get("user") ?? null),
    c.env.DB.prepare("SELECT trial_used_at, retention_offer_used_at FROM organizations WHERE id = ?").bind(t.orgId).first<{ trial_used_at: string | null; retention_offer_used_at: string | null }>(),
    accountStatus(c.env),
  ]);
  const access = billingAccess(c.env);
  const configured = await stripeConfigured(c.env);
  const canCheckout = configured && (access === "open" || (access === "test_admin_only" && admin));
  const hadStripe = !!sub && (sub as { provider?: string }).provider === "stripe";
  const note =
    stripeMode(c.env) === "live" && account && !account.chargesEnabled
      ? "Stripe todavía está verificando la cuenta de DNI Growth: aún no se puede pagar y no se realiza ningún cargo."
      : ACCESS_NOTE[access];
  return c.json({
    plan,
    subscription: sub,
    balance,
    ledger: ledger.results,
    plans: plans.results,
    trialAvailable: !org?.trial_used_at && !hadStripe,
    retentionOfferAvailable: !org?.retention_offer_used_at,
    cancelReasons: CANCEL_REASONS.map(({ key, label, offer }) => ({ key, label, offer })),
    retentionDiscount: { percentOff: RETENTION_DISCOUNT.percentOff, months: RETENTION_DISCOUNT.months },
    stripe: { enabled: billingEnabled(c.env), configured, mode: stripeMode(c.env) ?? "none", access, canCheckout, note },
    notes: ["Precios sin IVA (se añade en el pago según tu país). El gasto publicitario (cuando exista) se factura aparte y nunca se mezcla con la cuota del software."],
  });
});

/** Throws unless this user may open a Stripe checkout/portal right now. */
async function assertCheckoutAllowed(c: Context<AppEnv>) {
  const access = billingAccess(c.env);
  if (access === "off") throw billingDisabled();
  if (access === "not_configured" || !(await stripeConfigured(c.env))) {
    if (!billingEnabled(c.env) && access === "not_configured") throw billingDisabled();
    if (stripeMode(c.env) === "live" && (await accountStatus(c.env))?.chargesEnabled === false)
      throw new ApiError(503, "provider_not_ready", "Stripe todavía está verificando la cuenta de DNI Growth. No se ha realizado ningún cargo.");
    throw new ApiError(503, "provider_not_configured", "Los pagos no están configurados todavía (Stripe no conectado). No se ha realizado ningún cargo.");
  }
  if (access === "test_admin_only" && !(await isPlatformAdmin(c.env, c.get("user") ?? null))) throw billingDisabled();
}

const providerError = (msg: string) => (e: unknown) => {
  if (e instanceof StripeApiError) throw new ApiError(502, "provider_error", msg);
  throw e;
};

billing.post("/billing/checkout", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const { planCode, interval } = await parseBody(c, CheckoutInput);
  await assertCheckoutAllowed(c);
  await rateLimit(db, `checkout:${t.orgId}`, 10, 3600);
  const priceRow = await db
    .prepare("SELECT stripe_price_id, stripe_price_id_year, trial_days FROM plans WHERE code = ? AND active = 1")
    .bind(planCode)
    .first<{ stripe_price_id: string | null; stripe_price_id_year: string | null; trial_days: number }>();
  const priceId = interval === "year" ? priceRow?.stripe_price_id_year : priceRow?.stripe_price_id;
  if (!priceId) throw new ApiError(503, "price_not_configured", "Este plan aún no tiene precio configurado en Stripe.");
  const sub = await subRow(db, t.orgId);
  // Never open a second paid subscription for the same organisation: plan changes go through the portal.
  if (sub?.provider === "stripe" && ["active", "trialing", "past_due", "incomplete"].includes(sub.status)) {
    throw new ApiError(409, "subscription_exists", "Esta organización ya tiene una suscripción. Cambia de plan o cancela desde «Gestionar suscripción».");
  }
  const org = await db.prepare("SELECT trial_used_at FROM organizations WHERE id = ?").bind(t.orgId).first<{ trial_used_at: string | null }>();
  // One free trial per organisation, only for plans that offer it and never after a previous Stripe subscription.
  const trialDays = priceRow?.trial_days && !org?.trial_used_at && sub?.provider !== "stripe" ? priceRow.trial_days : 0;
  const tax = await taxConfig(c.env);
  const user = c.get("user")!;
  const session = await stripeApi<{ id: string; url: string }>(
    c.env,
    c.get("deps"),
    "POST",
    "/checkout/sessions",
    {
      mode: "subscription",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
      ...(tax.mode === "automatic" ? { "automatic_tax[enabled]": true } : tax.taxRateId ? { "line_items[0][dynamic_tax_rates][0]": tax.taxRateId } : {}),
      success_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing?checkout=success`,
      cancel_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing?checkout=cancel`,
      client_reference_id: t.orgId,
      ...(sub?.provider_customer_id ? { customer: sub.provider_customer_id, "customer_update[address]": "auto", "customer_update[name]": "auto" } : { customer_email: user.email }),
      locale: "es",
      allow_promotion_codes: true,
      billing_address_collection: "required",
      "tax_id_collection[enabled]": true,
      payment_method_collection: "always",
      "custom_text[submit][message]": trialDays
        ? `Prueba gratis de ${trialDays} días: no se cobra nada hoy. Te avisaremos por email antes del primer cobro y puedes cancelar en un clic desde DNI Growth.`
        : "Aceptaste las condiciones de contratación en DNI Growth. Puedes cancelar cuando quieras desde la app; el acceso sigue hasta el final del periodo pagado.",
      "metadata[organization_id]": t.orgId,
      "metadata[plan_code]": planCode,
      "metadata[interval]": interval,
      "subscription_data[metadata][organization_id]": t.orgId,
      "subscription_data[metadata][plan_code]": planCode,
      ...(trialDays ? { "subscription_data[trial_period_days]": trialDays, "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel" } : {}),
    },
    `checkout:${t.orgId}:${planCode}:${interval}:${Math.floor(Date.now() / 600_000)}`,
  ).catch(providerError("Stripe no pudo crear la sesión de pago. No se ha realizado ningún cargo."));
  if (!session.url?.startsWith("https://checkout.stripe.com/")) throw new ApiError(502, "provider_error", "Respuesta inesperada de Stripe.");
  await db.batch([
    // Consent to the terms and to the service starting now (the 14-day withdrawal right then lapses), with the terms version.
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "billing.terms_accepted",
      entityType: "subscription",
      after: { termsVersion: TERMS_VERSION, immediateStart: true, planCode, interval },
      requestId: c.get("requestId"),
    }),
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "billing.checkout_start",
      entityType: "subscription",
      after: { planCode, interval, trialDays, sessionId: session.id, mode: stripeMode(c.env), tax: tax.mode },
      requestId: c.get("requestId"),
    }),
  ]);
  return c.json({ url: session.url, trialDays });
});

billing.post("/billing/portal", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  await assertCheckoutAllowed(c);
  await rateLimit(c.env.DB, `portal:${t.orgId}`, 20, 3600);
  const sub = await c.env.DB.prepare("SELECT provider_customer_id FROM subscriptions WHERE organization_id = ? AND provider = 'stripe'").bind(t.orgId).first<{ provider_customer_id: string | null }>();
  if (!sub?.provider_customer_id) throw new ApiError(409, "no_customer", "Esta organización todavía no tiene una suscripción de Stripe.");
  const configuration = await getSetting(c.env.DB, `stripe_portal_config_${stripeMode(c.env)}`);
  const session = await stripeApi<{ url: string }>(c.env, c.get("deps"), "POST", "/billing_portal/sessions", {
    customer: sub.provider_customer_id,
    return_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing`,
    locale: "es",
    ...(configuration ? { configuration } : {}),
  }).catch(providerError("Stripe no pudo abrir el portal de cliente."));
  if (!session.url?.startsWith("https://billing.stripe.com/")) throw new ApiError(502, "provider_error", "Respuesta inesperada de Stripe.");
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "billing.portal_open", entityType: "subscription", requestId: c.get("requestId") }).run();
  return c.json({ url: session.url });
});

/** The organisation's live Stripe subscription, or a clear 409. */
async function requireStripeSub(c: Context<AppEnv>, allowed: string[]): Promise<SubRow & { provider_sub_id: string }> {
  const sub = await subRow(c.env.DB, c.get("tenant").orgId);
  if (!sub || sub.provider !== "stripe" || !sub.provider_sub_id) throw new ApiError(409, "no_subscription", "Esta organización no tiene una suscripción de pago.");
  if (!allowed.includes(sub.status)) throw new ApiError(409, "subscription_state", "Esta acción no está disponible en el estado actual de tu suscripción.");
  return sub as SubRow & { provider_sub_id: string };
}

async function pauseSubscription(c: Context<AppEnv>, sub: SubRow & { provider_sub_id: string }, months: number) {
  const t = c.get("tenant");
  if (sub.paused_until) throw new ApiError(409, "already_paused", "La suscripción ya está en pausa.");
  const resumes = Math.floor((Date.now() + months * 30 * DAY_MS) / 1000);
  await stripeApi(c.env, c.get("deps"), "POST", `/subscriptions/${sub.provider_sub_id}`, { "pause_collection[behavior]": "void", "pause_collection[resumes_at]": resumes }, `pause:${sub.provider_sub_id}:${months}:${Math.floor(Date.now() / DAY_MS)}`).catch(
    providerError("Stripe no pudo pausar la suscripción. No se ha cambiado nada."),
  );
  const pausedUntil = iso(resumes)!;
  // While paused nothing is charged and the paid modules rest; data and settings are kept untouched.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE subscriptions SET paused_until = ?, updated_at = ? WHERE organization_id = ?").bind(pausedUntil, nowIso(), t.orgId),
    c.env.DB.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(t.orgId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "billing.paused", entityType: "subscription", after: { months, pausedUntil }, requestId: c.get("requestId") }),
  ]);
  await trackFromRequest(c, "paused", { organizationId: t.orgId, props: { plan: sub.plan_code, months } });
  return pausedUntil;
}

billing.post("/billing/pause", requireScope("billing:manage"), async (c) => {
  const { months } = await parseBody(c, PauseInput);
  await assertCheckoutAllowed(c);
  await rateLimit(c.env.DB, `billing-change:${c.get("tenant").orgId}`, 10, 3600);
  const sub = await requireStripeSub(c, ["active"]);
  return c.json({ pausedUntil: await pauseSubscription(c, sub, months) });
});

billing.post("/billing/resume", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  await assertCheckoutAllowed(c);
  await rateLimit(c.env.DB, `billing-change:${t.orgId}`, 10, 3600);
  const sub = await requireStripeSub(c, ["active", "past_due"]);
  if (!sub.paused_until) throw new ApiError(409, "not_paused", "La suscripción no está en pausa.");
  await stripeApi(c.env, c.get("deps"), "POST", `/subscriptions/${sub.provider_sub_id}`, { pause_collection: "" }).catch(providerError("Stripe no pudo reanudar la suscripción."));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE subscriptions SET paused_until = NULL, updated_at = ? WHERE organization_id = ?").bind(nowIso(), t.orgId),
    c.env.DB.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(sub.plan_code, t.orgId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "billing.resumed", entityType: "subscription", requestId: c.get("requestId") }),
  ]);
  return c.json({ resumed: true, planCode: sub.plan_code });
});

/**
 * Honest cancellation: one question, at most one offer matching the reason, and cancelling is always
 * one click away. Nothing is deleted: access lasts until the end of the paid period.
 */
billing.post("/billing/cancel", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const input = await parseBody(c, CancelInput);
  await assertCheckoutAllowed(c);
  await rateLimit(db, `billing-change:${t.orgId}`, 10, 3600);
  const sub = await requireStripeSub(c, ["active", "trialing", "past_due"]);
  const reason = CANCEL_REASONS.find((r) => r.key === input.reason)!;
  const deps = c.get("deps");
  let outcome: "discount_applied" | "paused" | "cancel_scheduled";
  let detail: Record<string, unknown>;
  if (input.offer === "discount") {
    if (reason.offer !== "discount" || sub.status !== "active") throw new ApiError(409, "offer_not_available", "Esta oferta no está disponible para tu suscripción.");
    const claimed = await db.prepare("UPDATE organizations SET retention_offer_used_at = ? WHERE id = ? AND retention_offer_used_at IS NULL").bind(nowIso(), t.orgId).run();
    if (!claimed.meta.changes) throw new ApiError(409, "offer_used", "La oferta de permanencia ya se usó en esta organización.");
    try {
      await stripeApi(c.env, deps, "POST", `/subscriptions/${sub.provider_sub_id}`, { "discounts[0][coupon]": RETENTION_DISCOUNT.couponId }, `retention:${t.orgId}`);
    } catch (e) {
      await db.prepare("UPDATE organizations SET retention_offer_used_at = NULL WHERE id = ?").bind(t.orgId).run();
      return providerError("Stripe no pudo aplicar el descuento. No se ha cambiado nada.")(e);
    }
    outcome = "discount_applied";
    detail = { percentOff: RETENTION_DISCOUNT.percentOff, months: RETENTION_DISCOUNT.months };
  } else if (input.offer === "pause") {
    if (sub.status !== "active") throw new ApiError(409, "offer_not_available", "Solo se puede pausar una suscripción activa.");
    outcome = "paused";
    detail = { pausedUntil: await pauseSubscription(c, sub, input.months ?? 1) };
  } else {
    await stripeApi(
      c.env,
      deps,
      "POST",
      `/subscriptions/${sub.provider_sub_id}`,
      { cancel_at_period_end: true, "cancellation_details[feedback]": reason.stripeFeedback, ...(input.comment ? { "cancellation_details[comment]": input.comment } : {}) },
      `cancel:${sub.provider_sub_id}:${Math.floor(Date.now() / 60_000)}`,
    ).catch(providerError("Stripe no pudo programar la cancelación. No se ha cambiado nada."));
    await db.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE organization_id = ?").bind(nowIso(), t.orgId).run();
    outcome = "cancel_scheduled";
    detail = { accessUntil: sub.status === "trialing" ? sub.trial_end : sub.current_period_end };
    await trackFromRequest(c, "canceled", { organizationId: t.orgId, props: { plan: sub.plan_code, reason: input.reason } });
  }
  await db.batch([
    db
      .prepare("INSERT INTO cancellation_feedback (id, organization_id, user_id, reason, comment, offer_shown, outcome, plan_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(uuid(), t.orgId, t.userId, input.reason, input.comment ?? null, reason.offer, outcome, sub.plan_code),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "billing.cancel_flow", entityType: "subscription", after: { reason: input.reason, outcome, ...detail }, requestId: c.get("requestId") }),
  ]);
  return c.json({ outcome, ...detail });
});

billing.post("/billing/cancel/undo", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  await assertCheckoutAllowed(c);
  await rateLimit(c.env.DB, `billing-change:${t.orgId}`, 10, 3600);
  const sub = await requireStripeSub(c, ["active", "trialing", "past_due"]);
  if (!sub.cancel_at_period_end) throw new ApiError(409, "not_scheduled", "No hay ninguna cancelación programada.");
  await stripeApi(c.env, c.get("deps"), "POST", `/subscriptions/${sub.provider_sub_id}`, { cancel_at_period_end: false }).catch(providerError("Stripe no pudo anular la cancelación."));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE subscriptions SET cancel_at_period_end = 0, updated_at = ? WHERE organization_id = ?").bind(nowIso(), t.orgId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "billing.cancel_undone", entityType: "subscription", requestId: c.get("requestId") }),
  ]);
  return c.json({ undone: true });
});

// ── 90-day guarantee ──────────────────────────────────────────────────────────────────────────────
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Organic impressions (Search Console, stored daily) in [from, to]; null when fewer than 20 days are stored. */
async function impressions(db: D1Database, orgId: string, from: string, to: string): Promise<number | null> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS days, COALESCE(SUM(m.impressions), 0) AS impr FROM gsc_daily_metrics m
       JOIN gsc_properties p ON p.organization_id = m.organization_id AND p.id = m.property_id AND p.selected = 1
       WHERE m.organization_id = ? AND m.date BETWEEN ? AND ?`,
    )
    .bind(orgId, from, to)
    .first<{ days: number; impr: number }>();
  return r && r.days >= 20 ? r.impr : null;
}

export async function guaranteeFor(db: D1Database, orgId: string, now = Date.now()): Promise<GuaranteeResult & { claimed: { status: string; refunded_cents: number; created_at: string } | null }> {
  const sub = await subRow(db, orgId);
  const started = sub?.provider === "stripe" ? sub.started_at : null;
  const startMs = started ? Date.parse(started) : NaN;
  const [gsc, articles, critical, claim, breaks] = await Promise.all([
    db.prepare("SELECT MIN(created_at) AS at FROM integrations WHERE organization_id = ? AND provider = 'google_search_console' AND status = 'connected'").bind(orgId).first<{ at: string | null }>(),
    started
      ? db
          .prepare("SELECT COUNT(*) AS proposed, SUM(status = 'approved') AS approved FROM content_items WHERE organization_id = ? AND kind = 'blog_article' AND created_at >= ?")
          .bind(orgId, started)
          .first<{ proposed: number; approved: number | null }>()
      : null,
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM seo_issues i WHERE i.organization_id = ? AND i.severity = 'critical' AND i.status = 'open'
           AND i.crawl_id = (SELECT w.id FROM web_crawls w WHERE w.organization_id = ? AND w.completed_at IS NOT NULL ORDER BY w.completed_at DESC LIMIT 1)`,
      )
      .bind(orgId, orgId)
      .first<{ n: number }>(),
    db.prepare("SELECT status, refunded_cents, created_at FROM guarantee_claims WHERE organization_id = ?").bind(orgId).first<{ status: string; refunded_cents: number; created_at: string }>(),
    // Continuity: a pause (direct or from the cancellation flow) or the end of a grace period breaks the 90 days.
    started
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND created_at >= ?
               AND (action IN ('billing.paused', 'billing.grace_expired') OR (action = 'billing.cancel_flow' AND after_redacted LIKE '%"outcome":"paused"%'))`,
          )
          .bind(orgId, started)
          .first<{ n: number }>()
      : null,
  ]);
  const day90 = Number.isFinite(startMs) ? startMs + GUARANTEE.days * DAY_MS : NaN;
  const evalEnd = Number.isFinite(day90) ? Math.min(now, day90) : now;
  const baseline = Number.isFinite(startMs) ? await impressions(db, orgId, isoDay(startMs - GUARANTEE.windowDays * DAY_MS), isoDay(startMs - DAY_MS)) : null;
  const current = Number.isFinite(startMs) ? await impressions(db, orgId, isoDay(evalEnd - GUARANTEE.windowDays * DAY_MS), isoDay(evalEnd - DAY_MS)) : null;
  const result = evaluateGuarantee({
    planCode: sub?.plan_code ?? "free",
    subscribedSince: started,
    canceled: !sub || sub.status === "canceled" || !!sub.cancel_at_period_end,
    interrupted: !!sub?.paused_until || (breaks?.n ?? 0) > 0,
    now: new Date(now).toISOString(),
    gscConnectedAt: gsc?.at ?? null,
    articlesProposed: articles?.proposed ?? 0,
    articlesApproved: articles?.approved ?? 0,
    criticalOpen: critical?.n ?? 0,
    baselineImpressions: baseline,
    currentImpressions: current,
  });
  return { ...result, claimed: claim ?? null };
}

billing.get("/billing/guarantee", requireScope("billing:read"), async (c) => {
  const g = await guaranteeFor(c.env.DB, c.get("tenant").orgId);
  return c.json({ ...g, source: "Google Search Console (impresiones orgánicas, datos diarios guardados)", windowDays: GUARANTEE.windowDays, terms: "/legal/garantia" });
});

/** Refund of everything paid since the subscription started, when the guarantee applies. One claim per organisation. */
billing.post("/billing/guarantee/claim", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  await assertCheckoutAllowed(c);
  await rateLimit(db, `guarantee:${t.orgId}`, 5, 3600);
  const g = await guaranteeFor(db, t.orgId);
  if (g.claimed) throw new ApiError(409, "already_claimed", "La garantía ya se solicitó para esta organización.");
  if (g.status !== "refund_available") throw new ApiError(409, "guarantee_not_available", "La garantía no aplica todavía: revisa los requisitos y la evolución de impresiones.");
  const sub = await requireStripeSub(c, ["active", "trialing", "past_due"]);
  const deps = c.get("deps");
  const since = Math.floor(Date.parse(sub.started_at ?? nowIso()) / 1000) - 86_400;
  const refundIds: string[] = [];
  let refunded = 0;
  try {
    const invoices = await stripeApi<{ data: Array<{ id: string; amount_paid: number; created: number; status: string }> }>(c.env, deps, "GET", "/invoices", {
      customer: sub.provider_customer_id ?? "",
      subscription: sub.provider_sub_id,
      status: "paid",
      limit: 100,
    });
    for (const inv of invoices.data.filter((i) => i.amount_paid > 0 && i.created >= since)) {
      const payments = await stripeApi<{ data: Array<{ payment?: { payment_intent?: string | null; charge?: string | null }; status?: string }> }>(c.env, deps, "GET", "/invoice_payments", { invoice: inv.id, limit: 10 });
      for (const p of payments.data.filter((x) => x.status === "paid")) {
        const target = p.payment?.payment_intent ? { payment_intent: p.payment.payment_intent } : p.payment?.charge ? { charge: p.payment.charge } : null;
        if (!target) continue;
        const r = await stripeApi<{ id: string; amount: number }>(c.env, deps, "POST", "/refunds", { ...target, reason: "requested_by_customer", "metadata[organization_id]": t.orgId, "metadata[reason]": "garantia_90_dias" }, `guarantee-refund:${inv.id}`);
        refundIds.push(r.id);
        refunded += r.amount;
      }
    }
    await stripeApi(c.env, deps, "DELETE", `/subscriptions/${sub.provider_sub_id}`, {});
  } catch (e) {
    await db
      .prepare("INSERT OR IGNORE INTO guarantee_claims (id, organization_id, requested_by, status, baseline_impressions, current_impressions, refunded_cents, refund_ids_json) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)")
      .bind(uuid(), t.orgId, t.userId, g.baselineImpressions, g.currentImpressions, refunded, JSON.stringify(refundIds))
      .run();
    log("error", "billing.guarantee_refund_failed", { error: e instanceof StripeApiError ? e.code : String(e).slice(0, 80) });
    throw new ApiError(502, "provider_error", "Stripe no pudo completar el reembolso. Lo revisamos y te escribimos; no tienes que hacer nada más.");
  }
  await db.batch([
    db
      .prepare("INSERT INTO guarantee_claims (id, organization_id, requested_by, status, baseline_impressions, current_impressions, refunded_cents, refund_ids_json) VALUES (?, ?, ?, 'refunded', ?, ?, ?, ?)")
      .bind(uuid(), t.orgId, t.userId, g.baselineImpressions, g.currentImpressions, refunded, JSON.stringify(refundIds)),
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "billing.guarantee_refund",
      entityType: "subscription",
      after: { refundedCents: refunded, refunds: refundIds.length, baseline: g.baselineImpressions, current: g.currentImpressions },
      requestId: c.get("requestId"),
    }),
  ]);
  await notifyBilling(c.env, t.orgId, `guarantee:${t.orgId}`, "Hemos tramitado el reembolso de tu garantía", [
    `Las impresiones orgánicas no subieron en tus primeros 90 días, así que te devolvemos ${(refunded / 100).toFixed(2).replace(".", ",")} € (impuestos incluidos) a tu método de pago.`,
    "La suscripción queda cancelada. Tus datos siguen disponibles en el plan Free.",
  ]);
  return c.json({ refundedCents: refunded, refunds: refundIds.length });
});

/**
 * Stripe webhook: signature verified on the RAW body, provider_event_id UNIQUE for idempotency,
 * live/test mode must match the configured key, and older events never overwrite newer state.
 * Returns 2xx only after the event is persisted.
 */
/**
 * Public, unauthenticated: whether real payments are open. Only true with a live key, payments switched on
 * and an account Stripe allows to charge; the pricing page never claims more than this.
 */
export const billingPublic = new Hono<AppEnv>();
billingPublic.get("/pricing-status", async (c) => {
  const paymentsOpen = stripeMode(c.env) === "live" && billingAccess(c.env) === "open" && (await stripeReady(c.env));
  c.header("cache-control", "public, max-age=300");
  return c.json({ paymentsOpen });
});

export const webhooks = new Hono<AppEnv>();

const SUB_STATUSES = ["active", "trialing", "past_due", "canceled", "incomplete"];
const mapStatus = (s: string) => (s === "unpaid" || s === "incomplete_expired" ? "canceled" : s === "paused" ? "past_due" : SUB_STATUSES.includes(s) ? s : "incomplete");
const SUB_SYNC_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.paused", "customer.subscription.resumed"]);

webhooks.post("/stripe", async (c) => {
  if (!(await webhooksAcceptedAsync(c.env))) {
    if ((billingEnabled(c.env) || stripeMode(c.env)) && !(await webhookSecrets(c.env)).length) throw new ApiError(503, "provider_not_configured", "Stripe no configurado.");
    throw billingDisabled();
  }
  const raw = await c.req.text();
  if (raw.length > 512_000) throw new ApiError(413, "payload_too_large", "Payload demasiado grande.");
  const sig = c.req.header("stripe-signature") ?? null;
  let v: Awaited<ReturnType<typeof verifyStripeSignature>> = { ok: false, reason: "no_secret" } as Awaited<ReturnType<typeof verifyStripeSignature>>;
  for (const secret of await webhookSecrets(c.env)) {
    v = await verifyStripeSignature(raw, sig, secret);
    if (v.ok) break;
  }
  if (!v.ok) {
    log("warn", "stripe.webhook_rejected", { reason: v.reason });
    throw new ApiError(400, "invalid_signature", "Firma no válida.");
  }
  const event = JSON.parse(raw) as { id: string; type: string; created?: number; livemode?: boolean; data: { object: Record<string, unknown> } };
  if (typeof event.id !== "string" || typeof event.type !== "string") throw new ApiError(400, "invalid_event", "Evento no válido.");
  const mode = stripeMode(c.env);
  if (typeof event.livemode === "boolean" && mode && event.livemode !== (mode === "live")) {
    log("warn", "stripe.webhook_mode_mismatch", { type: event.type });
    return c.json({ received: true, ignored: "mode_mismatch" });
  }
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, provider, provider_event_id, type) VALUES (?, 'stripe', ?, ?)").bind(uuid(), event.id, event.type).run();
  if (!ins.meta.changes) return c.json({ received: true, duplicate: true });

  try {
    const db = c.env.DB;
    const obj = event.data.object;
    const meta = (obj["metadata"] ?? {}) as Record<string, string>;
    const created = typeof event.created === "number" ? event.created : Math.floor(Date.now() / 1000);
    const customerId = typeof obj["customer"] === "string" ? (obj["customer"] as string) : null;
    let orgId: string | undefined = meta["organization_id"] ?? (typeof obj["client_reference_id"] === "string" ? (obj["client_reference_id"] as string) : undefined);
    if (!orgId && customerId) {
      orgId = (await db.prepare("SELECT organization_id FROM subscriptions WHERE provider_customer_id = ?").bind(customerId).first<{ organization_id: string }>())?.organization_id;
    }
    let handled = false;
    const isSubEvent = SUB_SYNC_EVENTS.has(event.type);
    const now = nowIso();
    if (orgId && (event.type === "checkout.session.completed" || isSubEvent)) {
      // The plan comes from the subscribed price (portal plan/interval changes), falling back to our own metadata.
      const items = (obj["items"] as { data?: Array<{ price?: { id?: string; recurring?: { interval?: string } }; current_period_end?: number }> } | undefined)?.data ?? [];
      const priceId = items[0]?.price?.id;
      const byPrice = priceId
        ? await db.prepare("SELECT code, CASE WHEN stripe_price_id_year = ? THEN 'year' ELSE 'month' END AS interval FROM plans WHERE stripe_price_id = ? OR stripe_price_id_year = ?").bind(priceId, priceId, priceId).first<{ code: string; interval: string }>()
        : null;
      const planCode = byPrice?.code ?? meta["plan_code"];
      const interval = items[0]?.price?.recurring?.interval ?? byPrice?.interval ?? meta["interval"] ?? null;
      const org = await db.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first();
      const plan = org && planCode ? await getPlan(db, planCode).catch(() => null) : null;
      const prev = await db
        .prepare("SELECT provider_event_at, payment_failed_at, grace_until, status, plan_code, provider FROM subscriptions WHERE organization_id = ?")
        .bind(orgId)
        .first<{ provider_event_at: number | null; payment_failed_at: string | null; grace_until: string | null; status: string | null; plan_code: string | null; provider: string | null }>();
      const stale = isSubEvent && typeof prev?.provider_event_at === "number" && prev.provider_event_at > created;
      if (org && plan && planCode && !stale) {
        const subId = (event.type === "checkout.session.completed" ? obj["subscription"] : obj["id"]) as string | undefined;
        const status = event.type === "checkout.session.completed" ? "active" : mapStatus(String(obj["status"] ?? "active"));
        const periodEndRaw = typeof obj["current_period_end"] === "number" ? (obj["current_period_end"] as number) : items[0]?.current_period_end;
        const periodEnd = iso(periodEndRaw);
        const pause = isSubEvent ? (obj["pause_collection"] as { resumes_at?: number } | null | undefined) : undefined;
        const pausedUntil = pause ? (iso(pause.resumes_at) ?? "indefinite") : null;
        const trialEnd = isSubEvent && status === "trialing" ? iso(obj["trial_end"]) : null;
        // Failed payment: access continues for a 7-day grace period (nothing is deleted), then Free until paid.
        const failedAt = status === "past_due" ? (prev?.payment_failed_at ?? now) : null;
        const graceUntil = status === "past_due" ? (prev?.grace_until ?? new Date(Date.parse(failedAt!) + GRACE_DAYS * DAY_MS).toISOString()) : null;
        const inGrace = status === "past_due" && !!graceUntil && Date.parse(graceUntil) > Date.now();
        const paid = ((status === "active" || status === "trialing") && !pausedUntil) || (inGrace && !pausedUntil);
        const cancelScheduled = isSubEvent && (obj["cancel_at_period_end"] === true || typeof obj["cancel_at"] === "number") ? 1 : 0;
        await db.batch([
          db
            .prepare(
              `INSERT INTO subscriptions (id, organization_id, plan_code, provider, provider_sub_id, provider_customer_id, status, current_period_end, provider_event_at, cancel_at_period_end,
                 billing_interval, trial_end, paused_until, payment_failed_at, grace_until, started_at)
               VALUES (?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(organization_id) DO UPDATE SET plan_code = excluded.plan_code, provider = 'stripe',
                 provider_sub_id = COALESCE(excluded.provider_sub_id, subscriptions.provider_sub_id),
                 provider_customer_id = COALESCE(excluded.provider_customer_id, subscriptions.provider_customer_id),
                 status = excluded.status, current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end),
                 provider_event_at = MAX(COALESCE(subscriptions.provider_event_at, 0), excluded.provider_event_at),
                 cancel_at_period_end = CASE WHEN ? THEN excluded.cancel_at_period_end ELSE subscriptions.cancel_at_period_end END,
                 billing_interval = COALESCE(excluded.billing_interval, subscriptions.billing_interval),
                 trial_end = CASE WHEN ? THEN excluded.trial_end ELSE subscriptions.trial_end END,
                 paused_until = CASE WHEN ? THEN excluded.paused_until ELSE subscriptions.paused_until END,
                 payment_failed_at = excluded.payment_failed_at, grace_until = excluded.grace_until,
                 started_at = CASE WHEN subscriptions.status = 'canceled' OR subscriptions.provider <> 'stripe' THEN excluded.started_at ELSE COALESCE(subscriptions.started_at, excluded.started_at) END,
                 updated_at = ?`,
            )
            .bind(
              uuid(),
              orgId,
              planCode,
              subId ?? null,
              customerId,
              status,
              periodEnd,
              created,
              cancelScheduled,
              interval,
              trialEnd,
              pausedUntil,
              failedAt,
              graceUntil,
              paid ? now : null,
              isSubEvent ? 1 : 0,
              isSubEvent ? 1 : 0,
              isSubEvent ? 1 : 0,
              now,
            ),
          db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(paid ? planCode : "free", orgId),
          ...(status === "trialing" ? [db.prepare("UPDATE organizations SET trial_used_at = COALESCE(trial_used_at, ?) WHERE id = ?").bind(now, orgId)] : []),
          ...(paid ? [grantStmt(db, orgId, plan.limits.monthlyCredits, `grant:${orgId}:${monthKey()}:${planCode}`, "plan_upgrade", "stripe")] : []),
          auditStmt(db, { organizationId: orgId, actorUserId: null, action: "billing.subscription_sync", entityType: "subscription", after: { planCode, status, interval, paused: !!pausedUntil, eventId: event.id } }),
        ]);
        // Product funnel (cookieless, no personal data): first trial, first paid period, plan upgrades.
        const wasStripe = prev?.provider === "stripe" && prev.status !== "canceled";
        const props = { plan: planCode, interval: interval ?? "month" };
        if (status === "trialing" && !(wasStripe && prev?.status === "trialing")) await trackEvent(db, { event: "trial_started", organizationId: orgId, props });
        else if (status === "active" && !(wasStripe && prev?.status === "active")) await trackEvent(db, { event: "subscribed", organizationId: orgId, props });
        else if (status === "active" && wasStripe && prev?.status === "active" && prev.plan_code && prev.plan_code !== planCode) {
          const rank = (code: string) => PLAN_OFFERS.findIndex((o) => o.code === code);
          if (rank(planCode) > rank(prev.plan_code)) await trackEvent(db, { event: "upgraded", organizationId: orgId, props: { ...props, from: prev.plan_code } });
        }
        handled = true;
      } else if (stale) handled = true;
    } else if (orgId && event.type === "customer.subscription.deleted") {
      await db.batch([
        db
          .prepare("UPDATE subscriptions SET status = 'canceled', plan_code = 'free', cancel_at_period_end = 0, paused_until = NULL, payment_failed_at = NULL, grace_until = NULL, provider_event_at = ?, updated_at = ? WHERE organization_id = ?")
          .bind(created, now, orgId),
        db.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(orgId),
        auditStmt(db, { organizationId: orgId, actorUserId: null, action: "billing.subscription_canceled", entityType: "subscription", after: { eventId: event.id } }),
      ]);
      handled = true;
    } else if (orgId && event.type === "invoice.payment_failed") {
      const r = await db
        .prepare("UPDATE subscriptions SET payment_failed_at = COALESCE(payment_failed_at, ?), grace_until = COALESCE(grace_until, ?), updated_at = ? WHERE organization_id = ? AND provider = 'stripe'")
        .bind(now, new Date(Date.now() + GRACE_DAYS * DAY_MS).toISOString(), now, orgId)
        .run();
      const g = await db.prepare("SELECT grace_until FROM subscriptions WHERE organization_id = ?").bind(orgId).first<{ grace_until: string | null }>();
      await auditStmt(db, { organizationId: orgId, actorUserId: null, action: "billing.payment_failed", entityType: "subscription", after: { eventId: event.id, attempt: obj["attempt_count"] ?? null } }).run();
      if (r.meta.changes && g?.grace_until)
        await notifyBilling(c.env, orgId, `payment-failed:${String(obj["id"] ?? event.id)}:${String(obj["attempt_count"] ?? 1)}`, "No hemos podido cobrar tu suscripción de DNI Growth", [
          "El último cobro de tu suscripción no se ha podido completar. Stripe lo reintentará automáticamente en los próximos días.",
          `Tu cuenta sigue funcionando con normalidad hasta el ${fmtDate(g.grace_until)}. Si para entonces no se ha cobrado, pasará al plan Free sin borrar nada.`,
          "Para evitarlo, actualiza tu tarjeta desde «Gestionar suscripción».",
        ]);
      handled = true;
    } else if (orgId && event.type === "invoice.paid") {
      const amountPaid = typeof obj["amount_paid"] === "number" ? (obj["amount_paid"] as number) : 0;
      const sub = await db.prepare("SELECT plan_code, status, paused_until FROM subscriptions WHERE organization_id = ? AND provider = 'stripe'").bind(orgId).first<{ plan_code: string; status: string; paused_until: string | null }>();
      await db.batch([
        db
          .prepare("UPDATE subscriptions SET payment_failed_at = NULL, grace_until = NULL, started_at = COALESCE(started_at, ?), updated_at = ? WHERE organization_id = ? AND provider = 'stripe'")
          .bind(amountPaid > 0 ? now : null, now, orgId),
        ...(sub && sub.status !== "canceled" && !sub.paused_until ? [db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(sub.plan_code, orgId)] : []),
        auditStmt(db, { organizationId: orgId, actorUserId: null, action: "billing.invoice_paid", entityType: "subscription", after: { eventId: event.id, amountPaid } }),
      ]);
      handled = true;
    } else if (orgId && event.type === "customer.subscription.trial_will_end") {
      const trialEnd = iso(obj["trial_end"]);
      if (trialEnd)
        await notifyBilling(c.env, orgId, `trial-3d:${orgId}:${trialEnd.slice(0, 10)}`, "Tu prueba gratis de DNI Growth termina pronto", [
          `Tu prueba gratis termina el ${fmtDate(trialEnd)}. Ese día se hará el primer cobro con la tarjeta que indicaste, según el plan que elegiste (IVA aparte).`,
          "Si no quieres continuar, cancela en un clic desde Facturación antes de esa fecha y no se te cobrará nada.",
        ]);
      handled = true;
    }
    await db.prepare("UPDATE webhook_events SET status = ?, processed_at = ? WHERE provider = 'stripe' AND provider_event_id = ?").bind(handled ? "processed" : "ignored", nowIso(), event.id).run();
    return c.json({ received: true });
  } catch (e) {
    // Remove the idempotency marker so Stripe's retry can be processed again.
    await c.env.DB.prepare("DELETE FROM webhook_events WHERE provider = 'stripe' AND provider_event_id = ?").bind(event.id).run();
    log("error", "stripe.webhook_failed", { type: event.type, error: String(e).slice(0, 200) });
    throw new ApiError(500, "webhook_processing_failed", "Error procesando el evento.");
  }
});

/**
 * Cron (every few minutes): grace periods that expired move to Free (nothing deleted) and trials ending
 * within 24 h get a second reminder. Idempotent: each notice has its own key.
 */
export async function billingMaintenance(env: Env): Promise<{ downgraded: number; reminders: number }> {
  const db = env.DB;
  const last = await getSetting(db, "billing_maintenance_last");
  if (last && Date.now() - Date.parse(last) < 10 * 60_000) return { downgraded: 0, reminders: 0 };
  await setSetting(db, "billing_maintenance_last", nowIso());
  const now = nowIso();
  const { results: expired } = await db
    .prepare(
      `SELECT s.organization_id FROM subscriptions s JOIN organizations o ON o.id = s.organization_id
       WHERE s.provider = 'stripe' AND s.status = 'past_due' AND s.grace_until IS NOT NULL AND s.grace_until < ? AND o.plan_code <> 'free'`,
    )
    .bind(now)
    .all<{ organization_id: string }>();
  for (const r of expired) {
    await db.batch([
      db.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(r.organization_id),
      auditStmt(db, { organizationId: r.organization_id, actorUserId: null, action: "billing.grace_expired", entityType: "subscription" }),
    ]);
    await notifyBilling(env, r.organization_id, `grace-expired:${r.organization_id}:${now.slice(0, 10)}`, "Tu cuenta de DNI Growth ha pasado al plan Free", [
      "No hemos podido cobrar tu suscripción en los últimos 7 días, así que la cuenta ha pasado al plan Free. No hemos borrado nada.",
      "En cuanto se complete el pago (actualiza tu tarjeta desde «Gestionar suscripción»), recuperas tu plan automáticamente.",
    ]);
  }
  const soon = new Date(Date.now() + DAY_MS).toISOString();
  const { results: trials } = await db
    .prepare("SELECT organization_id, trial_end FROM subscriptions WHERE provider = 'stripe' AND status = 'trialing' AND cancel_at_period_end = 0 AND trial_end IS NOT NULL AND trial_end > ? AND trial_end <= ?")
    .bind(now, soon)
    .all<{ organization_id: string; trial_end: string }>();
  for (const t of trials)
    await notifyBilling(env, t.organization_id, `trial-1d:${t.organization_id}:${t.trial_end.slice(0, 10)}`, "Mañana termina tu prueba gratis de DNI Growth", [
      `Tu prueba gratis termina el ${fmtDate(t.trial_end)} y ese día se hará el primer cobro (IVA aparte).`,
      "Si prefieres no continuar, cancela en un clic desde Facturación y no se te cobrará nada.",
    ]);
  // Safety net: a subscription the customer already cancelled must end with its period even if Stripe's
  // "deleted" event never arrives (lost webhook, or a test-mode subscription after switching to live keys).
  // Two days of margin so the real webhook always wins.
  const { results: ended } = await db
    .prepare(
      `SELECT organization_id FROM subscriptions WHERE provider = 'stripe' AND status IN ('active','trialing','past_due')
       AND cancel_at_period_end = 1 AND current_period_end IS NOT NULL AND current_period_end < ?`,
    )
    .bind(new Date(Date.now() - 2 * DAY_MS).toISOString())
    .all<{ organization_id: string }>();
  for (const e of ended)
    await db.batch([
      db
        .prepare("UPDATE subscriptions SET status = 'canceled', plan_code = 'free', cancel_at_period_end = 0, paused_until = NULL, payment_failed_at = NULL, grace_until = NULL, updated_at = ? WHERE organization_id = ? AND cancel_at_period_end = 1")
        .bind(now, e.organization_id),
      db.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(e.organization_id),
      auditStmt(db, { organizationId: e.organization_id, actorUserId: null, action: "billing.period_ended", entityType: "subscription", after: { reason: "cancelled_at_period_end_without_webhook" } }),
    ]);
  return { downgraded: expired.length + ended.length, reminders: trials.length };
}

function emailEntry(env: Env): ProviderManifestEntry {
  const mode = mailMode(env);
  const base = { key: "email", name: "Email transaccional (Cloudflare Email Service)", category: "Comunicación" };
  if (mode === "enabled") return { ...base, status: "connected", note: "Envío activo mediante el binding send_email; cola con reintentos." };
  if (mode === "dev_mailbox") return { ...base, status: "demo", note: "Buzón de desarrollo local (no envía correos)." };
  return { ...base, status: "not_configured", note: "Falta un dominio remitente verificado en Cloudflare Email Service: los correos no se envían." };
}

/** Honest provider manifest — nothing is shown as connected unless it really is. */
export function providerManifest(env: Env): ProviderManifestEntry[] {
  return [
    {
      key: "stripe",
      name: "Stripe (pagos)",
      category: "Facturación",
      status: stripeMode(env) ? (stripeMode(env) === "live" && billingFlag(env) ? "connected" : "demo") : "not_configured",
      note: stripeMode(env) ? ACCESS_NOTE[billingAccess(env)] : "Falta STRIPE_SECRET_KEY.",
    },
    emailEntry(env),
    { key: "crawler", name: "Rastreador público DNIGrowthBot", category: "Auditoría", status: "connected", note: "Funciona sin credenciales: solo HTML público, respeta robots.txt." },
    {
      key: "workers_ai",
      name: "IA DNI Growth (motores gratuitos con respaldo automático)",
      category: "IA",
      status: env.AI ? "connected" : "not_configured",
      note: env.AI ? "Asesor y generación de imágenes con presupuesto diario y respaldo automático entre modelos." : "Falta el binding AI en wrangler.jsonc.",
    },
    {
      key: "google_search_console",
      name: "Google Search Console",
      category: "Datos",
      status: gscReady(env) ? "available" : "not_configured",
      note: gscReady(env) ? "Disponible: conecta tu cuenta de Google (solo lectura) desde «Search Console»." : "Falta la configuración de Google (cliente OAuth y clave de cifrado).",
    },
    {
      key: "ga4",
      name: "Google Analytics 4",
      category: "Datos",
      status: gscReady(env) ? "available" : "not_configured",
      note: gscReady(env) ? "Disponible: conecta tu cuenta de Google (solo lectura) desde «Analytics»." : "Falta la configuración de Google (cliente OAuth y clave de cifrado).",
    },
    { key: "keywords", name: "Proveedor de keywords/SERP", category: "SEO", status: "planned", note: "Sin proveedor no se muestran volúmenes ni dificultad." },
    { key: "wordpress", name: "WordPress", category: "CMS", status: "planned", note: "Publicación solo tras aprobación; export HTML/Markdown sin credenciales." },
    { key: "geo_monitor", name: "Monitor de visibilidad en IA", category: "GEO", status: "planned", note: "Solo mediante APIs oficiales; muestreo, no cobertura total." },
    { key: "meta_ads", name: "Meta Ads", category: "Publicidad", status: "blocked_external_approval", note: "Requiere app de Meta con ads_management/ads_read y revisión de la app." },
    { key: "google_ads", name: "Google Ads", category: "Publicidad", status: "blocked_external_approval", note: "Requiere developer token aprobado." },
    { key: "whatsapp", name: "WhatsApp Business", category: "CRM", status: "planned", note: "Plantillas aprobadas y opt-in obligatorio." },
  ];
}
