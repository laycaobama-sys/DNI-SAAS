/**
 * Stripe integration (server only). The secret key lives in Cloudflare secrets and never leaves the Worker.
 *
 * Access model:
 *   - no STRIPE_SECRET_KEY                 → payments not configured (nothing is charged).
 *   - test key (sk_test_/rk_test_)         → "test": only platform admins can open a checkout, so real visitors
 *                                            never see a sandbox payment page. Cards are Stripe test cards.
 *   - BILLING_ENABLED="true"               → "open": every org member with billing:manage can subscribe.
 *   - live key without BILLING_ENABLED     → "off": nothing can be charged until the owner flips the flag.
 */
import { decryptJson, encryptJson } from "@dni/core";
import type { Deps, Env } from "../env";
import { log, nowIso } from "./util";

export type StripeMode = "test" | "live" | null;
export const STRIPE_API_VERSION = "2025-03-31.basil";
export type BillingAccess = "not_configured" | "off" | "test_admin_only" | "open";

export const stripeMode = (env: Env): StripeMode => {
  const k = env.STRIPE_SECRET_KEY ?? "";
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return null;
};

export const billingFlag = (env: Env) => env.BILLING_ENABLED === "true";

export function billingAccess(env: Env): BillingAccess {
  const mode = stripeMode(env);
  if (!mode) return "not_configured";
  if (billingFlag(env)) return "open";
  return mode === "test" ? "test_admin_only" : "off";
}


export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`stripe_${status}_${code}`);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

function encode(params: Params): string {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) f.append(k, String(v));
  return f.toString();
}

/** Minimal Stripe REST client (form-encoded), with idempotency keys on every POST. */
export async function stripeApi<T>(env: Env, deps: Deps, method: "GET" | "POST", path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeApiError(503, "not_configured");
  const qs = encode(params);
  const url = `https://api.stripe.com/v1${path}${method === "GET" && qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "stripe-version": STRIPE_API_VERSION };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  }
  const res = await deps.fetchImpl(url, { method, headers, body: method === "POST" ? qs : undefined, signal: AbortSignal.timeout(20_000) });
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; type?: string } } & T;
  if (!res.ok) {
    const code = (json.error?.code ?? json.error?.type ?? "error").slice(0, 60);
    log("warn", "stripe.api_error", { path: path.replace(/\/[a-z]{2,6}_[A-Za-z0-9]+/g, "/:id"), status: res.status, code });
    throw new StripeApiError(res.status, code);
  }
  return json;
}

// ── Platform settings (non-secret identifiers such as the portal configuration id) ─────────────────
export async function getSetting(db: D1Database, k: string): Promise<string | null> {
  const r = await db.prepare("SELECT v FROM platform_settings WHERE k = ?").bind(k).first<{ v: string }>();
  return r?.v ?? null;
}
export async function setSetting(db: D1Database, k: string, v: string) {
  await db.prepare("INSERT INTO platform_settings (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(k, v, nowIso()).run();
}

// ── Catalogue sync: products, prices and customer portal, idempotent ───────────────────────────────
interface PlanRow {
  code: string;
  name: string;
  price_eur_month: number;
  stripe_price_id: string | null;
}
interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  active: boolean;
  recurring: { interval: string } | null;
  product: string | { id: string };
}

export const productIdFor = (code: string) => `dni_growth_${code}`;
export const lookupKeyFor = (code: string) => `dni_growth_${code}_monthly_eur`;

export interface CatalogSyncResult {
  mode: StripeMode;
  plans: Array<{ code: string; productId: string; priceId: string; amountEur: number; action: "kept" | "created" | "replaced" }>;
  portalConfigurationId: string;
  portalAction: "created" | "updated";
}

export async function syncStripeCatalog(env: Env, deps: Deps, appOrigin: string): Promise<CatalogSyncResult> {
  const mode = stripeMode(env);
  if (!mode) throw new StripeApiError(503, "not_configured");
  const { results: plans } = await env.DB.prepare("SELECT code, name, price_eur_month, stripe_price_id FROM plans WHERE active = 1 AND price_eur_month > 0 ORDER BY position").all<PlanRow>();
  const out: CatalogSyncResult["plans"] = [];

  for (const p of plans) {
    const productId = productIdFor(p.code);
    // Product with a deterministic id: creating it twice fails with resource_already_exists → we update it instead.
    try {
      await stripeApi(env, deps, "POST", "/products", { id: productId, name: `DNI Growth ${p.name}`, "metadata[plan_code]": p.code, tax_code: "txcd_10103001" }, `product:${productId}:v1`);
    } catch (e) {
      if (!(e instanceof StripeApiError) || e.code !== "resource_already_exists") throw e;
      await stripeApi(env, deps, "POST", `/products/${productId}`, { name: `DNI Growth ${p.name}`, active: true, "metadata[plan_code]": p.code });
    }
    const amount = Math.round(p.price_eur_month * 100);
    const lookup = lookupKeyFor(p.code);
    const existing = await stripeApi<{ data: StripePrice[] }>(env, deps, "GET", "/prices", { "lookup_keys[]": lookup, active: true, limit: 1 });
    const cur = existing.data[0];
    const matches = cur && cur.unit_amount === amount && cur.currency === "eur" && cur.recurring?.interval === "month";
    let priceId: string;
    let action: "kept" | "created" | "replaced";
    if (matches) {
      priceId = cur.id;
      action = "kept";
    } else {
      // A new price takes over the lookup key; the old one is archived (existing subscribers keep their price).
      const created = await stripeApi<StripePrice>(
        env,
        deps,
        "POST",
        "/prices",
        {
          product: productId,
          currency: "eur",
          unit_amount: amount,
          "recurring[interval]": "month",
          lookup_key: lookup,
          transfer_lookup_key: true,
          tax_behavior: "exclusive",
          "metadata[plan_code]": p.code,
        },
        `price:${lookup}:${amount}`,
      );
      if (cur) await stripeApi(env, deps, "POST", `/prices/${cur.id}`, { active: false }, `archive:${cur.id}`);
      priceId = created.id;
      action = cur ? "replaced" : "created";
    }
    await env.DB.prepare("UPDATE plans SET stripe_price_id = ? WHERE code = ?").bind(priceId, p.code).run();
    out.push({ code: p.code, productId, priceId, amountEur: p.price_eur_month, action });
  }

  // Customer portal: update payment method, invoices, cancel at period end, switch between our plans.
  const portal: Params = {
    "business_profile[headline]": "DNI Growth — gestiona tu suscripción",
    "business_profile[privacy_policy_url]": `${appOrigin}/legal/privacidad`,
    "business_profile[terms_of_service_url]": `${appOrigin}/legal/aviso-legal`,
    "features[invoice_history][enabled]": true,
    "features[payment_method_update][enabled]": true,
    "features[customer_update][enabled]": true,
    "features[customer_update][allowed_updates][0]": "email",
    "features[customer_update][allowed_updates][1]": "address",
    "features[customer_update][allowed_updates][2]": "tax_id",
    "features[subscription_cancel][enabled]": true,
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": true,
    "features[subscription_update][default_allowed_updates][0]": "price",
    "features[subscription_update][proration_behavior]": "create_prorations",
    default_return_url: `${appOrigin}/app`,
  };
  out.forEach((p, i) => {
    portal[`features[subscription_update][products][${i}][product]`] = p.productId;
    portal[`features[subscription_update][products][${i}][prices][0]`] = p.priceId;
  });
  const settingKey = `stripe_portal_config_${mode}`;
  const storedId = await getSetting(env.DB, settingKey);
  let portalConfigurationId: string;
  let portalAction: "created" | "updated";
  if (storedId) {
    await stripeApi(env, deps, "POST", `/billing_portal/configurations/${storedId}`, portal);
    portalConfigurationId = storedId;
    portalAction = "updated";
  } else {
    const cfg = await stripeApi<{ id: string }>(env, deps, "POST", "/billing_portal/configurations", portal, `portal-config:${mode}:v1`);
    portalConfigurationId = cfg.id;
    portalAction = "created";
    await setSetting(env.DB, settingKey, cfg.id);
  }
  return { mode, plans: out, portalConfigurationId, portalAction };
}

// ── Webhook endpoint managed by the platform ──────────────────────────────────────────────────────
// The signing secret is returned by Stripe only once, at creation. We store it AES-256-GCM encrypted with
// DATA_ENC_KEY (a Cloudflare secret), bound to the mode via AAD. It is never returned by any endpoint or logged.
export const WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"];

interface StoredEndpoint {
  id: string;
  url: string;
}

const endpointKey = (mode: StripeMode) => `stripe_webhook_endpoint_${mode}`;
const secretKey = (mode: StripeMode) => `stripe_webhook_secret_${mode}`;

/** Signing secrets accepted for this deployment: the owner-provided one (if any) and the platform-managed one. */
export async function webhookSecrets(env: Env): Promise<string[]> {
  const out: string[] = [];
  if (env.STRIPE_WEBHOOK_SECRET) out.push(env.STRIPE_WEBHOOK_SECRET);
  const mode = stripeMode(env);
  if (mode && env.DATA_ENC_KEY) {
    const sealed = await getSetting(env.DB, secretKey(mode));
    if (sealed) {
      try {
        out.push(await decryptJson<string>(env.DATA_ENC_KEY, sealed, `stripe_webhook:${mode}`));
      } catch {
        log("error", "stripe.webhook_secret_unreadable", { mode });
      }
    }
  }
  return out;
}

/** Ready to take payments: a key and at least one way to verify webhooks. */
export async function stripeReady(env: Env): Promise<boolean> {
  return !!stripeMode(env) && (await webhookSecrets(env)).length > 0;
}

/** Webhooks are processed when payments are open, or in test mode (events only come from the owner's sandbox). */
export async function webhooksAcceptedAsync(env: Env): Promise<boolean> {
  return (billingFlag(env) || stripeMode(env) === "test") && (await webhookSecrets(env)).length > 0;
}

export interface WebhookSyncResult {
  endpointId: string | null;
  action: "created" | "updated" | "owner_managed" | "conflict";
  url: string;
  events: string[];
}

export async function ensureWebhookEndpoint(env: Env, deps: Deps, appOrigin: string): Promise<WebhookSyncResult> {
  const mode = stripeMode(env);
  if (!mode) throw new StripeApiError(503, "not_configured");
  const url = `${appOrigin}/api/v1/webhooks/stripe`;
  const events: Params = {};
  WEBHOOK_EVENTS.forEach((e, i) => (events[`enabled_events[${i}]`] = e));
  const storedRaw = await getSetting(env.DB, endpointKey(mode));
  const stored = storedRaw ? (JSON.parse(storedRaw) as StoredEndpoint) : null;
  if (stored && (await getSetting(env.DB, secretKey(mode)))) {
    try {
      await stripeApi(env, deps, "POST", `/webhook_endpoints/${stored.id}`, { url, disabled: false, ...events });
      return { endpointId: stored.id, action: "updated", url, events: WEBHOOK_EVENTS };
    } catch (e) {
      if (!(e instanceof StripeApiError) || e.status !== 404) throw e;
      // Deleted in the dashboard: fall through and create a new one.
    }
  }
  // The owner registered the endpoint and stored its secret with wrangler: leave their configuration alone.
  if (env.STRIPE_WEBHOOK_SECRET && !stored) return { endpointId: null, action: "owner_managed", url, events: WEBHOOK_EVENTS };
  // An endpoint for our URL that we did not create: its secret is unknown to us. Never delete user configuration.
  const list = await stripeApi<{ data: Array<{ id: string; url: string }> }>(env, deps, "GET", "/webhook_endpoints", { limit: 100 });
  const foreign = list.data.find((w) => w.url === url && w.id !== stored?.id);
  if (foreign) {
    return env.STRIPE_WEBHOOK_SECRET
      ? { endpointId: foreign.id, action: "owner_managed", url, events: WEBHOOK_EVENTS }
      : { endpointId: foreign.id, action: "conflict", url, events: WEBHOOK_EVENTS };
  }
  if (!env.DATA_ENC_KEY) throw new StripeApiError(503, "missing_encryption_key");
  const created = await stripeApi<{ id: string; secret?: string }>(
    env,
    deps,
    "POST",
    "/webhook_endpoints",
    { url, description: "DNI Growth (gestionado por la plataforma)", api_version: STRIPE_API_VERSION, "metadata[managed_by]": "dni-growth", ...events },
    `webhook:${mode}:${url}`,
  );
  if (!created.secret) throw new StripeApiError(502, "missing_secret");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO platform_settings (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(
      secretKey(mode),
      await encryptJson(env.DATA_ENC_KEY, created.secret, `stripe_webhook:${mode}`),
      nowIso(),
    ),
    env.DB.prepare("INSERT INTO platform_settings (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(
      endpointKey(mode),
      JSON.stringify({ id: created.id, url }),
      nowIso(),
    ),
  ]);
  return { endpointId: created.id, action: "created", url, events: WEBHOOK_EVENTS };
}
