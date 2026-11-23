import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { PRODUCT_EVENTS, PRODUCT_EVENTS_RETENTION_DAYS, purgeProductEvents, sanitizePath, sanitizeProps, trackEvent, visitorHash } from "../src/lib/product-events";
import { createHarness } from "./helpers";

/** Own cookieless product analytics (Fase 0.4, ADR 0021). */

type Harness = ReturnType<typeof createHarness>;
interface EventRow {
  id: string;
  organization_id: string | null;
  event: string;
  source: string;
  props_json: string;
  path: string | null;
  visitor_hash: string | null;
  created_at: string;
}

const rows = async (h: Harness, event?: string) =>
  (await h.db.prepare(`SELECT * FROM product_events ${event ? "WHERE event = ?" : ""} ORDER BY created_at`).bind(...(event ? [event] : [])).all<EventRow>()).results;

/** A browser beacon: no session, no CSRF header (sendBeacon cannot add one), JSON body. */
async function beacon(h: Harness, body: unknown, headers: Record<string, string> = {}) {
  const res = await h.app.request(
    "/api/v1/public/events",
    { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.23", "user-agent": "Mozilla/5.0 (Windows NT 10.0) Firefox/140.0", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) },
    h.env,
    h.ctx,
  );
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

describe("POST /api/v1/public/events", () => {
  it("records an allow-listed event without cookies, CSRF header, IP or personal data", async () => {
    const h = createHarness();
    const r = await beacon(h, {
      event: "audit_started",
      path: "https://dnigrowth.com/blog/guia?utm_source=x&email=ana@example.com#top",
      props: { from: "landing", email: "ana@example.com", phone: "600123456", site: "https://example.com", Bad_Key: "x", n: 3.14159 },
    });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, recorded: true });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("set-cookie")).toBeNull();

    const [row] = await rows(h);
    expect(row).toMatchObject({ event: "audit_started", source: "client", organization_id: null, path: "/blog/guia" });
    expect(JSON.parse(row!.props_json)).toEqual({ from: "landing", n: 3.14 });
    expect(row!.visitor_hash).toMatch(/^[0-9a-f]{32}$/);
    const stored = JSON.stringify(row);
    for (const leak of ["198.51.100.23", "ana@example.com", "600123456", "utm_source", "Firefox"]) expect(stored).not.toContain(leak);
    // The table has no column that could hold an IP, an email or a user agent.
    const cols = (await h.db.prepare("SELECT name FROM pragma_table_info('product_events')").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols.sort()).toEqual(["created_at", "event", "id", "organization_id", "path", "props_json", "source", "visitor_hash"]);
  });

  it("accepts only the allow-list and the documented fields", async () => {
    const h = createHarness();
    expect((await beacon(h, { event: "purchase" })).status).toBe(422);
    expect((await beacon(h, { event: "signup", organizationId: "00000000-0000-4000-8000-000000000000" })).status).toBe(422);
    expect((await beacon(h, { event: "signup", props: { nested: { a: 1 } } })).status).toBe(422);
    expect((await beacon(h, "not json")).status).toBe(400);
    expect(await rows(h)).toHaveLength(0);
    for (const event of PRODUCT_EVENTS) expect((await beacon(h, { event })).status, event).toBe(202);
    expect(await rows(h)).toHaveLength(PRODUCT_EVENTS.length);
  });

  it("keeps no visitor code when the browser sends a privacy signal, and does not count bots", async () => {
    const h = createHarness();
    await beacon(h, { event: "audit_teaser_viewed" }, { "sec-gpc": "1" });
    await beacon(h, { event: "audit_teaser_viewed" }, { dnt: "1" });
    expect((await rows(h)).map((r) => r.visitor_hash)).toEqual([null, null]);
    const bot = await beacon(h, { event: "audit_started" }, { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(bot.status).toBe(202);
    expect(bot.json.recorded).toBe(false);
    expect(await rows(h, "audit_started")).toHaveLength(0);
  });

  it("rejects other origins, oversized bodies and floods from one IP", async () => {
    const h = createHarness();
    expect((await beacon(h, { event: "signup" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await beacon(h, { event: "signup" }, { origin: "http://localhost:8787" })).status).toBe(202);
    const big = JSON.stringify({ event: "signup", props: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "x".repeat(150)])) });
    expect(big.length).toBeGreaterThan(2048);
    expect((await beacon(h, big, { "content-length": String(big.length) })).status).toBe(413);
    // Without a declared length the stream is cut while it is read: rejected and nothing is stored.
    expect((await beacon(h, big)).status).toBeGreaterThanOrEqual(400);
    expect(await rows(h)).toHaveLength(1);

    const flood = createHarness();
    for (let i = 0; i < 60; i++) expect((await beacon(flood, { event: "audit_started" })).status).toBe(202);
    expect((await beacon(flood, { event: "audit_started" })).status).toBe(429);
    // Another IP is not affected.
    expect((await beacon(flood, { event: "audit_started" }, { "cf-connecting-ip": "198.51.100.99" })).status).toBe(202);
  });
});

describe("server-side instrumentation", () => {
  it("records signup, email verification and organisation creation once each", async () => {
    const h = createHarness();
    const owner = await h.signup("ana@luna.es", "Ana");
    // Registering the same address again (enumeration-safe 202) is not a second signup.
    expect((await new h.Client().post("/api/v1/auth/register", { email: "ana@luna.es", password: "Sup3rSecretPass", name: "Ana" })).status).toBe(202);
    const orgId = await h.createOrg(owner, "Panadería Luna");

    const signup = await rows(h, "signup");
    expect(signup).toHaveLength(1);
    expect(signup[0]).toMatchObject({ source: "server", organization_id: null, path: "/api/v1/auth/register" });
    expect(JSON.parse(signup[0]!.props_json)).toEqual({ method: "email" });
    const steps = await rows(h, "onboarding_step");
    expect(steps.map((s) => JSON.parse(s.props_json).step)).toEqual(["email_verified", "organization_created"]);
    expect(steps[1]!.organization_id).toBe(orgId);
    expect(JSON.stringify(await rows(h))).not.toContain("ana@luna.es");
  });

  it("records audit_started for a new analysis but not for an idempotent replay", async () => {
    const h = createHarness({ site: { "https://panaderia-luna.es/": { body: "<!doctype html><title>Luna</title><h1>Pan</h1>" } } });
    const owner = await h.signup("owner@luna.es", "Lucía");
    const orgId = await h.createOrg(owner, "Panadería Luna SL");
    const a = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" }, { "idempotency-key": "same-key-123456" });
    const b = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" }, { "idempotency-key": "same-key-123456" });
    expect(a.status).toBe(202);
    expect(b.json.jobId).toBe(a.json.jobId);
    const started = await rows(h, "audit_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ source: "server", organization_id: orgId, path: "/api/v1/orgs/:id/sites/analyze" });
    expect(started[0]!.props_json).not.toContain("panaderia");
    await h.drain();
  });

  it("records gsc_connected when the Search Console connection completes", async () => {
    const CLIENT_ID = "test-client.apps.googleusercontent.com";
    const h = createHarness();
    Object.assign(h.env, { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-secret", DATA_ENC_KEY: "0123456789abcdef".repeat(4) });
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    let nonce = "";
    const realFetch = h.deps.fetchImpl;
    h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        const claims = { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-1", email: "duena@gmail.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, nonce };
        return Response.json({
          access_token: "at-1",
          refresh_token: ["rt", "test", "value"].join("-"),
          scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/webmasters.readonly",
          id_token: `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`,
        });
      }
      if (url === "https://www.googleapis.com/webmasters/v3/sites") return Response.json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
      return realFetch(input, init);
    }) as typeof fetch;

    const owner = await h.signup("owner@example.com");
    const orgId = await h.createOrg(owner, "Org GSC", "agency");
    const r = await owner.post(`/api/v1/orgs/${orgId}/search-console/connect`);
    expect(r.status).toBe(200);
    // Starting the connection is not a connection.
    expect(await rows(h, "gsc_connected")).toHaveLength(0);
    const loc = new URL(r.json.url);
    nonce = loc.searchParams.get("nonce")!;
    const stateCookie = /dni_oauth_state=([0-9a-f]{64})/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    const cb = await h.app.request(
      `/api/v1/auth/google/callback?state=${loc.searchParams.get("state")}&code=authcode`,
      { headers: { cookie: `dni_oauth_state=${stateCookie}; ${owner.cookie}`, "cf-connecting-ip": "203.0.113.7" } },
      h.env,
      h.ctx,
    );
    expect(cb.headers.get("location")).toBe(`/app/o/${orgId}/search-console?gsc=connected`);
    const connected = await rows(h, "gsc_connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ source: "server", organization_id: orgId });
    expect(JSON.parse(connected[0]!.props_json)).toEqual({ reconnect: false });
    expect(JSON.stringify(connected)).not.toContain("duena@gmail.com");
  });
});

describe("GET /api/v1/admin/funnel", () => {
  it("is invisible to non-admins and gives admins 7/30-day aggregates with source and caveats", async () => {
    const h = createHarness();
    const user = await h.signup("user@luna.es", "Olga");
    expect((await user.get("/api/v1/admin/funnel")).status).toBe(404);

    const now = Date.now();
    await trackEvent(h.env.DB, { event: "audit_started", source: "client", visitorHash: "a".repeat(32) });
    await trackEvent(h.env.DB, { event: "audit_started", source: "client", visitorHash: "a".repeat(32) });
    await trackEvent(h.env.DB, { event: "audit_started", source: "server", visitorHash: "b".repeat(32) });
    await trackEvent(h.env.DB, { event: "subscribed", at: new Date(now - 10 * 86400_000) });
    await trackEvent(h.env.DB, { event: "canceled", at: new Date(now - 40 * 86400_000) });

    const admin = await h.signup("admin@dni.es", "Admin");
    await h.db.prepare("UPDATE users SET is_platform_admin = 1 WHERE email = 'admin@dni.es'").run();
    const r = await admin.get("/api/v1/admin/funnel");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ measurement: "observed" });
    expect(r.json.source).toMatch(/product_events/);
    expect(r.json.caveats.length).toBeGreaterThanOrEqual(3);
    expect(Date.parse(r.json.observedAt)).not.toBeNaN();

    const [d7, d30] = r.json.windows;
    expect([d7.days, d30.days]).toEqual([7, 30]);
    const step = (w: any, e: string) => w.steps.find((s: any) => s.event === e);
    expect(step(d7, "audit_started")).toMatchObject({ server: 1, client: 2, total: 3, visitorDays: 2, instrumented: true, stage: "funnel" });
    // Two users signed up and verified through the real flow.
    expect(step(d7, "signup")).toMatchObject({ server: 2, total: 2, instrumented: true });
    expect(step(d7, "subscribed")).toMatchObject({ total: 0, visitorDays: null, instrumented: true });
    // Not recorded by any flow yet: shown as «sin instrumentar» so a zero is not read as «nobody did it».
    expect(step(d7, "cms_connected")).toMatchObject({ total: 0, instrumented: false, instrumentedBy: null });
    expect(step(d30, "subscribed").total).toBe(1);
    expect(step(d30, "canceled")).toMatchObject({ total: 0, stage: "churn" });
    expect(d7.steps.map((s: any) => s.event)).toEqual([...PRODUCT_EVENTS]);
    expect(d7.onboardingSteps).toEqual([{ step: "email_verified", n: 2 }]);
    // Aggregates only: no visitor codes, emails or row ids leave the database.
    const body = JSON.stringify(r.json);
    for (const leak of ["a".repeat(32), "user@luna.es", "admin@dni.es"]) expect(body).not.toContain(leak);
  });
});

describe("product-events library", () => {
  it("sanitises props: short labels, numbers and booleans only, at most 6 keys", () => {
    expect(sanitizeProps({ a: "ok", b: true, c: 2, d: "x@y.es", e: "www.x.es", f: "1234567", g: { x: 1 }, "9h": "x" })).toEqual({ a: "ok", b: true, c: 2 });
    expect(Object.keys(sanitizeProps(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]))))).toHaveLength(6);
    expect(sanitizeProps(null)).toEqual({});
    expect(sanitizeProps(["a"])).toEqual({});
    expect(sanitizeProps({ n: Number.NaN, big: 1e12, s: "x".repeat(65) })).toEqual({});
  });

  it("sanitises paths: no origin, query, fragment or identifiers", () => {
    expect(sanitizePath("https://dnigrowth.com/blog/x?utm=1#y")).toBe("/blog/x");
    expect(sanitizePath("/app/o/0b6c7a52-58b4-4a1e-9d3c-2f8f9c1d2e3a/crm/1234567")).toBe("/app/o/:id/crm/:n");
    expect(sanitizePath("javascript:alert(1)")).toBeNull();
    expect(sanitizePath("/a b<script>")).toBeNull();
    expect(sanitizePath(42)).toBeNull();
    expect(sanitizePath(`/${"a".repeat(300)}`)).toHaveLength(200);
  });

  it("rotates the visitor code daily and never computes it without a secret in production", async () => {
    const dev = { ENVIRONMENT: "test" } as Env;
    const d1 = new Date("2026-11-20T10:00:00Z");
    const d1b = new Date("2026-11-20T23:00:00Z");
    const d2 = new Date("2026-11-21T10:00:00Z");
    const a = await visitorHash(dev, "203.0.113.7", "UA", { at: d1 });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await visitorHash(dev, "203.0.113.7", "UA", { at: d1b })).toBe(a);
    expect(await visitorHash(dev, "203.0.113.7", "UA", { at: d2 })).not.toBe(a);
    expect(await visitorHash(dev, "203.0.113.8", "UA", { at: d1 })).not.toBe(a);
    expect(await visitorHash(dev, null, "UA")).toBeNull();
    expect(await visitorHash(dev, "203.0.113.7", "UA", { privacySignal: true })).toBeNull();
    expect(await visitorHash({ ENVIRONMENT: "production" } as Env, "203.0.113.7", "UA")).toBeNull();
    const salted = await visitorHash({ ENVIRONMENT: "production", IP_HASH_SALT: "s3cret" } as Env, "203.0.113.7", "UA", { at: d1 });
    expect(salted).toMatch(/^[0-9a-f]{32}$/);
    expect(salted).not.toBe(a);
  });

  it("trackEvent never throws into a business flow", async () => {
    const h = createHarness();
    expect(await trackEvent(h.env.DB, { event: "nope" as never })).toBe(false);
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    await expect(trackEvent(broken, { event: "signup" })).resolves.toBe(false);
    // A malformed visitor code is dropped, not stored.
    expect(await trackEvent(h.env.DB, { event: "signup", visitorHash: "203.0.113.7" })).toBe(true);
    expect((await rows(h))[0]!.visitor_hash).toBeNull();
  });

  it("purges events older than the retention period only", async () => {
    const h = createHarness();
    const now = new Date("2026-11-23T12:00:00Z");
    const day = 86400_000;
    await trackEvent(h.env.DB, { event: "signup", at: new Date(now.getTime() - (PRODUCT_EVENTS_RETENTION_DAYS + 1) * day) });
    await trackEvent(h.env.DB, { event: "signup", at: new Date(now.getTime() - (PRODUCT_EVENTS_RETENTION_DAYS - 1) * day) });
    expect(await purgeProductEvents(h.env.DB, now)).toBe(1);
    expect(await rows(h)).toHaveLength(1);
  });
});
