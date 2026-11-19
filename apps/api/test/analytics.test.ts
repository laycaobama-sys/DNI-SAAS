import { describe, expect, it } from "vitest";
import { processJobMessage } from "../src/jobs/consumer";
import { gaDate, scheduleGa4Syncs, validProperty } from "../src/lib/ga4";
import { createHarness } from "./helpers";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const GA4 = "https://www.googleapis.com/auth/analytics.readonly";
const GSC = "https://www.googleapis.com/auth/webmasters.readonly";
const RT = ["rt", "ga4", "plain", "refresh", "value"].join("-");
const KEY = "0123456789abcdef".repeat(4);

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: object) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
const mv = (...v: (string | number)[]) => v.map((x) => ({ value: String(x) }));
const META = { timeZone: "Europe/Madrid", currencyCode: "EUR" };

interface FakeOpts {
  scope?: string;
  refreshError?: string;
  adminStatus?: number;
  oneProperty?: boolean;
  lose111?: boolean;
}

function setup(opts: FakeOpts = {}) {
  const h = createHarness();
  Object.assign(h.env, { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-secret", DATA_ENC_KEY: KEY });
  const calls: { url: string; body: string; auth: string | null }[] = [];
  let nonce = "";
  let grantedScope = GA4;
  const state = { ...opts };
  const realFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    calls.push({ url, body, auth: headers.get("authorization") });
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "authorization_code") {
        return Response.json({
          access_token: "at-1",
          refresh_token: RT,
          scope: state.scope ?? `openid https://www.googleapis.com/auth/userinfo.email ${grantedScope}`,
          id_token: jwt({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-1", email: "Duena@Gmail.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, nonce }),
        });
      }
      if (state.refreshError) return Response.json({ error: state.refreshError }, { status: 400 });
      return Response.json({ access_token: "at-2", scope: grantedScope });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
    if (url === "https://www.googleapis.com/webmasters/v3/sites") return Response.json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
    if (url.startsWith("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?")) {
      if (state.adminStatus) return Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: state.adminStatus });
      const props = [
        ...(state.lose111 ? [] : [{ property: "properties/111", displayName: "Web principal" }]),
        ...(state.oneProperty ? [] : [{ property: "properties/222", displayName: "Tienda" }]),
        { property: "../../evil", displayName: "x" },
      ];
      return Response.json({ accountSummaries: [{ account: "accounts/9", displayName: "Cuenta demo", propertySummaries: props }] });
    }
    const m = /^https:\/\/analyticsdata\.googleapis\.com\/v1beta\/(properties\/\d+):runReport$/.exec(url);
    if (m) {
      const q = JSON.parse(body);
      const dim = q.dimensions[0]?.name;
      if (dim === "date") {
        return Response.json({
          dimensionHeaders: [{ name: "date" }],
          metricHeaders: q.metrics,
          rows: [
            { dimensionValues: [{ value: "20261110" }], metricValues: mv(10, 8, 30, 6, 1) },
            { dimensionValues: [{ value: "20261111" }], metricValues: mv(20, 15, 50, 12, "2.5") },
            { dimensionValues: [{ value: "garbage" }], metricValues: mv(1, 1, 1, 1, 1) },
          ],
          metadata: META,
        });
      }
      if (!dim) {
        expect(q.dateRanges.map((r: any) => r.name)).toEqual(["current", "previous"]);
        return Response.json({
          dimensionHeaders: [{ name: "dateRange" }],
          metricHeaders: q.metrics,
          rows: [
            { dimensionValues: [{ value: "current" }], metricValues: mv(30, 21, 80, 18, "3.5") },
            { dimensionValues: [{ value: "previous" }], metricValues: mv(15, 12, 40, 6, 0) },
          ],
          metadata: META,
        });
      }
      expect(q.orderBys[0].metric.metricName).toBe("sessions");
      const names = q.metrics.map((x: any) => x.name);
      expect(names).toEqual(["sessions", "totalUsers", "engagedSessions", "keyEvents"]);
      if (dim === "sessionDefaultChannelGroup") {
        return Response.json({
          dimensionHeaders: [{ name: dim }],
          metricHeaders: q.metrics,
          rows: [
            { dimensionValues: [{ value: "Organic Search" }], metricValues: mv(18, 12, 12, 2) },
            { dimensionValues: [{ value: "Direct" }], metricValues: mv(12, 9, 6, "1.5") },
          ],
          metadata: { ...META, subjectToThresholding: true },
        });
      }
      return Response.json({
        dimensionHeaders: [{ name: dim }],
        metricHeaders: q.metrics,
        rows: [{ dimensionValues: [{ value: "/" }], metricValues: mv(25, 18, 15, 3) }],
        metadata: META,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  async function connect(client: InstanceType<typeof h.Client>, orgId: string, o: { denied?: boolean; swapClient?: InstanceType<typeof h.Client>; panel?: "analytics" | "search-console" } = {}) {
    const panel = o.panel ?? "analytics";
    grantedScope = panel === "analytics" ? GA4 : GSC;
    const r = await client.post(`/api/v1/orgs/${orgId}/${panel}/connect`);
    expect(r.status).toBe(200);
    const loc = new URL(r.json.url);
    nonce = loc.searchParams.get("nonce")!;
    const stateCookie = /dni_oauth_state=([0-9a-f]{64})/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    const who = o.swapClient ?? client;
    const q = o.denied ? `state=${loc.searchParams.get("state")}&error=access_denied` : `state=${loc.searchParams.get("state")}&code=authcode`;
    const cb = await h.app.request(`/api/v1/auth/google/callback?${q}`, { headers: { cookie: `dni_oauth_state=${stateCookie}; ${who.cookie}`, "cf-connecting-ip": "203.0.113.7" } }, h.env, h.ctx);
    return { loc, cb, location: cb.headers.get("location") ?? "" };
  }

  async function ownerOrg(email = "owner@example.com") {
    const owner = await h.signup(email);
    const orgId = await h.createOrg(owner, "Org GA4", "growth");
    await h.db.prepare("UPDATE organizations SET plan_code = 'agency' WHERE id = ?").bind(orgId).run();
    return { owner, orgId };
  }

  async function connectAndPick(client: InstanceType<typeof h.Client>, orgId: string) {
    await connect(client, orgId);
    const g = (await client.get(`/api/v1/orgs/${orgId}/analytics`)).json;
    const pid = g.properties.find((p: any) => p.property === "properties/111").id;
    expect((await client.put(`/api/v1/orgs/${orgId}/analytics/property`, { propertyId: pid })).status).toBe(200);
    return pid as string;
  }
  return { h, calls, connect, connectAndPick, ownerOrg, state };
}

describe("Google Analytics 4 (F3): ingesta de solo lectura", () => {
  it("validProperty and gaDate accept only GA4 formats", () => {
    expect(validProperty("properties/123")).toBe(true);
    expect(validProperty("properties/abc")).toBe(false);
    expect(validProperty("../../evil")).toBe(false);
    expect(validProperty("properties/1/../x")).toBe(false);
    expect(gaDate("20261110")).toBe("2026-11-10");
    expect(gaDate("garbage")).toBeNull();
  });

  it("connect asks Google only for openid, email and analytics.readonly, offline, PKCE, on the registered callback", async () => {
    const { connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    const { loc, cb, location } = await connect(owner, orgId);
    expect(loc.searchParams.get("scope")).toBe(`openid email ${GA4}`);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8787/api/v1/auth/google/callback");
    expect(cb.status).toBe(302);
    expect(location).toBe(`/app/o/${orgId}/analytics?ga4=connected`);
  });

  it("stores the token only encrypted, lists valid properties and never auto-selects when there are several", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const g = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json;
    expect(g.connection).toMatchObject({ status: "connected", account: "duena@gmail.com", scopes: [GA4] });
    expect(g.properties.map((p: any) => p.property).sort()).toEqual(["properties/111", "properties/222"]);
    expect(g.properties.every((p: any) => p.readable && !p.selected && p.accountName === "Cuenta demo")).toBe(true);
    expect(g.report).toBeNull();
    for (const table of ["integrations", "integration_secrets", "audit_logs", "job_events", "oauth_states"]) {
      const { results } = await h.db.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(results)).not.toContain(RT);
    }
    expect(JSON.stringify(g)).not.toContain(RT);
    const integ = await owner.get(`/api/v1/orgs/${orgId}/integrations`);
    expect(integ.json.items.find((i: any) => i.key === "ga4").status).toBe("connected");
  });

  it("even a single readable property is never selected automatically (it may belong to another brand)", async () => {
    const { h, connect, ownerOrg } = setup({ oneProperty: true });
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const g = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json;
    expect(g.properties).toHaveLength(1);
    expect(g.properties[0]).toMatchObject({ property: "properties/111", selected: false });
    expect(g.report).toBeNull();
    expect(await scheduleGa4Syncs(h.env)).toHaveLength(0);
    expect((await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`)).json.code).toBe("ga4_no_property");
  });

  it("deselecting stops syncs, makes queued ones import nothing and can purge the imported data", async () => {
    const { h, connectAndPick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    const pid = await connectAndPick(owner, orgId);
    await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    await h.drain();
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM ga4_daily_metrics").first<{ n: number }>())!.n).toBe(2);
    const stale = await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    await h.drain();
    await h.db.prepare("UPDATE jobs SET state = 'queued', cancel_requested_at = NULL WHERE id = ?").bind(stale.json.jobId).run();
    const viewer = await h.invite(owner, orgId, "viewer@example.com", "client_viewer");
    expect((await viewer.del(`/api/v1/orgs/${orgId}/analytics/property`)).status).toBe(403);
    const d = await owner.del(`/api/v1/orgs/${orgId}/analytics/property?purge=true`);
    expect(d.json).toEqual({ ok: true, dataPurged: true });
    for (const t of ["ga4_daily_metrics", "ga4_period_totals", "ga4_top_rows"]) {
      expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
    }
    const g = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json;
    expect(g.connection.status).toBe("connected");
    expect(g.report).toBeNull();
    expect(g.properties.find((p: any) => p.id === pid)).toMatchObject({ selected: false, lastSyncAt: null });
    // The stale job was asked to cancel; even if it runs, it re-checks the selection and imports nothing.
    const job = await h.db.prepare("SELECT cancel_requested_at FROM jobs WHERE id = ?").bind(stale.json.jobId).first<{ cancel_requested_at: string | null }>();
    expect(job!.cancel_requested_at).toBeTruthy();
    await h.db.prepare("UPDATE jobs SET cancel_requested_at = NULL WHERE id = ?").bind(stale.json.jobId).run();
    await processJobMessage(h.env, { jobId: stale.json.jobId, organizationId: orgId, outboxId: "test" } as any, h.deps);
    const after = await h.db.prepare("SELECT state, failure_code FROM jobs WHERE id = ?").bind(stale.json.jobId).first();
    expect(after).toMatchObject({ state: "failed", failure_code: "ga4_property_not_selected" });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM ga4_daily_metrics").first<{ n: number }>())!.n).toBe(0);
    expect(await scheduleGa4Syncs(h.env)).toHaveLength(0);
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'integration.ga4_property_deselect'").first<{ after_redacted: string }>();
    expect(JSON.parse(audit!.after_redacted)).toEqual({ property: "properties/111", displayName: "Web principal", dataPurged: true });
  });

  it("sync stores observed daily data, de-duplicated period totals and top rows, with source, caveats and zero credits", async () => {
    const { h, calls, connectAndPick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connectAndPick(owner, orgId);
    const s = await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    expect(s.status).toBe(202);
    await h.drain();
    const job = await h.db.prepare("SELECT state FROM jobs WHERE id = ?").bind(s.json.jobId).first<{ state: string }>();
    expect(job!.state).toBe("completed");
    const r = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json.report;
    expect(r).toMatchObject({ property: "properties/111", displayName: "Web principal", timeZone: "Europe/Madrid", thresholded: true, sampled: false });
    expect(r.measurement).toEqual({ daily: "observed", totals: "observed", engagementRate: "derived", topRows: "observed" });
    expect(r.daily).toEqual([
      { date: "2026-11-10", sessions: 10, totalUsers: 8, screenPageViews: 30, engagedSessions: 6, keyEvents: 1 },
      { date: "2026-11-11", sessions: 20, totalUsers: 15, screenPageViews: 50, engagedSessions: 12, keyEvents: 2.5 },
    ]);
    // Users come from GA4's own period total (21), not the sum of daily users (23).
    expect(r.totals).toMatchObject({ sessions: 30, totalUsers: 21, screenPageViews: 80, engagedSessions: 18, keyEvents: 3.5 });
    expect(r.totals.engagementRate).toBeCloseTo(0.6);
    expect(r.previousTotals).toMatchObject({ sessions: 15, totalUsers: 12 });
    expect(r.topChannels.map((x: any) => x.key)).toEqual(["Organic Search", "Direct"]);
    expect(r.topLandingPages[0]).toMatchObject({ key: "/", sessions: 25 });
    expect(r.caveats[0]).toContain("umbrales");
    expect(r.observedAt).toBeTruthy();
    const rep = calls.filter((c) => c.url.includes("analyticsdata"));
    expect(rep).toHaveLength(4);
    expect(rep.every((c) => c.url === "https://analyticsdata.googleapis.com/v1beta/properties/111:runReport" && c.auth === "Bearer at-2")).toBe(true);
    const ledger = await h.db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE job_id = ?").bind(s.json.jobId).first<{ n: number }>();
    expect(ledger!.n).toBe(0);
    await h.db.prepare("UPDATE jobs SET state = 'queued' WHERE id = ?").bind(s.json.jobId).run();
    const dup = await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    expect(dup.json).toMatchObject({ jobId: s.json.jobId, alreadyQueued: true });
  });

  it("roles: only integrations:manage connects, selects, syncs or disconnects; account hidden without integrations:read", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const editor = await h.invite(owner, orgId, "editor@example.com", "editor");
    const viewer = await h.invite(owner, orgId, "viewer@example.com", "client_viewer");
    const pid = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json.properties[0].id;
    for (const u of [editor, viewer]) {
      expect((await u.post(`/api/v1/orgs/${orgId}/analytics/connect`)).status).toBe(403);
      expect((await u.post(`/api/v1/orgs/${orgId}/analytics/sync`)).status).toBe(403);
      expect((await u.put(`/api/v1/orgs/${orgId}/analytics/property`, { propertyId: pid })).status).toBe(403);
      expect((await u.del(`/api/v1/orgs/${orgId}/analytics`)).status).toBe(403);
      expect((await u.get(`/api/v1/orgs/${orgId}/analytics`)).json.connection.account).toBeNull();
    }
  });

  it("tenancy: another organization cannot read or select this organization's property", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const pid = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json.properties[0].id;
    const other = await h.signup("other@example.com");
    const otherOrg = await h.createOrg(other, "Otra", "growth");
    expect((await other.get(`/api/v1/orgs/${orgId}/analytics`)).status).toBe(404);
    expect((await other.put(`/api/v1/orgs/${otherOrg}/analytics/property`, { propertyId: pid })).status).toBe(404);
    expect((await other.get(`/api/v1/orgs/${otherOrg}/analytics`)).json).toMatchObject({ connection: null, properties: [], report: null });
  });

  it("the callback refuses another signed-in user, a denial and a consent without the Analytics scope", async () => {
    const a = setup();
    const { owner, orgId } = await a.ownerOrg();
    const intruder = await a.h.signup("intruder@example.com");
    expect((await a.connect(owner, orgId, { swapClient: intruder })).location).toBe(`/app/o/${orgId}/analytics?ga4_error=session_mismatch`);
    expect((await a.connect(owner, orgId, { denied: true })).location).toBe(`/app/o/${orgId}/analytics?ga4_error=google_denied`);
    a.state.scope = `openid email ${GSC}`;
    expect((await a.connect(owner, orgId)).location).toBe(`/app/o/${orgId}/analytics?ga4_error=scope_not_granted`);
    expect((await a.h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets").first<{ n: number }>())!.n).toBe(0);
  });

  it("Search Console and Analytics are separate grants: each token opens only for its own source", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId, { panel: "search-console" });
    await connect(owner, orgId);
    const { results } = await h.db.prepare("SELECT provider, scopes_json FROM integrations WHERE organization_id = ? ORDER BY provider").bind(orgId).all<{ provider: string; scopes_json: string }>();
    expect(results).toEqual([
      { provider: "ga4", scopes_json: JSON.stringify([GA4]) },
      { provider: "google_search_console", scopes_json: JSON.stringify([GSC]) },
    ]);
    // Swapping the envelopes between integrations must make both unreadable (AAD binds source + integration).
    const secs = await h.db.prepare("SELECT id, integration_id, ciphertext FROM integration_secrets WHERE organization_id = ?").bind(orgId).all<{ id: string; integration_id: string; ciphertext: string }>();
    expect(secs.results).toHaveLength(2);
    const [s1, s2] = secs.results as [{ id: string; ciphertext: string }, { id: string; ciphertext: string }];
    await h.db.batch([
      h.db.prepare("UPDATE integration_secrets SET ciphertext = ? WHERE id = ?").bind(s2.ciphertext, s1.id),
      h.db.prepare("UPDATE integration_secrets SET ciphertext = ? WHERE id = ?").bind(s1.ciphertext, s2.id),
    ]);
    expect((await owner.post(`/api/v1/orgs/${orgId}/analytics/properties/refresh`)).json).toMatchObject({ code: "ga4_not_connected", reason: "secret_unreadable" });
  });

  it("a property the account can no longer read cannot be selected or synced", async () => {
    const { h, connectAndPick, ownerOrg, state } = setup();
    const { owner, orgId } = await ownerOrg();
    const pid = await connectAndPick(owner, orgId);
    state.lose111 = true;
    expect((await owner.post(`/api/v1/orgs/${orgId}/analytics/properties/refresh`)).status).toBe(200);
    const g = (await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json;
    expect(g.properties.find((p: any) => p.id === pid)).toMatchObject({ readable: false, selected: false });
    const r = await owner.put(`/api/v1/orgs/${orgId}/analytics/property`, { propertyId: pid });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("ga4_property_not_allowed");
    // A sync queued before access was lost fails permanently on re-validation.
    await h.db.prepare("UPDATE ga4_properties SET accessible = 1, selected = 1 WHERE id = ?").bind(pid).run();
    const s = await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    await h.drain();
    const job = await h.db.prepare("SELECT state, failure_code FROM jobs WHERE id = ?").bind(s.json.jobId).first();
    expect(job).toMatchObject({ state: "failed", failure_code: "ga4_property_not_allowed" });
  });

  it("revoked grant → permanent failure and reconnect required", async () => {
    const { h, connectAndPick, ownerOrg, state } = setup();
    const { owner, orgId } = await ownerOrg();
    await connectAndPick(owner, orgId);
    state.refreshError = "invalid_grant";
    const s = await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    await h.drain();
    const job = await h.db.prepare("SELECT state, failure_code, attempts FROM jobs WHERE id = ?").bind(s.json.jobId).first();
    expect(job).toMatchObject({ state: "failed", failure_code: "ga4_invalid_grant", attempts: 1 });
    expect((await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json.connection.status).toBe("reauth_required");
    expect((await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`)).status).toBe(409);
  });

  it("Admin API disabled → connected with an explained error; disconnect revokes, deletes the token and purges on request", async () => {
    const { h, calls, connect, connectAndPick, ownerOrg, state } = setup({ adminStatus: 403 });
    const { owner, orgId } = await ownerOrg();
    expect((await connect(owner, orgId)).location).toBe(`/app/o/${orgId}/analytics?ga4=connected&ga4_error=properties_PERMISSION_DENIED`);
    state.adminStatus = undefined;
    await connectAndPick(owner, orgId);
    await owner.post(`/api/v1/orgs/${orgId}/analytics/sync`);
    await h.drain();
    const d = await owner.del(`/api/v1/orgs/${orgId}/analytics`);
    expect(d.json).toEqual({ ok: true, revokedAtGoogle: true, grantInUseElsewhere: false, dataPurged: false });
    expect(new URLSearchParams(calls.find((c) => c.url.endsWith("/revoke"))!.body).get("token")).toBe(RT);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets").first<{ n: number }>())!.n).toBe(0);
    expect((await owner.get(`/api/v1/orgs/${orgId}/analytics`)).json.report.totals.sessions).toBe(30);
    await connect(owner, orgId);
    expect((await owner.del(`/api/v1/orgs/${orgId}/analytics?purge=true`)).json.dataPurged).toBe(true);
    for (const t of ["ga4_properties", "ga4_daily_metrics", "ga4_period_totals", "ga4_top_rows"]) {
      expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
    }
    const audit = await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action LIKE 'integration.%' ORDER BY created_at").bind(orgId).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toContain("integration.ga4_property_select");
    expect(audit.results.map((r) => r.action)).toContain("integration.ga4_sync");
  });

  it("cron schedules one automatic refresh per selected property per day", async () => {
    const { h, connectAndPick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connectAndPick(owner, orgId);
    expect(await scheduleGa4Syncs(h.env)).toHaveLength(1);
    expect(await scheduleGa4Syncs(h.env)).toHaveLength(0);
  });
});
