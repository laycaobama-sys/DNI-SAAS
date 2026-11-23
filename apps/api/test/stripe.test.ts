/**
 * Stripe billing: catalogue sync, test-mode access, duplicate-subscription guard, portal and webhook hardening.
 * Stripe's REST API is faked in-process; every request is recorded so tests can assert what was (not) sent.
 */
import { hmacSha256Hex, PLAN_OFFERS } from "@dni/core";
import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";
import { RETENTION_COUPON_NAME, WEBHOOK_EVENTS, maybeAutoSyncStripe, productNameFor } from "../src/lib/stripe";
import { billingMaintenance } from "../src/routes/billing";

const WHSEC = "whsec_fixture_secret";
// Assembled at runtime so the repository secret scanner never sees a key-shaped literal.
const TEST_KEY = ["sk", "test", "fixture000000000000"].join("_");
const LIVE_KEY = ["sk", "live", "fixture000000000000"].join("_");

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  idem: string | null;
}

function fakeStripe() {
  const calls: Call[] = [];
  const products = new Map<string, Record<string, unknown>>();
  const prices: Array<{ id: string; product: string; unit_amount: number; currency: string; active: boolean; lookup_key: string | null; recurring: { interval: string } }> = [];
  const portalConfigs: string[] = [];
  const endpoints: Array<{ id: string; url: string; secret: string; events: string[] }> = [];
  const coupons = new Set<string>();
  const subUpdates: Array<{ id: string; params: URLSearchParams }> = [];
  const refunds: Array<Record<string, string>> = [];
  const deletedSubs: string[] = [];
  const foreign = [
    { id: "prod_OldThing01", name: "Producto antiguo", created: 1, metadata: {} },
    { id: "dni_growth_starter", name: "DNI Growth Starter", created: 2, metadata: { managed_by: "dni-growth" } },
  ];
  const archivedProducts: string[] = [];
  const state = { chargesEnabled: true, taxStatus: "pending" as string, invoices: [] as Array<{ id: string; amount_paid: number; created: number; status: string }> };
  let n = 0;
  const handler = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const params = new URLSearchParams(method === "GET" ? u.search : String(init?.body ?? ""));
    const path = u.pathname.replace(/^\/v1/, "");
    calls.push({ method, path, params, idem: (init?.headers as Record<string, string>)["idempotency-key"] ?? null });
    if (method === "POST" && path === "/products") {
      const id = params.get("id")!;
      if (products.has(id)) return Response.json({ error: { code: "resource_already_exists" } }, { status: 400 });
      products.set(id, { id, name: params.get("name") });
      return Response.json(products.get(id));
    }
    if (method === "POST" && path.startsWith("/products/")) {
      if (params.get("active") === "false") archivedProducts.push(path.split("/")[2]!);
      return Response.json({ id: path.split("/")[2] });
    }
    if (method === "GET" && path === "/products") return Response.json({ data: foreign.filter((f) => !archivedProducts.includes(f.id)) });
    if (method === "GET" && path === "/account") return Response.json({ id: "acct_fixture", charges_enabled: state.chargesEnabled, details_submitted: true, settings: { dashboard: { display_name: "DNI Growth-IA" } } });
    if (method === "GET" && path === "/tax/settings") return Response.json({ status: state.taxStatus });
    if (method === "POST" && path === "/tax_rates") return Response.json({ id: `txr_${++n}`, percentage: Number(params.get("percentage")) });
    if (method === "POST" && path === "/coupons") {
      const id = params.get("id")!;
      if (coupons.has(id)) return Response.json({ error: { code: "resource_already_exists" } }, { status: 400 });
      coupons.add(id);
      return Response.json({ id });
    }
    if (method === "POST" && path.startsWith("/subscriptions/")) {
      subUpdates.push({ id: path.split("/")[2]!, params });
      return Response.json({ id: path.split("/")[2] });
    }
    if (method === "DELETE" && path.startsWith("/subscriptions/")) {
      deletedSubs.push(path.split("/")[2]!);
      return Response.json({ id: path.split("/")[2], status: "canceled" });
    }
    if (method === "GET" && path === "/invoices") return Response.json({ data: state.invoices });
    if (method === "GET" && path === "/invoice_payments") return Response.json({ data: [{ status: "paid", payment: { payment_intent: `pi_${params.get("invoice")}` } }] });
    if (method === "POST" && path === "/refunds") {
      refunds.push(Object.fromEntries(params.entries()));
      const inv = state.invoices.find((i) => `pi_${i.id}` === params.get("payment_intent"));
      return Response.json({ id: `re_${++n}`, amount: inv?.amount_paid ?? 0 });
    }
    if (method === "GET" && path === "/prices") {
      const lk = params.get("lookup_keys[]");
      if (params.get("product")) return Response.json({ data: prices.filter((p) => p.product === params.get("product") && p.active) });
      return Response.json({ data: prices.filter((p) => p.lookup_key === lk && p.active) });
    }
    if (method === "POST" && path === "/prices") {
      const lk = params.get("lookup_key");
      if (params.get("transfer_lookup_key") === "true") prices.forEach((p) => p.lookup_key === lk && (p.lookup_key = null));
      const p = { id: `price_${++n}`, product: params.get("product")!, unit_amount: Number(params.get("unit_amount")), currency: params.get("currency")!, active: true, lookup_key: lk, recurring: { interval: params.get("recurring[interval]")! } };
      prices.push(p);
      return Response.json(p);
    }
    if (method === "POST" && path.startsWith("/prices/")) {
      const p = prices.find((x) => x.id === path.split("/")[2]);
      if (p && params.get("active") === "false") p.active = false;
      return Response.json(p ?? {});
    }
    if (method === "POST" && path === "/billing_portal/configurations") {
      const id = `bpc_${++n}`;
      portalConfigs.push(id);
      return Response.json({ id });
    }
    if (method === "POST" && path.startsWith("/billing_portal/configurations/")) return Response.json({ id: path.split("/")[3] });
    if (method === "GET" && path === "/webhook_endpoints") return Response.json({ data: endpoints.map(({ id, url }) => ({ id, url })) });
    if (method === "POST" && path === "/webhook_endpoints") {
      const e = { id: `we_${++n}`, url: params.get("url")!, secret: ["whsec", "managed", String(n), "x".repeat(24)].join("_"), events: [...params.entries()].filter(([k]) => k.startsWith("enabled_events")).map(([, v]) => v) };
      endpoints.push(e);
      return Response.json(e);
    }
    if (method === "POST" && path.startsWith("/webhook_endpoints/")) {
      const e = endpoints.find((x) => x.id === path.split("/")[2]);
      return e ? Response.json({ id: e.id, url: e.url }) : Response.json({ error: { code: "resource_missing" } }, { status: 404 });
    }
    if (method === "POST" && path === "/checkout/sessions") return Response.json({ id: `cs_test_${++n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}` });
    if (method === "POST" && path === "/billing_portal/sessions") return Response.json({ url: "https://billing.stripe.com/p/session/test_123" });
    return Response.json({ error: { code: "unknown" } }, { status: 404 });
  };
  return { calls, prices, products, portalConfigs, endpoints, coupons, subUpdates, refunds, deletedSubs, archivedProducts, state, handler };
}

async function setup(opts: { key?: string; admin?: boolean; flag?: boolean | "auto"; ownerWebhookSecret?: boolean } = {}) {
  const h = createHarness();
  const stripe = fakeStripe();
  const real = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.stripe.com/")) {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${h.env.STRIPE_SECRET_KEY}`);
      return stripe.handler(url, init);
    }
    return real(input, init);
  }) as typeof fetch;
  if (opts.key !== "") h.env.STRIPE_SECRET_KEY = opts.key ?? TEST_KEY;
  if (opts.ownerWebhookSecret !== false) h.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  h.env.DATA_ENC_KEY = "0123456789abcdef".repeat(4);
  if (opts.flag) h.env.BILLING_ENABLED = opts.flag === "auto" ? "auto" : "true";
  if (opts.admin !== false) h.env.PLATFORM_ADMIN_EMAILS = "owner@luna.es";
  const owner = await h.signup("owner@luna.es", "Lucía");
  const orgId = await h.createOrg(owner, "Panadería Luna");
  return { h, owner, orgId, stripe };
}

async function webhook(h: ReturnType<typeof createHarness>, event: Record<string, unknown>, secret = WHSEC) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${raw}`)}`;
  const res = await h.app.request("/api/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: raw }, h.env, h.ctx);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const subEvent = (id: string, type: string, orgId: string, priceId: string, created: number, status = "active", extra: Record<string, unknown> = {}) => ({
  id,
  type,
  created,
  livemode: false,
  data: { object: { id: "sub_1", customer: "cus_1", status, metadata: { organization_id: orgId, plan_code: "starter" }, items: { data: [{ price: { id: priceId }, current_period_end: created + 2_592_000 }] }, ...extra } },
});

describe("Stripe catalogue sync (admin)", () => {
  it("creates products, EUR monthly + annual prices, VAT rate, retention coupon and the portal once; a second sync changes nothing", async () => {
    const { h, owner, stripe } = await setup();
    const r = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("test");
    expect(r.json.plans.map((p: { code: string; action: string }) => `${p.code}:${p.action}`)).toEqual(["starter:created", "growth:created", "pro:created", "agency:created"]);
    expect(r.json.portalAction).toBe("created");
    const starter = stripe.prices.find((p) => p.lookup_key === "dni_growth_starter_monthly_eur")!;
    expect(starter).toMatchObject({ unit_amount: 4900, currency: "eur", recurring: { interval: "month" }, product: "dni_growth_starter" });
    const growthYear = stripe.prices.find((p) => p.lookup_key === "dni_growth_growth_yearly_eur")!;
    expect(growthYear).toMatchObject({ unit_amount: 129600, recurring: { interval: "year" }, product: "dni_growth_growth" });
    const row = await h.db.prepare("SELECT stripe_price_id, stripe_price_id_year FROM plans WHERE code = 'starter'").first<{ stripe_price_id: string; stripe_price_id_year: string }>();
    expect(row!.stripe_price_id).toBe(starter.id);
    expect(row!.stripe_price_id_year).toBe(stripe.prices.find((p) => p.lookup_key === "dni_growth_starter_yearly_eur")!.id);
    expect(r.json.tax).toMatchObject({ mode: "manual" });
    expect(r.json.couponId).toBe("dni_growth_retencion_30_2m");
    expect(r.json.account).toMatchObject({ chargesEnabled: true, name: "DNI Growth-IA" });
    const portal = stripe.calls.find((c) => c.path === "/billing_portal/configurations")!;
    expect(portal.params.get("features[subscription_update][schedule_at_period_end][conditions][0][type]")).toBe("decreasing_item_amount");
    expect(portal.params.get("features[subscription_update][products][1][prices][1]")).toBe(growthYear.id);
    // Every POST carries an idempotency key or targets a deterministic id.
    expect(stripe.calls.filter((c) => c.method === "POST" && c.path === "/prices").every((c) => !!c.idem)).toBe(true);

    const again = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(again.json.plans.every((p: { action: string }) => p.action === "kept")).toBe(true);
    expect(again.json.portalAction).toBe("updated");
    expect(stripe.prices).toHaveLength(8);
    expect(stripe.portalConfigs).toHaveLength(1);
    expect(stripe.calls.filter((c) => c.path === "/tax_rates")).toHaveLength(1);
  });

  it("a price change creates a new price, moves the lookup key and archives the old one", async () => {
    const { h, owner, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const old = stripe.prices.find((p) => p.lookup_key === "dni_growth_growth_monthly_eur")!;
    await h.db.prepare("UPDATE plans SET price_eur_month = 99 WHERE code = 'growth'").run();
    const r = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(r.json.plans.find((p: { code: string }) => p.code === "growth")).toMatchObject({ action: "replaced", amountEur: 99 });
    expect(old.active).toBe(false);
    expect(stripe.prices.find((p) => p.lookup_key === "dni_growth_growth_monthly_eur")).toMatchObject({ unit_amount: 9900, active: true });
  });

  it("is invisible to non-admins and refuses without a key", async () => {
    const { owner } = await setup({ admin: false });
    expect((await owner.post("/api/v1/admin/billing/stripe/sync", {})).status).toBe(404);
    expect((await owner.get("/api/v1/admin/billing/stripe")).status).toBe(404);
    const noKey = await setup({ key: "" });
    expect((await noKey.owner.post("/api/v1/admin/billing/stripe/sync", {})).json.code).toBe("provider_not_configured");
  });
});

describe("Checkout access by mode", () => {
  it("test mode: only platform admins can open a checkout; everyone else gets billing_disabled and nothing is sent", async () => {
    const { h, owner, orgId, stripe } = await setup({ admin: false });
    await h.db.prepare("UPDATE plans SET stripe_price_id = 'price_x' WHERE code = 'growth'").run();
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth", acceptTerms: true });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("billing_disabled");
    expect(stripe.calls.filter((c) => c.path === "/checkout/sessions")).toHaveLength(0);
    const bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.stripe).toMatchObject({ mode: "test", access: "test_admin_only", canCheckout: false });
  });

  it("test mode + platform admin: checkout session with price, metadata, Spanish locale and customer email", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.stripe).toMatchObject({ access: "test_admin_only", canCheckout: true });
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth", acceptTerms: true });
    expect(r.status).toBe(200);
    expect(r.json.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const call = stripe.calls.find((c) => c.path === "/checkout/sessions")!;
    const growth = await h.db.prepare("SELECT stripe_price_id FROM plans WHERE code = 'growth'").first<{ stripe_price_id: string }>();
    expect(call.params.get("line_items[0][price]")).toBe(growth!.stripe_price_id);
    expect(call.params.get("metadata[organization_id]")).toBe(orgId);
    expect(call.params.get("subscription_data[metadata][plan_code]")).toBe("growth");
    expect(call.params.get("customer_email")).toBe("owner@luna.es");
    expect(call.params.get("locale")).toBe("es");
    expect(call.idem).toMatch(/^checkout:/);
    // Growth includes a 7-day free trial (card required) and Spanish VAT as a manual rate.
    expect(call.params.get("subscription_data[trial_period_days]")).toBe("7");
    expect(call.params.get("payment_method_collection")).toBe("always");
    expect(call.params.get("line_items[0][dynamic_tax_rates][0]")).toMatch(/^txr_/);
    expect(r.json.trialDays).toBe(7);
    // Consent to the terms is recorded with its version.
    const consent = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'billing.terms_accepted'").first<{ after_redacted: string }>();
    expect(JSON.parse(consent!.after_redacted)).toMatchObject({ termsVersion: "2026-11-23", immediateStart: true, planCode: "growth" });
    // Without explicit acceptance nothing is sent to Stripe.
    const before = stripe.calls.length;
    const noTerms = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth" });
    expect(noTerms.status).toBe(422);
    expect(stripe.calls.length).toBe(before);
  });

  it("live key without BILLING_ENABLED: nothing can be charged and webhooks are refused", async () => {
    const { h, owner, orgId, stripe } = await setup({ key: LIVE_KEY });
    await h.db.prepare("UPDATE plans SET stripe_price_id = 'price_x' WHERE code = 'growth'").run();
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth", acceptTerms: true });
    expect(r.json.code).toBe("billing_disabled");
    expect(stripe.calls).toHaveLength(0);
    expect((await webhook(h, subEvent("evt_live", "customer.subscription.updated", orgId, "price_x", 1000))).json.code).toBe("billing_disabled");
  });
});

describe("Subscription lifecycle via signed webhooks", () => {
  it("checkout → active plan + credits once; second checkout blocked (409); portal opens; plan switch via price; cancel → free", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const price = async (code: string) => (await h.db.prepare("SELECT stripe_price_id FROM plans WHERE code = ?").bind(code).first<{ stripe_price_id: string }>())!.stripe_price_id;
    const t0 = Math.floor(Date.now() / 1000);

    const done = await webhook(h, { id: "evt_1", type: "checkout.session.completed", created: t0, livemode: false, data: { object: { subscription: "sub_1", customer: "cus_1", client_reference_id: orgId, metadata: { organization_id: orgId, plan_code: "growth" } } } });
    expect(done.status).toBe(200);
    expect((await webhook(h, { id: "evt_1", type: "checkout.session.completed", created: t0, livemode: false, data: { object: {} } })).json.duplicate).toBe(true);
    let bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("growth");
    expect(bill.subscription).toMatchObject({ status: "active", has_customer: 1 });
    expect(bill.ledger.filter((l: { category: string }) => l.category === "plan_upgrade")).toHaveLength(1);

    // No second subscription for the same organisation.
    const second = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro", acceptTerms: true });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("subscription_exists");

    // Customer portal.
    const portal = await owner.post(`/api/v1/orgs/${orgId}/billing/portal`, {});
    expect(portal.json.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
    const pc = stripe.calls.find((c) => c.path === "/billing_portal/sessions")!;
    expect(pc.params.get("customer")).toBe("cus_1");
    expect(pc.params.get("configuration")).toBe(stripe.portalConfigs[0]);

    // Plan switch in the portal: the plan follows the PRICE even though metadata still says "starter".
    expect((await webhook(h, subEvent("evt_2", "customer.subscription.updated", orgId, await price("pro"), t0 + 10))).status).toBe(200);
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("pro");

    // An older event delivered late never overwrites newer state.
    expect((await webhook(h, subEvent("evt_old", "customer.subscription.updated", orgId, await price("starter"), t0 + 5))).status).toBe(200);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("pro");

    // Cancellation scheduled in the portal: access stays until the period ends, and the app says so.
    await webhook(h, subEvent("evt_c1", "customer.subscription.updated", orgId, await price("pro"), t0 + 12, "active", { cancel_at_period_end: true }));
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("pro");
    expect(bill.subscription.cancel_at_period_end).toBe(1);
    await webhook(h, subEvent("evt_c2", "customer.subscription.updated", orgId, await price("pro"), t0 + 14, "active", { cancel_at_period_end: false }));
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.subscription.cancel_at_period_end).toBe(0);

    // Payment trouble: 7-day grace period with the plan intact, then Free (nothing deleted) until it is paid.
    await webhook(h, subEvent("evt_3", "customer.subscription.updated", orgId, await price("pro"), t0 + 20, "past_due"));
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("pro");
    expect(bill.subscription.grace_until).toBeTruthy();
    await h.db.prepare("UPDATE subscriptions SET grace_until = ? WHERE organization_id = ?").bind(new Date(Date.now() - 1000).toISOString(), orgId).run();
    expect((await billingMaintenance(h.env)).downgraded).toBe(1);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("free");
    await webhook(h, subEvent("evt_4", "customer.subscription.updated", orgId, await price("pro"), t0 + 30, "active"));
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("pro");

    // Cancelled at period end but Stripe's "deleted" event never arrives (lost webhook, or a test-mode
    // subscription after switching to live keys): it still ends, two days after the period, never before.
    const endedAgo = async (days: number) => {
      await h.db.prepare("UPDATE subscriptions SET cancel_at_period_end = 1, current_period_end = ? WHERE organization_id = ?").bind(new Date(Date.now() - days * 86_400_000).toISOString(), orgId).run();
      await h.db.prepare("DELETE FROM platform_settings WHERE k = 'billing_maintenance_last'").run();
      return (await billingMaintenance(h.env)).downgraded;
    };
    expect(await endedAgo(1)).toBe(0);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("pro");
    expect(await endedAgo(3)).toBe(1);
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("free");
    expect(bill.subscription.status).toBe("canceled");
    await webhook(h, subEvent("evt_4b", "customer.subscription.updated", orgId, await price("pro"), t0 + 35, "active"));
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("pro");

    // Cancellation (customer resolved by Stripe customer id, no metadata needed).
    expect((await webhook(h, { id: "evt_5", type: "customer.subscription.deleted", created: t0 + 40, livemode: false, data: { object: { id: "sub_1", customer: "cus_1" } } })).status).toBe(200);
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("free");
    expect(bill.subscription.status).toBe("canceled");
  });

  it("ignores live events when configured with a test key (and never touches the organisation)", async () => {
    const { h, owner, orgId } = await setup();
    await h.db.prepare("UPDATE plans SET stripe_price_id = 'price_pro' WHERE code = 'pro'").run();
    const r = await webhook(h, { ...subEvent("evt_live", "customer.subscription.updated", orgId, "price_pro", 1000), livemode: true });
    expect(r.json.ignored).toBe("mode_mismatch");
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("free");
  });

  it("a member without billing:manage cannot open checkout or portal", async () => {
    const { h, owner, orgId } = await setup();
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
    const editor = await h.invite(owner, orgId, "editor@luna.es", "editor");
    expect((await editor.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro", acceptTerms: true })).status).toBe(403);
    expect((await editor.post(`/api/v1/orgs/${orgId}/billing/portal`, {})).status).toBe(403);
  });
});

describe("Platform-managed webhook endpoint", () => {
  it("sync registers the endpoint once, stores its secret encrypted, never exposes it, and verifies events with it", async () => {
    const { h, owner, orgId, stripe } = await setup({ ownerWebhookSecret: false });
    const before = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(before.stripe.configured).toBe(false); // key alone is not enough: webhooks could not be verified

    const r = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(r.status).toBe(200);
    expect(r.json.webhook).toMatchObject({ action: "created", url: "http://localhost:8787/api/v1/webhooks/stripe".replace("http://localhost:8787", h.env.APP_ORIGIN) });
    expect(stripe.endpoints).toHaveLength(1);
    expect(stripe.endpoints[0]!.events.sort()).toEqual([...WEBHOOK_EVENTS].sort());
    expect(WEBHOOK_EVENTS).toEqual(expect.arrayContaining(["invoice.payment_failed", "invoice.paid", "customer.subscription.trial_will_end"]));
    const secret = stripe.endpoints[0]!.secret;

    // Stored only encrypted; never in any response.
    const dump = JSON.stringify((await h.db.prepare("SELECT * FROM platform_settings").all()).results);
    expect(dump).not.toContain(secret);
    expect(dump).toMatch(/"v1\.[0-9a-f]+\.[0-9a-f]+"/);
    expect(JSON.stringify(r.json)).not.toContain(secret);
    const status = await owner.get("/api/v1/admin/billing/stripe");
    expect(JSON.stringify(status.json)).not.toContain(secret);
    expect(status.json).toMatchObject({ webhookSecretPresent: false, webhookVerifiable: true, webhookEndpoint: { id: stripe.endpoints[0]!.id } });

    // Second sync updates the same endpoint instead of creating another.
    expect((await owner.post("/api/v1/admin/billing/stripe/sync", {})).json.webhook.action).toBe("updated");
    expect(stripe.endpoints).toHaveLength(1);

    // Events signed with the managed secret are accepted; a wrong secret is rejected.
    const evt = { id: "evt_m1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { subscription: "sub_9", customer: "cus_9", metadata: { organization_id: orgId, plan_code: "starter" } } } };
    expect((await webhook(h, evt, "whsec_wrong")).status).toBe(400);
    expect((await webhook(h, evt, secret)).status).toBe(200);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json).toMatchObject({ plan: { code: "starter" }, stripe: { configured: true } });
  });

  it("never touches an endpoint for our URL that it did not create", async () => {
    const { owner, stripe } = await setup({ ownerWebhookSecret: false });
    stripe.endpoints.push({ id: "we_owner", url: "", secret: "unknown", events: [] });
    const status = (await owner.get("/api/v1/admin/billing/stripe")).json;
    stripe.endpoints[0]!.url = status.webhookUrl;
    const r = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(r.json.webhook).toMatchObject({ action: "conflict", endpointId: "we_owner" });
    expect(stripe.endpoints).toHaveLength(1);
  });
});

describe("Billing v2: annual, trial, pause, cancellation offers, live readiness", () => {
  const price = async (h: ReturnType<typeof createHarness>, code: string, col = "stripe_price_id") =>
    (await h.db.prepare(`SELECT ${col} AS id FROM plans WHERE code = ?`).bind(code).first<{ id: string }>())!.id;
  const activate = async (h: ReturnType<typeof createHarness>, orgId: string, priceId: string, status = "active", extra: Record<string, unknown> = {}) => {
    const t = Math.floor(Date.now() / 1000);
    await webhook(h, { id: `evt_co_${priceId}_${status}`, type: "checkout.session.completed", created: t, livemode: false, data: { object: { subscription: "sub_1", customer: "cus_1", client_reference_id: orgId, metadata: { organization_id: orgId, plan_code: "growth" } } } });
    await webhook(h, subEvent(`evt_su_${priceId}_${status}`, "customer.subscription.updated", orgId, priceId, t + 1, status, extra));
  };

  it("annual checkout uses the yearly price, no trial outside Growth, and the interval is mirrored from the webhook", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro", interval: "year", acceptTerms: true });
    expect(r.status).toBe(200);
    const call = stripe.calls.find((c) => c.path === "/checkout/sessions")!;
    expect(call.params.get("line_items[0][price]")).toBe(await price(h, "pro", "stripe_price_id_year"));
    expect(call.params.get("subscription_data[trial_period_days]")).toBeNull();
    await activate(h, orgId, await price(h, "pro", "stripe_price_id_year"));
    const bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("pro");
    expect(bill.subscription.billing_interval).toBe("year");
  });

  it("the free trial is used once per organisation: after a trialing subscription no new trial is offered", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.trialAvailable).toBe(true);
    await activate(h, orgId, await price(h, "growth"), "trialing", { trial_end: Math.floor(Date.now() / 1000) + 7 * 86400 });
    let bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("growth");
    expect(bill.subscription.status).toBe("trialing");
    expect(bill.subscription.trial_end).toBeTruthy();
    expect(bill.trialAvailable).toBe(false);
    // Cancelled later, they come back: no second trial.
    await webhook(h, { id: "evt_del", type: "customer.subscription.deleted", created: Math.floor(Date.now() / 1000) + 5, livemode: false, data: { object: { id: "sub_1", customer: "cus_1" } } });
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("free");
    await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth", acceptTerms: true });
    expect(stripe.calls.filter((c) => c.path === "/checkout/sessions").at(-1)!.params.get("subscription_data[trial_period_days]")).toBeNull();
  });

  it("pause 1–3 months (nothing charged, paid modules rest, data kept) and resume restores the plan", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    await activate(h, orgId, await price(h, "growth"));
    const p = await owner.post(`/api/v1/orgs/${orgId}/billing/pause`, { months: 2 });
    expect(p.status).toBe(200);
    const upd = stripe.subUpdates.at(-1)!;
    expect(upd.id).toBe("sub_1");
    expect(upd.params.get("pause_collection[behavior]")).toBe("void");
    expect(Number(upd.params.get("pause_collection[resumes_at]"))).toBeGreaterThan(Date.now() / 1000 + 55 * 86400);
    let bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("free");
    expect(bill.subscription.paused_until).toBeTruthy();
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/pause`, { months: 1 })).json.code).toBe("already_paused");
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/pause`, { months: 6 })).status).toBe(422);
    const res = await owner.post(`/api/v1/orgs/${orgId}/billing/resume`, {});
    expect(res.status).toBe(200);
    expect(stripe.subUpdates.at(-1)!.params.get("pause_collection")).toBe("");
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("growth");
    expect(bill.subscription.paused_until).toBeNull();
  });

  it("cancellation flow: one survey, the discount offer once, honest cancel at period end and undo", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    await activate(h, orgId, await price(h, "growth"));
    // The discount is only offered for the matching reason.
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/cancel`, { reason: "missing_features", offer: "discount" })).json.code).toBe("offer_not_available");
    const d = await owner.post(`/api/v1/orgs/${orgId}/billing/cancel`, { reason: "too_expensive", offer: "discount" });
    expect(d.json).toMatchObject({ outcome: "discount_applied", percentOff: 30, months: 2 });
    expect(stripe.subUpdates.at(-1)!.params.get("discounts[0][coupon]")).toBe("dni_growth_retencion_30_2m");
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/cancel`, { reason: "too_expensive", offer: "discount" })).json.code).toBe("offer_used");
    // Cancel without trabas: at period end, with Stripe feedback; access stays.
    const cx = await owner.post(`/api/v1/orgs/${orgId}/billing/cancel`, { reason: "switched_service", comment: "Me voy a otra agencia" });
    expect(cx.json.outcome).toBe("cancel_scheduled");
    const call = stripe.subUpdates.at(-1)!;
    expect(call.params.get("cancel_at_period_end")).toBe("true");
    expect(call.params.get("cancellation_details[feedback]")).toBe("switched_service");
    let bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("growth");
    expect(bill.subscription.cancel_at_period_end).toBe(1);
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/cancel/undo`, {})).json.undone).toBe(true);
    expect(stripe.subUpdates.at(-1)!.params.get("cancel_at_period_end")).toBe("false");
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.subscription.cancel_at_period_end).toBe(0);
    const fb = await h.db.prepare("SELECT reason, outcome FROM cancellation_feedback WHERE organization_id = ? ORDER BY created_at").bind(orgId).all<{ reason: string; outcome: string }>();
    expect(fb.results.map((r) => `${r.reason}:${r.outcome}`)).toEqual(["too_expensive:discount_applied", "switched_service:cancel_scheduled"]);
  });

  it("failed invoice: grace period, email to billing contacts only, and a paid invoice clears it", async () => {
    const { h, owner, orgId } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    await activate(h, orgId, await price(h, "starter"));
    const t = Math.floor(Date.now() / 1000) + 10;
    expect((await webhook(h, { id: "evt_if", type: "invoice.payment_failed", created: t, livemode: false, data: { object: { id: "in_1", customer: "cus_1", attempt_count: 1 } } })).status).toBe(200);
    let bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("starter");
    expect(bill.subscription.payment_failed_at).toBeTruthy();
    const mails = await h.db.prepare("SELECT to_masked, kind FROM email_outbox WHERE idempotency_key LIKE 'payment-failed:%'").all<{ to_masked: string }>();
    expect(mails.results.length).toBe(1);
    expect(mails.results[0]!.to_masked).not.toContain("owner@luna.es");
    await webhook(h, { id: "evt_ip", type: "invoice.paid", created: t + 5, livemode: false, data: { object: { id: "in_1", customer: "cus_1", amount_paid: 5929 } } });
    bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.subscription.payment_failed_at).toBeNull();
    expect(bill.subscription.grace_until).toBeNull();
  });

  it("live key + BILLING_ENABLED=auto: blocked with a clear message until Stripe verifies the account, then open to everyone", async () => {
    const { h, owner, orgId, stripe } = await setup({ key: LIVE_KEY, flag: "auto", admin: false });
    stripe.state.chargesEnabled = false;
    // The cron creates the catalogue, portal and webhook by itself once a key exists.
    expect(await maybeAutoSyncStripe(h.env, h.deps, h.env.APP_ORIGIN)).toBe("synced");
    expect(await maybeAutoSyncStripe(h.env, h.deps, h.env.APP_ORIGIN)).toBe("skipped"); // hourly back-off
    let r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "starter", acceptTerms: true });
    expect(r.json.code).toBe("provider_not_ready");
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.stripe.note).toMatch(/verificando la cuenta/);
    // The public pricing page never claims open payments before Stripe does.
    const pub = async () => (await h.app.request("/api/v1/public/pricing-status", {}, h.env, h.ctx)).json() as Promise<{ paymentsOpen: boolean }>;
    expect(await pub()).toEqual({ paymentsOpen: false });
    // Stripe approves the account: next hourly refresh opens payments for every customer.
    stripe.state.chargesEnabled = true;
    await h.db.prepare("DELETE FROM platform_settings WHERE k LIKE 'stripe_autosync_last_%'").run();
    expect(await maybeAutoSyncStripe(h.env, h.deps, h.env.APP_ORIGIN)).toBe("refreshed");
    r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "starter", acceptTerms: true });
    expect(r.status).toBe(200);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.stripe).toMatchObject({ access: "open", canCheckout: true, mode: "live" });
    expect(await pub()).toEqual({ paymentsOpen: true });
  });

  it("public pricing status stays closed in test mode, even with payments forced on", async () => {
    const { h } = await setup({ flag: true });
    const res = await h.app.request("/api/v1/public/pricing-status", {}, h.env, h.ctx);
    expect(await res.json()).toEqual({ paymentsOpen: false });
    expect(res.headers.get("cache-control")).toMatch(/max-age=300/);
  });

  it("foreign products: preview excludes DNI Growth products and only listed ones are archived (never deleted)", async () => {
    const { owner, stripe } = await setup();
    const list = await owner.get("/api/v1/admin/billing/stripe/foreign-products");
    expect(list.json.items.map((p: { id: string }) => p.id)).toEqual(["prod_OldThing01"]);
    const r = await owner.post("/api/v1/admin/billing/stripe/archive-products", { ids: ["prod_OldThing01", "prod_NotInList99"] });
    expect(r.json.archived).toEqual(["prod_OldThing01"]);
    expect(stripe.archivedProducts).toEqual(["prod_OldThing01"]);
    expect(stripe.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/products"))).toBe(false);
    expect((await owner.post("/api/v1/admin/billing/stripe/archive-products", { ids: ["dni_growth_starter"] })).status).toBe(422);
  });
});

describe("90-day guarantee", () => {
  const seedGsc = async (h: ReturnType<typeof createHarness>, orgId: string, from: number, days: number, perDay: number) => {
    const integrationId = "int_gsc";
    await h.db.prepare("INSERT OR IGNORE INTO integrations (id, organization_id, provider, status, created_at) VALUES (?, ?, 'google_search_console', 'connected', ?)").bind(integrationId, orgId, new Date(from - 40 * 86400_000).toISOString()).run();
    await h.db.prepare("INSERT OR IGNORE INTO gsc_properties (id, organization_id, integration_id, site_url, permission_level, selected) VALUES ('prop_1', ?, ?, 'sc-domain:luna.es', 'siteOwner', 1)").bind(orgId, integrationId).run();
    for (let i = 0; i < days; i++)
      await h.db
        .prepare("INSERT OR REPLACE INTO gsc_daily_metrics (organization_id, property_id, date, clicks, impressions, ctr, position, observed_at) VALUES (?, 'prop_1', ?, 1, ?, 0.01, 12, ?)")
        .bind(orgId, new Date(from + i * 86400_000).toISOString().slice(0, 10), perDay, new Date().toISOString())
        .run();
  };

  it("progress before day 90, refund refused when not eligible, refund of every paid invoice when impressions did not grow", async () => {
    const { h, owner, orgId, stripe } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const growth = (await h.db.prepare("SELECT stripe_price_id AS id FROM plans WHERE code = 'growth'").first<{ id: string }>())!.id;
    const t = Math.floor(Date.now() / 1000);
    await webhook(h, subEvent("evt_g1", "customer.subscription.updated", orgId, growth, t, "active"));
    let g = (await owner.get(`/api/v1/orgs/${orgId}/billing/guarantee`)).json;
    expect(g.status).toBe("in_progress");
    expect(g.daysLeft).toBe(90);
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/guarantee/claim`, {})).json.code).toBe("guarantee_not_available");

    // 95 days later: GSC connected before the start, 5 of 5 articles approved, no critical issues, impressions flat.
    const start = Date.now() - 95 * 86400_000;
    await h.db.prepare("UPDATE subscriptions SET started_at = ? WHERE organization_id = ?").bind(new Date(start).toISOString(), orgId).run();
    await seedGsc(h, orgId, start - 30 * 86400_000, 125, 100);
    const ownerId = (await h.db.prepare("SELECT id FROM users WHERE email = ?").bind("owner@luna.es").first<{ id: string }>())!.id;
    for (let i = 0; i < 5; i++)
      await h.db
        .prepare("INSERT INTO content_items (id, organization_id, kind, title, status, created_by, created_at) VALUES (?, ?, 'blog_article', ?, 'approved', ?, ?)")
        .bind(`ci_${i}`, orgId, `Artículo ${i}`, ownerId, new Date(start + (i + 1) * 86400_000).toISOString())
        .run();
    g = (await owner.get(`/api/v1/orgs/${orgId}/billing/guarantee`)).json;
    expect(g.requirements.every((r: { met: boolean }) => r.met)).toBe(true);
    expect(g.status).toBe("refund_available");
    expect(g.source).toMatch(/Search Console/);
    stripe.state.invoices = [
      { id: "in_a", amount_paid: 15609, created: Math.floor(start / 1000) + 10, status: "paid" },
      { id: "in_b", amount_paid: 15609, created: Math.floor(start / 1000) + 30 * 86400, status: "paid" },
    ];
    const claim = await owner.post(`/api/v1/orgs/${orgId}/billing/guarantee/claim`, {});
    expect(claim.json).toMatchObject({ refundedCents: 31218, refunds: 2 });
    expect(stripe.refunds.map((r) => r["payment_intent"])).toEqual(["pi_in_a", "pi_in_b"]);
    expect(stripe.deletedSubs).toEqual(["sub_1"]);
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/guarantee/claim`, {})).json.code).toBe("already_claimed");
  });
});

describe("Plan rows follow the commercial catalogue", () => {
  it("prices, annual prices and trial days in D1 match PLAN_OFFERS (one source for site, app and Stripe)", async () => {
    const h = createHarness();
    const { results } = await h.db.prepare("SELECT code, price_eur_month, price_eur_year, trial_days, limits_json FROM plans ORDER BY position").all<{ code: string; price_eur_month: number; price_eur_year: number; trial_days: number; limits_json: string }>();
    for (const o of PLAN_OFFERS) {
      const r = results.find((x) => x.code === o.code)!;
      expect([r.code, r.price_eur_month, r.price_eur_year, r.trial_days]).toEqual([o.code, o.monthly, o.yearly, o.trialDays]);
    }
    const limits = Object.fromEntries(results.map((r) => [r.code, JSON.parse(r.limits_json)]));
    expect(limits["growth"]).toMatchObject({ brands: 1, seats: 3, analysesPerMonth: 60, articlesPerMonth: 30 });
    expect(limits["agency"]).toMatchObject({ brands: 15, clientOrgs: 15 });
  });
});

describe("Billing funnel events and guarantee continuity", () => {
  it("records trial_started, subscribed and upgraded once each (cookieless, no personal data)", async () => {
    const { h, owner, orgId } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const price = async (code: string) => (await h.db.prepare("SELECT stripe_price_id AS id FROM plans WHERE code = ?").bind(code).first<{ id: string }>())!.id;
    const t = Math.floor(Date.now() / 1000);
    await webhook(h, subEvent("evt_f1", "customer.subscription.created", orgId, await price("growth"), t, "trialing", { trial_end: t + 7 * 86400 }));
    await webhook(h, subEvent("evt_f2", "customer.subscription.updated", orgId, await price("growth"), t + 1, "trialing", { trial_end: t + 7 * 86400 }));
    await webhook(h, subEvent("evt_f3", "customer.subscription.updated", orgId, await price("growth"), t + 2, "active"));
    await webhook(h, subEvent("evt_f4", "customer.subscription.updated", orgId, await price("pro"), t + 3, "active"));
    await webhook(h, subEvent("evt_f5", "customer.subscription.updated", orgId, await price("starter"), t + 4, "active"));
    const { results } = await h.db.prepare("SELECT event, props_json FROM product_events WHERE organization_id = ? AND event IN ('trial_started', 'subscribed', 'upgraded', 'paused', 'canceled') ORDER BY created_at, event").bind(orgId).all<{ event: string; props_json: string }>();
    expect(results.map((r) => r.event).sort()).toEqual(["subscribed", "trial_started", "upgraded"]);
    expect(JSON.parse(results.find((r) => r.event === "upgraded")!.props_json)).toMatchObject({ plan: "pro", from: "growth" });
    for (const r of results) expect(r.props_json).not.toMatch(/@/);
  });

  it("a pause during the 90 days breaks continuity: the guarantee says why and never offers a refund", async () => {
    const { h, owner, orgId } = await setup();
    await owner.post("/api/v1/admin/billing/stripe/sync", {});
    const growth = (await h.db.prepare("SELECT stripe_price_id AS id FROM plans WHERE code = 'growth'").first<{ id: string }>())!.id;
    await webhook(h, subEvent("evt_p1", "customer.subscription.updated", orgId, growth, Math.floor(Date.now() / 1000), "active"));
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/pause`, { months: 1 })).status).toBe(200);
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/resume`, {})).status).toBe(200);
    const g = (await owner.get(`/api/v1/orgs/${orgId}/billing/guarantee`)).json;
    expect(g.status).toBe("requirements_missing");
    expect(g.requirements.find((r: { key: string }) => r.key === "days")).toMatchObject({ met: false, detail: expect.stringMatching(/pausó/) });
    expect((await owner.post(`/api/v1/orgs/${orgId}/billing/guarantee/claim`, {})).json.code).toBe("guarantee_not_available");
  });
});

describe("Stripe catalogue limits", () => {
  it("keeps the retention coupon name within Stripe's 40-character limit", () => {
    expect(RETENTION_COUPON_NAME.length).toBeLessThanOrEqual(40);
  });
});

describe("Stripe product names", () => {
  it("read well on Checkout and invoices", () => {
    expect(productNameFor("Growth")).toBe("DNI Growth · Plan Growth");
    for (const o of PLAN_OFFERS) expect(productNameFor(o.name)).not.toMatch(/Growth Growth/);
  });
});
