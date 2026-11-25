import { describe, expect, it } from "vitest";
import { scheduleGscSyncs, validSiteUrl } from "../src/lib/gsc";
import { createHarness } from "./helpers";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const GSC = "https://www.googleapis.com/auth/webmasters.readonly";
const RT = ["rt", "plain", "refresh", "value"].join("-");
const KEY = "0123456789abcdef".repeat(4);

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: object) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;

interface FakeOpts {
  scope?: string;
  refreshError?: string;
  sitesStatus?: number;
  noRefreshToken?: boolean;
}

function setup(opts: FakeOpts = {}) {
  const h = createHarness();
  Object.assign(h.env, { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-secret", DATA_ENC_KEY: KEY });
  const calls: { url: string; body: string; auth: string | null }[] = [];
  let nonce = "";
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
          ...(state.noRefreshToken ? {} : { refresh_token: RT }),
          scope: state.scope ?? `openid https://www.googleapis.com/auth/userinfo.email ${GSC}`,
          id_token: jwt({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "g-1", email: "Duena@Gmail.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, nonce }),
        });
      }
      if (state.refreshError) return Response.json({ error: state.refreshError }, { status: 400 });
      expect(p.get("refresh_token")).toBe(RT);
      return Response.json({ access_token: "at-2", scope: GSC });
    }
    if (url === "https://oauth2.googleapis.com/revoke") return new Response("", { status: 200 });
    if (url === "https://www.googleapis.com/webmasters/v3/sites") {
      if (state.sitesStatus) return Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: state.sitesStatus });
      return Response.json({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://other.example/", permissionLevel: "siteUnverifiedUser" },
          { siteUrl: "javascript:alert(1)", permissionLevel: "siteOwner" },
        ],
      });
    }
    if (url.startsWith("https://www.googleapis.com/webmasters/v3/sites/") && url.endsWith("/searchAnalytics/query")) {
      const q = JSON.parse(body);
      expect(q.dataState).toBe("final");
      if (q.dimensions[0] === "date") {
        return Response.json({
          rows: [
            { keys: ["2026-11-10"], clicks: 10, impressions: 200, ctr: 0.05, position: 8 },
            { keys: ["2026-11-11"], clicks: 30, impressions: 300, ctr: 0.1, position: 4 },
          ],
        });
      }
      if (q.dimensions[0] === "query") return Response.json({ rows: [{ keys: ["dni growth"], clicks: 25, impressions: 100, ctr: 0.25, position: 1.5 }] });
      // The 28 days before the current period (ends > 20 days ago): the home page had 100 clicks at position 2.
      if (Date.parse(q.endDate) < Date.now() - 20 * 86_400_000) {
        expect(q.rowLimit).toBe(250);
        return Response.json({ rows: [{ keys: ["https://example.com/"], clicks: 100, impressions: 600, ctr: 0.17, position: 2 }, { keys: ["https://example.com/ok"], clicks: 5, impressions: 50, ctr: 0.1, position: 3 }] });
      }
      return Response.json({ rows: [{ keys: ["https://example.com/"], clicks: 40, impressions: 500, ctr: 0.08, position: 5.6 }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  async function connect(client: InstanceType<typeof h.Client>, orgId: string, o: { denied?: boolean; swapClient?: InstanceType<typeof h.Client> } = {}) {
    const r = await client.post(`/api/v1/orgs/${orgId}/search-console/connect`);
    expect(r.status).toBe(200);
    const loc = new URL(r.json.url);
    nonce = loc.searchParams.get("nonce")!;
    const stateCookie = /dni_oauth_state=([0-9a-f]{64})/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    const who = o.swapClient ?? client;
    const q = o.denied ? `state=${loc.searchParams.get("state")}&error=access_denied` : `state=${loc.searchParams.get("state")}&code=authcode`;
    const cb = await h.app.request(`/api/v1/auth/google/callback?${q}`, { headers: { cookie: `dni_oauth_state=${stateCookie}; ${who.cookie}`, "cf-connecting-ip": "203.0.113.7" } }, h.env, h.ctx);
    return { loc, cb, location: cb.headers.get("location") ?? "" };
  }

  /** Explicit choice of the readable property (nothing is ever selected automatically). */
  async function pick(client: InstanceType<typeof h.Client>, orgId: string) {
    const g = (await client.get(`/api/v1/orgs/${orgId}/search-console`)).json;
    const pid = g.properties.find((p: any) => p.siteUrl === "sc-domain:example.com").id;
    expect((await client.put(`/api/v1/orgs/${orgId}/search-console/property`, { propertyId: pid })).status).toBe(200);
    return pid as string;
  }

  async function ownerOrg(email = "owner@example.com") {
    const owner = await h.signup(email);
    const orgId = await h.createOrg(owner, "Org GSC");
    await h.db.prepare("UPDATE organizations SET plan_code = 'agency' WHERE id = ?").bind(orgId).run();
    return { owner, orgId };
  }
  return { h, calls, connect, pick, ownerOrg, state };
}

describe("Search Console (F3): OAuth de solo lectura", () => {
  it("validSiteUrl accepts Search Console property formats only", () => {
    expect(validSiteUrl("sc-domain:example.com")).toBe(true);
    expect(validSiteUrl("https://example.com/")).toBe(true);
    expect(validSiteUrl("https://example.com")).toBe(false);
    expect(validSiteUrl("javascript:alert(1)")).toBe(false);
    expect(validSiteUrl("https://user:pw@example.com/")).toBe(false);
    expect(validSiteUrl("sc-domain:-bad")).toBe(false);
  });

  it("connect asks Google only for openid, email and webmasters.readonly, offline, on the registered callback", async () => {
    const { connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    const { loc, cb, location } = await connect(owner, orgId);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toBe(`openid email ${GSC}`);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8787/api/v1/auth/google/callback");
    expect(cb.status).toBe(302);
    expect(location).toBe(`/app/o/${orgId}/search-console?gsc=connected`);
  });

  it("stores the refresh token only encrypted, lists properties and never selects one automatically", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const g = await owner.get(`/api/v1/orgs/${orgId}/search-console`);
    expect(g.status).toBe(200);
    expect(g.json.connection.status).toBe("connected");
    expect(g.json.connection.account).toBe("duena@gmail.com");
    expect(g.json.properties.map((p: any) => p.siteUrl).sort()).toEqual(["https://other.example/", "sc-domain:example.com"]);
    expect(g.json.properties.find((p: any) => p.siteUrl === "sc-domain:example.com")).toMatchObject({ readable: true, selected: false });
    expect(g.json.properties.find((p: any) => p.siteUrl === "https://other.example/")).toMatchObject({ readable: false, selected: false });
    expect(g.json.report).toBeNull();
    expect(JSON.stringify(g.json)).not.toContain(RT);
    // Nothing in the database holds the plain token.
    for (const table of ["integrations", "integration_secrets", "audit_logs", "job_events", "oauth_states"]) {
      const { results } = await h.db.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(results)).not.toContain(RT);
    }
    const sec = await h.db.prepare("SELECT ciphertext FROM integration_secrets").first<{ ciphertext: string }>();
    expect(sec!.ciphertext).toMatch(/^v1\.[0-9a-f]+\.[0-9a-f]+$/);
    // Integrations card reflects this organization's connection.
    const integ = await owner.get(`/api/v1/orgs/${orgId}/integrations`);
    expect(integ.json.items.find((i: any) => i.key === "google_search_console").status).toBe("connected");
  });

  it("sync stores observed daily data and top rows, with source, period and caveats, at zero credits", async () => {
    const { h, calls, connect, pick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    expect((await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`)).json.code).toBe("gsc_no_property");
    await pick(owner, orgId);
    const s = await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`);
    expect(s.status).toBe(202);
    await h.drain();
    const job = await h.db.prepare("SELECT state, output_json FROM jobs WHERE id = ?").bind(s.json.jobId).first<{ state: string; output_json: string }>();
    expect(job!.state).toBe("completed");
    const g = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json;
    expect(g.report.siteUrl).toBe("sc-domain:example.com");
    expect(g.report.measurement).toEqual({ daily: "observed", totals: "derived", topRows: "observed" });
    expect(g.report.totals).toMatchObject({ days: 2, clicks: 40, impressions: 500 });
    expect(g.report.totals.ctr).toBeCloseTo(0.08);
    expect(g.report.totals.position).toBeCloseTo((8 * 200 + 4 * 300) / 500);
    expect(g.report.period).toEqual({ start: "2026-11-10", end: "2026-11-11" });
    expect(g.report.topQueries[0]).toMatchObject({ key: "dni growth", clicks: 25 });
    expect(g.report.topPages[0]).toMatchObject({ key: "https://example.com/" });
    expect(g.report.caveats.length).toBeGreaterThan(2);
    expect(g.report.observedAt).toBeTruthy();
    // Fixed Google host, encoded property, bearer token only on Google API calls.
    const q = calls.filter((c) => c.url.includes("searchAnalytics"));
    expect(q).toHaveLength(4);
    // Pages that lose clicks: current vs the 28 days before, derived without AI.
    expect(g.report.declining).toMatchObject({ measurement: "derived" });
    expect(g.report.declining.pages).toHaveLength(1);
    expect(g.report.declining.pages[0]).toMatchObject({ page: "https://example.com/", clicksBefore: 100, clicksNow: 40, lostClicks: 60, reason: "position" });
    expect(g.report.declining.pages[0].advice).toContain("posición");
    expect(q[0]!.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    expect(q.every((c) => c.auth === "Bearer at-2")).toBe(true);
    // Free job: no credit ledger rows.
    const ledger = await h.db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE job_id = ?").bind(s.json.jobId).first<{ n: number }>();
    expect(ledger!.n).toBe(0);
    // While a sync is pending, another request returns that job instead of queueing a second one.
    await h.db.prepare("UPDATE jobs SET state = 'queued' WHERE id = ?").bind(s.json.jobId).run();
    const dup = await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`);
    expect(dup.status).toBe(200);
    expect(dup.json).toMatchObject({ jobId: s.json.jobId, alreadyQueued: true });
  });

  it("before connecting, the panel shows the absence explicitly (no figures)", async () => {
    const { ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    const g = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json;
    expect(g).toMatchObject({ configured: true, canManage: true, connection: null, properties: [], report: null });
    expect((await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`)).status).toBe(409);
  });

  it("roles: editor/viewer cannot connect, sync, select or disconnect; account email hidden without integrations:read", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const editor = await h.invite(owner, orgId, "editor@example.com", "editor");
    const viewer = await h.invite(owner, orgId, "viewer@example.com", "client_viewer");
    const analyst = await h.invite(owner, orgId, "analyst@example.com", "analyst");
    const pid = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json.properties[0].id;
    for (const u of [editor, viewer, analyst]) {
      expect((await u.post(`/api/v1/orgs/${orgId}/search-console/connect`)).status).toBe(403);
      expect((await u.post(`/api/v1/orgs/${orgId}/search-console/sync`)).status).toBe(403);
      expect((await u.put(`/api/v1/orgs/${orgId}/search-console/property`, { propertyId: pid })).status).toBe(403);
      expect((await u.del(`/api/v1/orgs/${orgId}/search-console`)).status).toBe(403);
    }
    expect((await editor.get(`/api/v1/orgs/${orgId}/search-console`)).json.connection.account).toBeNull();
    expect((await viewer.get(`/api/v1/orgs/${orgId}/search-console`)).json.connection.account).toBeNull();
    expect((await analyst.get(`/api/v1/orgs/${orgId}/search-console`)).json.connection.account).toBe("duena@gmail.com");
  });

  it("tenancy: another organization cannot see or select this organization's property", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const pid = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json.properties[0].id;
    const other = await h.signup("other@example.com");
    const otherOrg = await h.createOrg(other, "Otra");
    expect((await other.get(`/api/v1/orgs/${orgId}/search-console`)).status).toBe(404);
    expect((await other.put(`/api/v1/orgs/${otherOrg}/search-console/property`, { propertyId: pid })).status).toBe(404);
    const g = (await other.get(`/api/v1/orgs/${otherOrg}/search-console`)).json;
    expect(g.connection).toBeNull();
    expect(g.properties).toEqual([]);
  });

  it("the callback refuses a different signed-in user and a denied/partial consent, storing nothing", async () => {
    const a = setup();
    const { owner, orgId } = await a.ownerOrg();
    const intruder = await a.h.signup("intruder@example.com");
    const r1 = await a.connect(owner, orgId, { swapClient: intruder });
    expect(r1.location).toBe(`/app/o/${orgId}/search-console?gsc_error=session_mismatch`);
    const r2 = await a.connect(owner, orgId, { denied: true });
    expect(r2.location).toBe(`/app/o/${orgId}/search-console?gsc_error=google_denied`);
    a.state.scope = "openid email";
    const r3 = await a.connect(owner, orgId);
    expect(r3.location).toBe(`/app/o/${orgId}/search-console?gsc_error=scope_not_granted`);
    a.state.scope = undefined;
    a.state.noRefreshToken = true;
    const r4 = await a.connect(owner, orgId);
    expect(r4.location).toBe(`/app/o/${orgId}/search-console?gsc_error=no_refresh_token`);
    expect((await a.h.db.prepare("SELECT COUNT(*) AS n FROM integrations").first<{ n: number }>())!.n).toBe(0);
    expect((await a.h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets").first<{ n: number }>())!.n).toBe(0);
  });

  it("a state cannot be replayed", async () => {
    const { h, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    const { loc } = await connect(owner, orgId);
    const replay = await h.app.request(`/api/v1/auth/google/callback?state=${loc.searchParams.get("state")}&code=x`, { headers: { cookie: owner.cookie } }, h.env, h.ctx);
    expect(replay.headers.get("location")).toContain("oauth_error=state_mismatch");
  });

  it("cannot select a property without read permission", async () => {
    const { connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const unverified = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json.properties.find((p: any) => p.siteUrl === "https://other.example/").id;
    const r = await owner.put(`/api/v1/orgs/${orgId}/search-console/property`, { propertyId: unverified });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("gsc_property_not_allowed");
  });

  it("revoked grant at Google → job fails permanently and the connection asks to reconnect", async () => {
    const { h, connect, pick, ownerOrg, state } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    await pick(owner, orgId);
    state.refreshError = "invalid_grant";
    const s = await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`);
    await h.drain();
    const job = await h.db.prepare("SELECT state, failure_code, attempts FROM jobs WHERE id = ?").bind(s.json.jobId).first<{ state: string; failure_code: string; attempts: number }>();
    expect(job).toMatchObject({ state: "failed", failure_code: "gsc_invalid_grant", attempts: 1 });
    const g = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json;
    expect(g.connection.status).toBe("reauth_required");
    expect((await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`)).status).toBe(409);
  });

  it("disconnect revokes at Google, deletes the encrypted token and keeps or purges data on request", async () => {
    const { h, calls, connect, pick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    await pick(owner, orgId);
    await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`);
    await h.drain();
    const d = await owner.del(`/api/v1/orgs/${orgId}/search-console`);
    expect(d.json).toEqual({ ok: true, revokedAtGoogle: true, grantInUseElsewhere: false, dataPurged: false });
    const revoke = calls.find((c) => c.url === "https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(revoke!.body).get("token")).toBe(RT);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets").first<{ n: number }>())!.n).toBe(0);
    const g = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json;
    expect(g.connection.status).toBe("disconnected");
    expect(g.report.totals.clicks).toBe(40);
    const audit = await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action LIKE 'integration.%' ORDER BY created_at, rowid").bind(orgId).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["integration.connect", "integration.gsc_property_select", "integration.gsc_sync", "integration.disconnect"]);
    // Reconnect, then disconnect with purge.
    await connect(owner, orgId);
    const p = await owner.del(`/api/v1/orgs/${orgId}/search-console?purge=true`);
    expect(p.json.dataPurged).toBe(true);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM gsc_daily_metrics").first<{ n: number }>())!.n).toBe(0);
  });

  it("disconnecting one organisation never revokes a Google grant another organisation still uses", async () => {
    const { h, calls, connect, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    const orgB = await h.createOrg(owner, "Org GSC B");
    await h.db.prepare("UPDATE organizations SET plan_code = 'agency' WHERE id = ?").bind(orgB).run();
    // Same Google account (Google returns the same grant) connected in two organisations.
    await connect(owner, orgId);
    await connect(owner, orgB);
    const revokes = () => calls.filter((c) => c.url === "https://oauth2.googleapis.com/revoke").length;

    const a = await owner.del(`/api/v1/orgs/${orgId}/search-console`);
    expect(a.json).toEqual({ ok: true, revokedAtGoogle: false, grantInUseElsewhere: true, dataPurged: false });
    expect(revokes()).toBe(0);
    // Org B keeps working: still connected, token still stored and usable.
    expect((await owner.get(`/api/v1/orgs/${orgB}/search-console`)).json.connection.status).toBe("connected");
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets WHERE organization_id = ?").bind(orgB).first<{ n: number }>())!.n).toBe(1);
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE organization_id = ? AND action = 'integration.disconnect'").bind(orgId).first<{ after_redacted: string }>();
    expect(JSON.parse(audit!.after_redacted)).toMatchObject({ revokedAtGoogle: false, grantInUseElsewhere: true });

    // The last connection that uses the account does revoke the grant at Google.
    const b = await owner.del(`/api/v1/orgs/${orgB}/search-console`);
    expect(b.json).toEqual({ ok: true, revokedAtGoogle: true, grantInUseElsewhere: false, dataPurged: false });
    expect(revokes()).toBe(1);
  });

  it("Search Console API disabled → connected but the panel explains the error; properties refresh later", async () => {
    const { h, connect, ownerOrg, state } = setup({ sitesStatus: 403 });
    const { owner, orgId } = await ownerOrg();
    const { location } = await connect(owner, orgId);
    expect(location).toBe(`/app/o/${orgId}/search-console?gsc=connected&gsc_error=sites_PERMISSION_DENIED`);
    state.sitesStatus = undefined;
    expect((await owner.post(`/api/v1/orgs/${orgId}/search-console/properties/refresh`)).status).toBe(200);
    expect((await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json.properties).toHaveLength(2);
    void h;
  });

  it("cron schedules one automatic refresh per selected property per day", async () => {
    const { h, connect, pick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    expect(await scheduleGscSyncs(h.env)).toHaveLength(0); // nothing selected → nothing imported
    await pick(owner, orgId);
    const first = await scheduleGscSyncs(h.env);
    expect(first).toHaveLength(1);
    expect(await scheduleGscSyncs(h.env)).toHaveLength(0);
    const n = await h.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND kind = 'gsc_sync'").bind(orgId).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("deselecting stops syncs, cancels pending ones and can purge the imported data", async () => {
    const { h, connect, pick, ownerOrg } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const pid = await pick(owner, orgId);
    await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`);
    await h.drain();
    // A sync queued before the deselection imports nothing.
    const stale = await owner.post(`/api/v1/orgs/${orgId}/search-console/sync`);
    await h.drain();
    await h.db.prepare("UPDATE jobs SET state = 'queued', cancel_requested_at = NULL WHERE id = ?").bind(stale.json.jobId).run();
    const editor = await h.invite(owner, orgId, "editor@example.com", "editor");
    expect((await editor.del(`/api/v1/orgs/${orgId}/search-console/property`)).status).toBe(403);
    const d = await owner.del(`/api/v1/orgs/${orgId}/search-console/property?purge=true`);
    expect(d.json).toEqual({ ok: true, dataPurged: true });
    const g = (await owner.get(`/api/v1/orgs/${orgId}/search-console`)).json;
    expect(g.connection.status).toBe("connected");
    expect(g.report).toBeNull();
    expect(g.properties.find((p: any) => p.id === pid)).toMatchObject({ selected: false, lastSyncAt: null });
    for (const t of ["gsc_daily_metrics", "gsc_top_rows", "gsc_page_prev"]) expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
    expect(await scheduleGscSyncs(h.env)).toHaveLength(0);
    const cancelled = await h.db.prepare("SELECT cancel_requested_at FROM jobs WHERE id = ?").bind(stale.json.jobId).first<{ cancel_requested_at: string | null }>();
    expect(cancelled!.cancel_requested_at).toBeTruthy();
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'integration.gsc_property_deselect'").first<{ after_redacted: string }>();
    expect(JSON.parse(audit!.after_redacted)).toEqual({ siteUrl: "sc-domain:example.com", dataPurged: true });
    expect((await owner.del(`/api/v1/orgs/${orgId}/search-console/property`)).status).toBe(404);
  });
});
