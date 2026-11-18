import { gscReady } from "../lib/gsc";
import { Hono, type Context } from "hono";
import { CheckoutInput, verifyStripeSignature, type ProviderManifestEntry } from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { creditBalance, ensureMonthlyGrant, getPlan, grantStmt, orgPlan } from "../lib/billing";
import { ApiError, parseBody } from "../lib/http";
import { mailMode } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { billingAccess, billingFlag, getSetting, stripeApi, StripeApiError, stripeMode, stripeReady, webhookSecrets, webhooksAcceptedAsync, type BillingAccess } from "../lib/stripe";
import { log, monthKey, nowIso, uuid } from "../lib/util";
import { isPlatformAdmin, requireScope } from "../middleware";

/** Key + webhook secret (owner-provided or platform-managed, see lib/stripe.ts). */
export const stripeConfigured = (env: Env) => stripeReady(env);
/** Payments for everyone only when the owner flips BILLING_ENABLED="true"; test keys allow platform-admin checkouts. */
export const billingEnabled = billingFlag;
const billingDisabled = () => new ApiError(503, "billing_disabled", "Los pagos todavía no están activados en DNI Growth. No se ha realizado ningún cargo.");

const ACCESS_NOTE: Record<BillingAccess, string> = {
  not_configured: "Stripe no está conectado: no se puede pagar y no se realiza ningún cargo.",
  off: "Los pagos están desactivados por la plataforma: no se realiza ningún cargo.",
  test_admin_only: "Modo prueba de Stripe: solo administradores de la plataforma pueden abrir el pago, con tarjetas de prueba. Nadie paga dinero real.",
  open: "Pagos activos con Stripe.",
};

/** Tenant billing routes (mounted under /orgs/:orgId). */
export const billing = new Hono<AppEnv>();

billing.get("/billing", requireScope("billing:read"), async (c) => {
  const t = c.get("tenant");
  const plan = await orgPlan(c.env.DB, t.orgId);
  await ensureMonthlyGrant(c.env.DB, t.orgId, plan);
  const [sub, ledger, plans, balance, admin] = await Promise.all([
    c.env.DB.prepare(
      "SELECT plan_code, provider, status, current_period_end, updated_at, provider_customer_id IS NOT NULL AS has_customer, cancel_at_period_end FROM subscriptions WHERE organization_id = ?",
    )
      .bind(t.orgId)
      .first(),
    c.env.DB.prepare("SELECT id, job_id, category, amount, entry_kind, provider, created_at FROM credit_ledger WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").bind(t.orgId).all(),
    c.env.DB.prepare("SELECT code, name, price_eur_month, limits_json, stripe_price_id IS NOT NULL AS purchasable FROM plans WHERE active = 1 ORDER BY position").all(),
    creditBalance(c.env.DB, t.orgId),
    isPlatformAdmin(c.env, c.get("user") ?? null),
  ]);
  const access = billingAccess(c.env);
  const configured = await stripeConfigured(c.env);
  const canCheckout = configured && (access === "open" || (access === "test_admin_only" && admin));
  return c.json({
    plan,
    subscription: sub,
    balance,
    ledger: ledger.results,
    plans: plans.results,
    stripe: { enabled: billingEnabled(c.env), configured, mode: stripeMode(c.env) ?? "none", access, canCheckout, note: ACCESS_NOTE[access] },
    notes: ["Precios sin IVA. El gasto publicitario (cuando exista) se factura aparte y nunca se mezcla con la cuota del software."],
  });
});

/** Throws unless this user may open a Stripe checkout/portal right now. */
async function assertCheckoutAllowed(c: Context<AppEnv>) {
  const access = billingAccess(c.env);
  if (access === "off") throw billingDisabled();
  if (access === "not_configured" || !(await stripeConfigured(c.env))) {
    if (!billingEnabled(c.env) && access === "not_configured") throw billingDisabled();
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
  const { planCode } = await parseBody(c, CheckoutInput);
  await assertCheckoutAllowed(c);
  await rateLimit(c.env.DB, `checkout:${t.orgId}`, 10, 3600);
  const priceRow = await c.env.DB.prepare("SELECT stripe_price_id FROM plans WHERE code = ? AND active = 1").bind(planCode).first<{ stripe_price_id: string | null }>();
  if (!priceRow?.stripe_price_id) throw new ApiError(503, "price_not_configured", "Este plan aún no tiene precio configurado en Stripe.");
  const sub = await c.env.DB.prepare("SELECT status, provider, provider_customer_id FROM subscriptions WHERE organization_id = ?")
    .bind(t.orgId)
    .first<{ status: string; provider: string; provider_customer_id: string | null }>();
  // Never open a second paid subscription for the same organisation: plan changes go through the portal.
  if (sub?.provider === "stripe" && ["active", "trialing", "past_due", "incomplete"].includes(sub.status)) {
    throw new ApiError(409, "subscription_exists", "Esta organización ya tiene una suscripción. Cambia de plan o cancela desde «Gestionar suscripción».");
  }
  const user = c.get("user")!;
  const session = await stripeApi<{ id: string; url: string }>(
    c.env,
    c.get("deps"),
    "POST",
    "/checkout/sessions",
    {
      mode: "subscription",
      "line_items[0][price]": priceRow.stripe_price_id,
      "line_items[0][quantity]": 1,
      success_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing?checkout=success`,
      cancel_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing?checkout=cancel`,
      client_reference_id: t.orgId,
      ...(sub?.provider_customer_id ? { customer: sub.provider_customer_id, "customer_update[address]": "auto", "customer_update[name]": "auto" } : { customer_email: user.email }),
      locale: "es",
      allow_promotion_codes: true,
      billing_address_collection: "required",
      "tax_id_collection[enabled]": true,
      "metadata[organization_id]": t.orgId,
      "metadata[plan_code]": planCode,
      "subscription_data[metadata][organization_id]": t.orgId,
      "subscription_data[metadata][plan_code]": planCode,
    },
    `checkout:${t.orgId}:${planCode}:${Math.floor(Date.now() / 600_000)}`,
  ).catch(providerError("Stripe no pudo crear la sesión de pago. No se ha realizado ningún cargo."));
  if (!session.url?.startsWith("https://checkout.stripe.com/")) throw new ApiError(502, "provider_error", "Respuesta inesperada de Stripe.");
  await auditStmt(c.env.DB, {
    organizationId: t.orgId,
    actorUserId: t.userId,
    action: "billing.checkout_start",
    entityType: "subscription",
    after: { planCode, sessionId: session.id, mode: stripeMode(c.env) },
    requestId: c.get("requestId"),
  }).run();
  return c.json({ url: session.url });
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

/**
 * Stripe webhook: signature verified on the RAW body, provider_event_id UNIQUE for idempotency,
 * live/test mode must match the configured key, and older events never overwrite newer state.
 * Returns 2xx only after the event is persisted.
 */
export const webhooks = new Hono<AppEnv>();

const SUB_STATUSES = ["active", "trialing", "past_due", "canceled", "incomplete"];
const mapStatus = (s: string) => (s === "unpaid" || s === "incomplete_expired" ? "canceled" : s === "paused" ? "past_due" : SUB_STATUSES.includes(s) ? s : "incomplete");

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
    const isSubEvent = event.type === "customer.subscription.created" || event.type === "customer.subscription.updated";
    if (orgId && (event.type === "checkout.session.completed" || isSubEvent)) {
      // The plan comes from the subscribed price (portal plan changes), falling back to our own metadata.
      const items = (obj["items"] as { data?: Array<{ price?: { id?: string }; current_period_end?: number }> } | undefined)?.data ?? [];
      const priceId = items[0]?.price?.id;
      const byPrice = priceId ? await db.prepare("SELECT code FROM plans WHERE stripe_price_id = ?").bind(priceId).first<{ code: string }>() : null;
      const planCode = byPrice?.code ?? meta["plan_code"];
      const org = await db.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first();
      const plan = org && planCode ? await getPlan(db, planCode).catch(() => null) : null;
      const prev = await db.prepare("SELECT provider_event_at FROM subscriptions WHERE organization_id = ?").bind(orgId).first<{ provider_event_at: number | null }>();
      const stale = isSubEvent && typeof prev?.provider_event_at === "number" && prev.provider_event_at > created;
      if (org && plan && planCode && !stale) {
        const subId = (event.type === "checkout.session.completed" ? obj["subscription"] : obj["id"]) as string | undefined;
        const status = event.type === "checkout.session.completed" ? "active" : mapStatus(String(obj["status"] ?? "active"));
        const periodEndRaw = typeof obj["current_period_end"] === "number" ? (obj["current_period_end"] as number) : items[0]?.current_period_end;
        const periodEnd = typeof periodEndRaw === "number" ? new Date(periodEndRaw * 1000).toISOString() : null;
        const paid = status === "active" || status === "trialing";
        const cancelScheduled = isSubEvent && (obj["cancel_at_period_end"] === true || typeof obj["cancel_at"] === "number") ? 1 : 0;
        await db.batch([
          db
            .prepare(
              `INSERT INTO subscriptions (id, organization_id, plan_code, provider, provider_sub_id, provider_customer_id, status, current_period_end, provider_event_at, cancel_at_period_end)
               VALUES (?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?)
               ON CONFLICT(organization_id) DO UPDATE SET plan_code = excluded.plan_code, provider = 'stripe',
                 provider_sub_id = COALESCE(excluded.provider_sub_id, subscriptions.provider_sub_id),
                 provider_customer_id = COALESCE(excluded.provider_customer_id, subscriptions.provider_customer_id),
                 status = excluded.status, current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end),
                 provider_event_at = MAX(COALESCE(subscriptions.provider_event_at, 0), excluded.provider_event_at),
                 cancel_at_period_end = CASE WHEN ? THEN excluded.cancel_at_period_end ELSE subscriptions.cancel_at_period_end END, updated_at = ?`,
            )
            .bind(uuid(), orgId, planCode, subId ?? null, customerId, status, periodEnd, created, cancelScheduled, isSubEvent ? 1 : 0, nowIso()),
          db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(paid ? planCode : "free", orgId),
          ...(paid ? [grantStmt(db, orgId, plan.limits.monthlyCredits, `grant:${orgId}:${monthKey()}:${planCode}`, "plan_upgrade", "stripe")] : []),
          auditStmt(db, { organizationId: orgId, actorUserId: null, action: "billing.subscription_sync", entityType: "subscription", after: { planCode, status, eventId: event.id } }),
        ]);
        handled = true;
      } else if (stale) handled = true;
    } else if (orgId && event.type === "customer.subscription.deleted") {
      await db.batch([
        db.prepare("UPDATE subscriptions SET status = 'canceled', plan_code = 'free', cancel_at_period_end = 0, provider_event_at = ?, updated_at = ? WHERE organization_id = ?").bind(created, nowIso(), orgId),
        db.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(orgId),
        auditStmt(db, { organizationId: orgId, actorUserId: null, action: "billing.subscription_canceled", entityType: "subscription", after: { eventId: event.id } }),
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

function emailEntry(env: Env): ProviderManifestEntry {
  const mode = mailMode(env);
  const base = { key: "email", name: "Email transaccional (Cloudflare Email Service)", category: "Comunicación", phase: "F0" };
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
      phase: "F0",
      status: stripeMode(env) ? (stripeMode(env) === "live" && billingFlag(env) ? "connected" : "demo") : "not_configured",
      note: stripeMode(env) ? ACCESS_NOTE[billingAccess(env)] : "Falta STRIPE_SECRET_KEY.",
    },
    emailEntry(env),
    { key: "crawler", name: "Rastreador público DNIGrowthBot", category: "Auditoría", phase: "F1", status: "connected", note: "Funciona sin credenciales: solo HTML público, respeta robots.txt." },
    {
      key: "workers_ai",
      name: "IA (Workers AI + respaldo OpenRouter/Gemini)",
      category: "IA",
      phase: "F1+",
      status: env.AI ? "connected" : "not_configured",
      note: env.AI ? "Asesor y generación de imágenes con presupuesto diario y respaldo automático entre modelos." : "Falta el binding AI en wrangler.jsonc.",
    },
    {
      key: "google_search_console",
      name: "Google Search Console",
      category: "Datos",
      phase: "F3",
      status: gscReady(env) ? "available" : "not_configured",
      note: gscReady(env) ? "Disponible: conecta tu cuenta de Google (solo lectura) desde «Search Console»." : "Falta la configuración de Google (cliente OAuth y clave de cifrado).",
    },
    {
      key: "ga4",
      name: "Google Analytics 4",
      category: "Datos",
      phase: "F3",
      status: gscReady(env) ? "available" : "not_configured",
      note: gscReady(env) ? "Disponible: conecta tu cuenta de Google (solo lectura) desde «Analytics»." : "Falta la configuración de Google (cliente OAuth y clave de cifrado).",
    },
    { key: "keywords", name: "Proveedor de keywords/SERP", category: "SEO", phase: "F2", status: "planned", note: "Sin proveedor no se muestran volúmenes ni dificultad." },
    { key: "wordpress", name: "WordPress", category: "CMS", phase: "F2", status: "planned", note: "Publicación solo tras aprobación; export HTML/Markdown sin credenciales." },
    { key: "geo_monitor", name: "Monitor de visibilidad en IA", category: "GEO", phase: "F3", status: "planned", note: "Solo mediante APIs oficiales; muestreo, no cobertura total." },
    { key: "meta_ads", name: "Meta Ads", category: "Publicidad", phase: "F6", status: "blocked_external_approval", note: "Requiere app de Meta con ads_management/ads_read y revisión de la app." },
    { key: "google_ads", name: "Google Ads", category: "Publicidad", phase: "F9", status: "blocked_external_approval", note: "Requiere developer token aprobado." },
    { key: "whatsapp", name: "WhatsApp Business", category: "CRM", phase: "F5", status: "planned", note: "Plantillas aprobadas y opt-in obligatorio." },
  ];
}
