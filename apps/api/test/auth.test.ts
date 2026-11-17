import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

describe("Auth", () => {
  it("register → verify email → login → me → logout", async () => {
    const h = createHarness();
    const c = new h.Client();
    const reg = await c.post("/api/v1/auth/register", { email: "Ana@Empresa.es", password: "Sup3rSecretPass", name: "Ana" });
    expect(reg.status).toBe(202);
    // Unverified users cannot log in.
    expect((await c.post("/api/v1/auth/login", { email: "ana@empresa.es", password: "Sup3rSecretPass" })).status).toBe(403);
    const token = await h.latestToken("ana@empresa.es", "verify");
    expect((await c.post("/api/v1/auth/verify-email", { token })).status).toBe(200);
    // Tokens are single-use.
    expect((await c.post("/api/v1/auth/verify-email", { token })).json.code).toBe("invalid_or_expired_token");
    expect((await c.post("/api/v1/auth/login", { email: "ana@empresa.es", password: "Sup3rSecretPass" })).status).toBe(200);
    const me = await c.get("/api/v1/auth/me");
    expect(me.json.user.email).toBe("ana@empresa.es");
    expect(me.json.user.emailVerified).toBe(true);
    // Session tokens are stored hashed, never in clear.
    const raw = c.cookie.split("=")[1]!;
    expect(await h.db.prepare("SELECT id FROM sessions WHERE id = ?").bind(raw).first()).toBeNull();
    await c.post("/api/v1/auth/logout");
    expect((await c.get("/api/v1/auth/me")).json.user).toBeNull();
  });

  it("does not reveal whether an email is registered", async () => {
    const h = createHarness();
    await h.signup("dup@x.es");
    const c = new h.Client();
    const again = await c.post("/api/v1/auth/register", { email: "dup@x.es", password: "Another1Password", name: "X" });
    expect(again.status).toBe(202);
    const unknown = await c.post("/api/v1/auth/login", { email: "nobody@x.es", password: "whatever123A" });
    const wrong = await c.post("/api/v1/auth/login", { email: "dup@x.es", password: "whatever123A" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.json.title).toBe(wrong.json.title);
  });

  it("validates password strength and input with problem+json", async () => {
    const h = createHarness();
    const r = await new h.Client().post("/api/v1/auth/register", { email: "bad", password: "short", name: "" });
    expect(r.status).toBe(422);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(r.json.errors.length).toBeGreaterThan(0);
  });

  it("locks the account after 5 failed attempts", async () => {
    const h = createHarness();
    await h.signup("lock@x.es");
    const c = new h.Client();
    for (let i = 0; i < 5; i++) expect((await c.post("/api/v1/auth/login", { email: "lock@x.es", password: "Wrong1Password" })).status).toBe(401);
    const locked = await c.post("/api/v1/auth/login", { email: "lock@x.es", password: "Sup3rSecretPass" });
    expect(locked.status).toBe(423);
  });

  it("rejects expired sessions", async () => {
    const h = createHarness();
    const c = await h.signup("exp@x.es");
    await h.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await c.get("/api/v1/auth/me")).json.user).toBeNull();
    expect((await c.post("/api/v1/orgs", { name: "Org" })).status).toBe(401);
  });

  it("password reset revokes every existing session", async () => {
    const h = createHarness();
    const c = await h.signup("reset@x.es");
    const other = new h.Client();
    await other.post("/api/v1/auth/password-reset/request", { email: "reset@x.es" });
    const token = await h.latestToken("reset@x.es", "reset");
    expect((await other.post("/api/v1/auth/password-reset/confirm", { token, password: "Brand1NewPassword" })).status).toBe(200);
    expect((await c.get("/api/v1/auth/me")).json.user).toBeNull();
    expect((await other.post("/api/v1/auth/login", { email: "reset@x.es", password: "Brand1NewPassword" })).status).toBe(200);
  });

  it("CSRF: state-changing requests without the custom header or from a foreign origin are rejected", async () => {
    const h = createHarness();
    const c = await h.signup("csrf@x.es");
    expect((await c.req("POST", "/api/v1/orgs", { name: "X" }, { "x-dni-csrf": "0" })).status).toBe(403);
    expect((await c.req("POST", "/api/v1/orgs", { name: "X" }, { origin: "https://evil.example.com" })).json.code).toBe("csrf");
  });

  it("sets hardened session cookie and security headers", async () => {
    const h = createHarness();
    await h.signup("cookie@x.es");
    const c = new h.Client();
    const r = await c.post("/api/v1/auth/login", { email: "cookie@x.es", password: "Sup3rSecretPass" });
    const set = r.headers.get("set-cookie")!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-request-id")).toBeTruthy();
  });

  it("dev mailbox is disabled outside development/test", async () => {
    const h = createHarness();
    h.env.ENVIRONMENT = "production";
    expect((await new h.Client().get("/api/v1/dev/mailbox?email=a@b.es")).status).toBe(404);
  });

  it("without a mail provider in production, registration says so honestly", async () => {
    const h = createHarness();
    h.env.ENVIRONMENT = "production";
    const r = await new h.Client().post("/api/v1/auth/register", { email: "p@x.es", password: "Sup3rSecretPass", name: "P" });
    expect(r.json.delivery).toBe("not_configured");
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM dev_mailbox").first("n")).toBe(0);
  });
});
