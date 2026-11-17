import { Hono } from "hono";
import { CheckoutInput, verifyStripeSignature, type ProviderManifestEntry } from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { creditBalance, ensureMonthlyGrant, getPlan, grantStmt, orgPlan } from "../lib/billing";
import { ApiError, parseBody } from "../lib/http";
import { log, monthKey, nowIso, uuid } from "../lib/util";
import { requireScope } from "../middleware";
import { mailMode } from "../lib/mail";

export const stripeConfigured = (env: Env) => !!env.STRIPE_SECRET_KEY && !!env.STRIPE_WEBHOOK_SECRET;
/** Payments stay off until the owner flips BILLING_ENABLED="true" (wrangler.jsonc vars). */
export const billingEnabled = (env: Env) => env.BILLING_ENABLED === "true";
const billingDisabled = () => new ApiError(503, "billing_disabled", "Los pagos todavía no están activados en DNI Growth. No se ha realizado ningún cargo.");

/** Tenant billing routes (mounted under /orgs/:orgId). */
export const billing = new Hono<AppEnv>();

billing.get("/billing", requireScope("billing:read"), async (c) => {
  const t = c.get("tenant");
  const plan = await orgPlan(c.env.DB, t.orgId);
  await ensureMonthlyGrant(c.env.DB, t.orgId, plan);
  const [sub, ledger, plans, balance] = await Promise.all([
    c.env.DB.prepare("SELECT plan_code, provider, status, current_period_end, updated_at FROM subscriptions WHERE organization_id = ?").bind(t.orgId).first(),
    c.env.DB.prepare("SELECT id, job_id, category, amount, entry_kind, provider, created_at FROM credit_ledger WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").bind(t.orgId).all(),
    c.env.DB.prepare("SELECT code, name, price_eur_month, limits_json, stripe_price_id IS NOT NULL AS purchasable FROM plans WHERE active = 1 ORDER BY position").all(),
    creditBalance(c.env.DB, t.orgId),
  ]);
  return c.json({
    plan,
    subscription: sub,
    balance,
    ledger: ledger.results,
    plans: plans.results,
    stripe: { enabled: billingEnabled(c.env), configured: stripeConfigured(c.env), mode: c.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : "test" },
    notes: ["Precios sin IVA. El gasto publicitario (cuando exista) se factura aparte y nunca se mezcla con la cuota del software."],
  });
});

billing.post("/billing/checkout", requireScope("billing:manage"), async (c) => {
  const t = c.get("tenant");
  const { planCode } = await parseBody(c, CheckoutInput);
  if (!billingEnabled(c.env)) throw billingDisabled();
  if (!stripeConfigured(c.env)) {
    throw new ApiError(503, "provider_not_configured", "Los pagos no están configurados todavía (Stripe no conectado). No se ha realizado ningún cargo.");
  }
  const priceRow = await c.env.DB.prepare("SELECT stripe_price_id FROM plans WHERE code = ? AND active = 1").bind(planCode).first<{ stripe_price_id: string | null }>();
  if (!priceRow?.stripe_price_id) throw new ApiError(503, "price_not_configured", "Este plan aún no tiene precio configurado en Stripe.");
  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceRow.stripe_price_id,
    "line_items[0][quantity]": "1",
    success_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing?checkout=success`,
    cancel_url: `${c.env.APP_ORIGIN}/app/o/${t.orgId}/billing?checkout=cancel`,
    client_reference_id: t.orgId,
    "metadata[organization_id]": t.orgId,
    "metadata[plan_code]": planCode,
    "subscription_data[metadata][organization_id]": t.orgId,
    "subscription_data[metadata][plan_code]": planCode,
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `checkout:${t.orgId}:${planCode}:${Math.floor(Date.now() / 600_000)}` },
    body: form,
  });
  if (!res.ok) {
    log("error", "stripe.checkout_failed", { status: res.status });
    throw new ApiError(502, "provider_error", "Stripe no pudo crear la sesión de pago.");
  }
  const session = (await res.json()) as { id: string; url: string };
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "billing.checkout_start", entityType: "subscription", after: { planCode, sessionId: session.id }, requestId: c.get("requestId") }).run();
  return c.json({ url: session.url });
});

/**
 * Stripe webhook: signature verified on the RAW body, provider_event_id UNIQUE for idempotency.
 * Returns 2xx only after the event is persisted.
 */
export const webhooks = new Hono<AppEnv>();

webhooks.post("/stripe", async (c) => {
  if (!billingEnabled(c.env)) throw billingDisabled();
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, "provider_not_configured", "Stripe no configurado.");
  const raw = await c.req.text();
  if (raw.length > 512_000) throw new ApiError(413, "payload_too_large", "Payload demasiado grande.");
  const v = await verifyStripeSignature(raw, c.req.header("stripe-signature") ?? null, c.env.STRIPE_WEBHOOK_SECRET);
  if (!v.ok) {
    log("warn", "stripe.webhook_rejected", { reason: v.reason });
    throw new ApiError(400, "invalid_signature", "Firma no válida.");
  }
  const event = JSON.parse(raw) as { id: string; type: string; data: { object: Record<string, unknown> } };
  if (typeof event.id !== "string" || typeof event.type !== "string") throw new ApiError(400, "invalid_event", "Evento no válido.");
  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, provider, provider_event_id, type) VALUES (?, 'stripe', ?, ?)").bind(uuid(), event.id, event.type).run();
  if (!ins.meta.changes) return c.json({ received: true, duplicate: true });

  try {
    const obj = event.data.object;
    const meta = (obj["metadata"] ?? {}) as Record<string, string>;
    const orgId = meta["organization_id"];
    const planCode = meta["plan_code"];
    let handled = false;
    if (orgId && planCode && (event.type === "checkout.session.completed" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.created")) {
      const org = await c.env.DB.prepare("SELECT id FROM organizations WHERE id = ?").bind(orgId).first();
      const plan = org ? await getPlan(c.env.DB, planCode).catch(() => null) : null;
      if (org && plan) {
        const subId = (event.type === "checkout.session.completed" ? obj["subscription"] : obj["id"]) as string | undefined;
        const status = event.type === "checkout.session.completed" ? "active" : String(obj["status"] ?? "active");
        const periodEnd = typeof obj["current_period_end"] === "number" ? new Date((obj["current_period_end"] as number) * 1000).toISOString() : null;
        await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT INTO subscriptions (id, organization_id, plan_code, provider, provider_sub_id, status, current_period_end) VALUES (?, ?, ?, 'stripe', ?, ?, ?)
             ON CONFLICT(organization_id) DO UPDATE SET plan_code = excluded.plan_code, provider = 'stripe', provider_sub_id = COALESCE(excluded.provider_sub_id, subscriptions.provider_sub_id),
               status = excluded.status, current_period_end = COALESCE(excluded.current_period_end, subscriptions.current_period_end), updated_at = ?`,
          ).bind(uuid(), orgId, planCode, subId ?? null, ["active", "trialing", "past_due", "canceled", "incomplete"].includes(status) ? status : "incomplete", periodEnd, nowIso()),
          c.env.DB.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(status === "active" || status === "trialing" ? planCode : "free", orgId),
          grantStmt(c.env.DB, orgId, plan.limits.monthlyCredits, `grant:${orgId}:${monthKey()}:${planCode}`, "plan_upgrade", "stripe"),
          auditStmt(c.env.DB, { organizationId: orgId, actorUserId: null, action: "billing.subscription_sync", entityType: "subscription", after: { planCode, status, eventId: event.id } }),
        ]);
        handled = true;
      }
    } else if (orgId && event.type === "customer.subscription.deleted") {
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE subscriptions SET status = 'canceled', plan_code = 'free', updated_at = ? WHERE organization_id = ?").bind(nowIso(), orgId),
        c.env.DB.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(orgId),
        auditStmt(c.env.DB, { organizationId: orgId, actorUserId: null, action: "billing.subscription_canceled", entityType: "subscription", after: { eventId: event.id } }),
      ]);
      handled = true;
    }
    await c.env.DB.prepare("UPDATE webhook_events SET status = ?, processed_at = ? WHERE provider = 'stripe' AND provider_event_id = ?").bind(handled ? "processed" : "ignored", nowIso(), event.id).run();
    return c.json({ received: true });
  } catch (e) {
    // Remove the idempotency marker so Stripe's retry can be processed again.
    await c.env.DB.prepare("DELETE FROM webhook_events WHERE provider = 'stripe' AND provider_event_id = ?").bind(event.id).run();
    log("error", "stripe.webhook_failed", { type: event.type, error: String(e) });
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
    { key: "stripe", name: "Stripe (pagos)", category: "Facturación", phase: "F0", status: stripeConfigured(env) ? "connected" : "not_configured", note: stripeConfigured(env) ? "Claves presentes; valida con un pago de prueba." : "Faltan STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET." },
    emailEntry(env),
    { key: "crawler", name: "Rastreador público DNIGrowthBot", category: "Auditoría", phase: "F1", status: "connected", note: "Funciona sin credenciales: solo HTML público, respeta robots.txt." },
    { key: "workers_ai", name: "IA (Workers AI + respaldo OpenRouter/Gemini)", category: "IA", phase: "F1+", status: env.AI ? "connected" : "not_configured", note: env.AI ? "Asesor y generación de imágenes con presupuesto diario y respaldo automático entre modelos." : "Falta el binding AI en wrangler.jsonc." },
    { key: "google_search_console", name: "Google Search Console", category: "Datos", phase: "F3", status: "planned", note: "OAuth con scope mínimo de solo lectura." },
    { key: "ga4", name: "Google Analytics 4", category: "Datos", phase: "F3", status: "planned", note: "Ingesta por propiedad y periodo." },
    { key: "keywords", name: "Proveedor de keywords/SERP", category: "SEO", phase: "F2", status: "planned", note: "Sin proveedor no se muestran volúmenes ni dificultad." },
    { key: "wordpress", name: "WordPress", category: "CMS", phase: "F2", status: "planned", note: "Publicación solo tras aprobación; export HTML/Markdown sin credenciales." },
    { key: "geo_monitor", name: "Monitor de visibilidad en IA", category: "GEO", phase: "F3", status: "planned", note: "Solo mediante APIs oficiales; muestreo, no cobertura total." },
    { key: "meta_ads", name: "Meta Ads", category: "Publicidad", phase: "F6", status: "blocked_external_approval", note: "Requiere app de Meta con ads_management/ads_read y revisión de la app." },
    { key: "google_ads", name: "Google Ads", category: "Publicidad", phase: "F9", status: "blocked_external_approval", note: "Requiere developer token aprobado." },
    { key: "whatsapp", name: "WhatsApp Business", category: "CRM", phase: "F5", status: "planned", note: "Plantillas aprobadas y opt-in obligatorio." },
  ];
}
