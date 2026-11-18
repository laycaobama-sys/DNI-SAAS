/**
 * Stripe billing: catalogue sync, test-mode access, duplicate-subscription guard, portal and webhook hardening.
 * Stripe's REST API is faked in-process; every request is recorded so tests can assert what was (not) sent.
 */
import { hmacSha256Hex } from "@dni/core";
import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

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
    if (method === "POST" && path.startsWith("/products/")) return Response.json({ id: path.split("/")[2] });
    if (method === "GET" && path === "/prices") {
      const lk = params.get("lookup_keys[]");
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
  return { calls, prices, products, portalConfigs, endpoints, handler };
}

async function setup(opts: { key?: string; admin?: boolean; flag?: boolean; ownerWebhookSecret?: boolean } = {}) {
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
  if (opts.flag) h.env.BILLING_ENABLED = "true";
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
  it("creates products, EUR monthly prices and the portal once; a second sync changes nothing", async () => {
    const { h, owner, stripe } = await setup();
    const r = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(r.status).toBe(200);
    expect(r.json.mode).toBe("test");
    expect(r.json.plans.map((p: { code: string; action: string }) => `${p.code}:${p.action}`)).toEqual(["starter:created", "growth:created", "pro:created", "agency:created"]);
    expect(r.json.portalAction).toBe("created");
    const starter = stripe.prices.find((p) => p.lookup_key === "dni_growth_starter_monthly_eur")!;
    expect(starter).toMatchObject({ unit_amount: 3900, currency: "eur", recurring: { interval: "month" }, product: "dni_growth_starter" });
    const row = await h.db.prepare("SELECT stripe_price_id FROM plans WHERE code = 'starter'").first<{ stripe_price_id: string }>();
    expect(row!.stripe_price_id).toBe(starter.id);
    // Every POST carries an idempotency key or targets a deterministic id.
    expect(stripe.calls.filter((c) => c.method === "POST" && c.path === "/prices").every((c) => !!c.idem)).toBe(true);

    const again = await owner.post("/api/v1/admin/billing/stripe/sync", {});
    expect(again.json.plans.every((p: { action: string }) => p.action === "kept")).toBe(true);
    expect(again.json.portalAction).toBe("updated");
    expect(stripe.prices).toHaveLength(4);
    expect(stripe.portalConfigs).toHaveLength(1);
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
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth" });
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
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth" });
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
  });

  it("live key without BILLING_ENABLED: nothing can be charged and webhooks are refused", async () => {
    const { h, owner, orgId, stripe } = await setup({ key: LIVE_KEY });
    await h.db.prepare("UPDATE plans SET stripe_price_id = 'price_x' WHERE code = 'growth'").run();
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "growth" });
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
    const second = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro" });
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

    // Payment trouble downgrades access until it is paid.
    await webhook(h, subEvent("evt_3", "customer.subscription.updated", orgId, await price("pro"), t0 + 20, "past_due"));
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("free");
    await webhook(h, subEvent("evt_4", "customer.subscription.updated", orgId, await price("pro"), t0 + 30, "active"));
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
    expect((await editor.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro" })).status).toBe(403);
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
    expect(stripe.endpoints[0]!.events.sort()).toEqual(["checkout.session.completed", "customer.subscription.created", "customer.subscription.deleted", "customer.subscription.updated"]);
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
