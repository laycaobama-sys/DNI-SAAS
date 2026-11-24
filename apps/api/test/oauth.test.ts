import { describe, expect, it } from "vitest";
import { safeNext } from "../src/routes/oauth";
import { createHarness } from "./helpers";

const CLIENT_ID = "test-client.apps.googleusercontent.com";

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: object) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;

/** Harness with Google configured and a fake token endpoint that returns `claims` (nonce echoed). */
function googleHarness(claims: (nonce: string) => Record<string, unknown>, tokenStatus = 200) {
  const h = createHarness();
  Object.assign(h.env, { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "test-secret" });
  const tokenCalls: URLSearchParams[] = [];
  let currentNonce = "";
  const realFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://oauth2.googleapis.com/token") {
      tokenCalls.push(new URLSearchParams(String(init?.body)));
      if (tokenStatus !== 200) return new Response("{}", { status: tokenStatus });
      return Response.json({ id_token: jwt(claims(currentNonce)), access_token: "x" });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  /** Runs start → (simulated Google consent) → callback, returning the callback response. */
  async function login(client = new h.Client(), opts: { next?: string; tamperState?: boolean; dropCookie?: boolean } = {}) {
    const start = await h.app.request(`/api/v1/auth/google/start${opts.next ? `?next=${encodeURIComponent(opts.next)}` : ""}`, { headers: { "cf-connecting-ip": "203.0.113.9" } }, h.env, h.ctx);
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    const stateCookie = /dni_oauth_state=([0-9a-f]{64})/.exec(start.headers.get("set-cookie") ?? "")?.[1];
    currentNonce = loc.searchParams.get("nonce")!;
    let state = loc.searchParams.get("state")!;
    if (opts.tamperState) state = state.replace(/^./, (ch) => (ch === "a" ? "b" : "a"));
    const cookie = [opts.dropCookie ? "" : `dni_oauth_state=${stateCookie}`, client.cookie].filter(Boolean).join("; ");
    const cb = await h.app.request(`/api/v1/auth/google/callback?state=${state}&code=authcode123`, { headers: { cookie, "cf-connecting-ip": "203.0.113.9" } }, h.env, h.ctx);
    const sess = /dni_session=([0-9a-f]{64})/.exec(cb.headers.get("set-cookie") ?? "")?.[1];
    if (sess) client.cookie = `dni_session=${sess}`;
    return { start, loc, cb, client, location: cb.headers.get("location") ?? "", state };
  }
  return { h, login, tokenCalls };
}

const good = (over: Record<string, unknown> = {}) => (nonce: string) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "google-sub-1",
  email: "Nueva@Gmail.com",
  email_verified: true,
  name: "Nueva Usuaria",
  exp: Math.floor(Date.now() / 1000) + 3600,
  nonce,
  ...over,
});

describe("Google sign-in (OIDC + PKCE)", () => {
  it("options expose only platform capabilities", async () => {
    const h = createHarness();
    const r = await new h.Client().get("/api/v1/auth/options");
    expect(r.json).toEqual({ google: false, emailDelivery: "dev_mailbox" });
    Object.assign(h.env, { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "s" });
    expect((await new h.Client().get("/api/v1/auth/options")).json.google).toBe(true);
  });

  it("start redirects to Google with PKCE S256, state, nonce and the exact redirect URI", async () => {
    const { login, tokenCalls } = googleHarness(good());
    const { loc, cb, location } = await login();
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8787/api/v1/auth/google/callback");
    expect(loc.searchParams.get("scope")).toBe("openid email");
    expect(cb.status).toBe(302);
    expect(location).toBe("/app/");
    expect(tokenCalls[0]!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(tokenCalls[0]!.get("client_secret")).toBe("test-secret");
  });

  it("creates a verified user with no usable password and a working session", async () => {
    const { h, login } = googleHarness(good());
    const { client } = await login();
    const me = await client.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    const u = await h.db.prepare("SELECT email, email_verified_at, password_hash FROM users").first<Record<string, string>>();
    expect(u!.email).toBe("nueva@gmail.com");
    expect(u!.email_verified_at).toBeTruthy();
    expect(u!.password_hash).toBe("oauth$disabled");
    // The disabled marker can never be used to log in with a password.
    expect((await new h.Client().post("/api/v1/auth/login", { email: "nueva@gmail.com", password: "oauth$disabled" })).status).toBe(401);
    // A second login reuses the identity (no duplicate user).
    await login();
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(1);
  });

  it("state is single-use and bound to the browser cookie", async () => {
    const { h, login } = googleHarness(good());
    expect((await login(undefined, { tamperState: true })).location).toContain("oauth_error=state_mismatch");
    expect((await login(undefined, { dropCookie: true })).location).toContain("oauth_error=state_mismatch");
    // Replay of a consumed state.
    const first = await login();
    expect(first.location).toBe("/app/");
    const replay = await h.app.request(`/api/v1/auth/google/callback?state=${first.state}&code=x`, { headers: { cookie: `dni_oauth_state=${first.state}` } }, h.env, h.ctx);
    expect(replay.headers.get("location")).toContain("oauth_error=state_expired");
  });

  it.each([
    ["wrong audience", { aud: "other-client" }, "id_token_audience"],
    ["wrong issuer", { iss: "https://evil.example" }, "id_token_issuer"],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }, "id_token_expired"],
    ["unverified email", { email_verified: false }, "email_not_verified_by_google"],
  ])("rejects an ID token with %s", async (_n, over, code) => {
    const { h, login } = googleHarness(good(over));
    expect((await login()).location).toContain(`oauth_error=${code}`);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM users").first("n")).toBe(0);
  });

  it("rejects a nonce that does not match the one issued", async () => {
    const { login } = googleHarness((n) => good({ nonce: n + "x" })(n));
    expect((await login()).location).toContain("oauth_error=id_token_nonce");
  });

  it("token endpoint failure fails closed", async () => {
    const { login } = googleHarness(good(), 400);
    expect((await login()).location).toContain("oauth_error=token_exchange_failed");
  });

  it("pre-registered UNVERIFIED account: Google proves ownership, the attacker's password and sessions die", async () => {
    const { h, login } = googleHarness(good());
    const attacker = new h.Client();
    await attacker.post("/api/v1/auth/register", { email: "nueva@gmail.com", password: "Attack3rPassword", name: "Mallory" });
    const { client } = await login();
    expect((await client.get("/api/v1/auth/me")).status).toBe(200);
    const u = await h.db.prepare("SELECT password_hash, email_verified_at FROM users").first<Record<string, string>>();
    expect(u!.password_hash).toBe("oauth$disabled");
    expect((await attacker.post("/api/v1/auth/login", { email: "nueva@gmail.com", password: "Attack3rPassword" })).status).toBe(401);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.link_google_verified'").first("n")).toBe(1);
  });

  it("existing VERIFIED account is linked and keeps its password", async () => {
    const { h, login } = googleHarness(good({ email: "owner@luna.es" }));
    await h.signup("owner@luna.es");
    await login();
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM user_identities").first("n")).toBe(1);
    expect((await new h.Client().post("/api/v1/auth/login", { email: "owner@luna.es", password: "Sup3rSecretPass" })).status).toBe(200);
  });

  it("not configured → no redirect to Google", async () => {
    const h = createHarness();
    const r = await h.app.request("/api/v1/auth/google/start", {}, h.env, h.ctx);
    expect(r.headers.get("location")).toContain("oauth_error=google_not_configured");
  });

  it("only same-app paths are accepted as the post-login destination", async () => {
    expect(safeNext("/app/orgs/1")).toBe("/app/orgs/1");
    for (const bad of ["https://evil.example", "//evil.example", "/app//evil", "/\\evil", "/api/v1/x", "javascript:alert(1)"]) expect(safeNext(bad)).toBe("/app/");
    const { login } = googleHarness(good());
    expect((await login(undefined, { next: "https://evil.example" })).location).toBe("/app/");
  });
});
