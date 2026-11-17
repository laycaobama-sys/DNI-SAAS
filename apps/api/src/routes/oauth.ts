import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256Hex, timingSafeEqual } from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { mailMode } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { createSession } from "../lib/session";
import { addSeconds, hashIp, log, nowIso, uuid } from "../lib/util";

/**
 * "Continuar con Google" — OpenID Connect authorization-code flow with PKCE (S256), a one-time
 * state bound to an HttpOnly cookie, and a nonce. The ID token is obtained directly from Google's
 * token endpoint over TLS with our client secret (OIDC Core §3.1.3.7), and every claim we rely on
 * is validated: iss, aud, exp, nonce and email_verified.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const STATE_COOKIE = "dni_oauth_state";
const STATE_TTL = 600;
/** Password hash marker for accounts without a usable password (verifyPassword() rejects it). */
export const OAUTH_ONLY_PASSWORD = "oauth$disabled";

export const googleConfigured = (env: Env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET;
const redirectUri = (env: Env) => `${env.APP_ORIGIN}/api/v1/auth/google/callback`;
const secure = (env: Env) => env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test";

/** Only same-app relative paths are accepted as post-login destinations (no open redirect). */
export function safeNext(next: string | undefined | null): string {
  if (!next) return "/app/";
  if (!/^\/app(\/[A-Za-z0-9\-._~/?=&%]*)?$/.test(next) || next.includes("//") || next.includes("\\")) return "/app/";
  return next;
}

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const bin = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface GoogleClaims {
  sub: string;
  email: string;
  name: string;
}

/** Validates the ID token claims. Returns an error code (never throws) so the caller fails closed. */
export function validateIdToken(env: Env, idToken: string, nonce: string, now = Date.now()): GoogleClaims | { error: string } {
  const p = decodeJwtPayload(idToken);
  if (!p) return { error: "id_token_malformed" };
  if (!ISSUERS.has(String(p.iss))) return { error: "id_token_issuer" };
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.includes(env.GOOGLE_CLIENT_ID)) return { error: "id_token_audience" };
  if (typeof p.exp !== "number" || p.exp * 1000 < now - 60_000) return { error: "id_token_expired" };
  if (typeof p.nonce !== "string" || !timingSafeEqual(p.nonce, nonce)) return { error: "id_token_nonce" };
  if (p.email_verified !== true && p.email_verified !== "true") return { error: "email_not_verified_by_google" };
  if (typeof p.sub !== "string" || !p.sub || typeof p.email !== "string" || !p.email.includes("@")) return { error: "id_token_claims" };
  const email = p.email.toLowerCase().trim();
  const name = (typeof p.name === "string" && p.name.trim()) || email.split("@")[0]!;
  return { sub: p.sub, email, name: name.slice(0, 120) };
}

const fail = (c: Context<AppEnv>, code: string) => {
  log("warn", "oauth.google_failed", { code, requestId: c.get("requestId") });
  return c.redirect(`/app/login?oauth_error=${encodeURIComponent(code)}`, 302);
};

export const oauth = new Hono<AppEnv>();

/** Public capability flags for the login/register screens (no per-user information). */
oauth.get("/options", (c) => c.json({ google: googleConfigured(c.env), emailDelivery: mailMode(c.env) }));

oauth.get("/google/start", async (c) => {
  if (!googleConfigured(c.env)) return fail(c, "google_not_configured");
  await rateLimit(c.env.DB, `oauth-start:${await hashIp(c.env, c.req.header("cf-connecting-ip"))}`, 30, 600);
  const state = randomToken(32);
  const nonce = randomToken(16);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(nowIso()),
    c.env.DB.prepare("INSERT INTO oauth_states (id, provider, code_verifier, nonce, next_path, expires_at) VALUES (?, 'google', ?, ?, ?, ?)").bind(
      await sha256Hex(state),
      verifier,
      nonce,
      safeNext(c.req.query("next")),
      addSeconds(STATE_TTL),
    ),
  ]);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: secure(c.env), sameSite: "Lax", path: "/api/v1/auth/google", maxAge: STATE_TTL });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c.env),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString(), 302);
});

oauth.get("/google/callback", async (c) => {
  if (!googleConfigured(c.env)) return fail(c, "google_not_configured");
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const cookieState = getCookie(c, STATE_COOKIE) ?? "";
  deleteCookie(c, STATE_COOKIE, { path: "/api/v1/auth/google", secure: secure(c.env) });
  if (c.req.query("error")) return fail(c, "google_denied");
  if (!/^[0-9a-f]{64}$/.test(state) || !cookieState || !timingSafeEqual(state, cookieState)) return fail(c, "state_mismatch");

  // One-time consumption of the state row (replay-safe).
  const row = await c.env.DB.prepare("DELETE FROM oauth_states WHERE id = ? AND provider = 'google' AND expires_at > ? RETURNING code_verifier, nonce, next_path")
    .bind(await sha256Hex(state), nowIso())
    .first<{ code_verifier: string; nonce: string; next_path: string }>();
  if (!row) return fail(c, "state_expired");
  if (!code || code.length > 2048) return fail(c, "missing_code");

  let idToken: string | undefined;
  try {
    const res = await c.get("deps").fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri(c.env),
        code_verifier: row.code_verifier,
      }).toString(),
    });
    if (!res.ok) return fail(c, "token_exchange_failed");
    idToken = ((await res.json()) as { id_token?: string }).id_token;
  } catch {
    return fail(c, "token_exchange_failed");
  }
  if (!idToken) return fail(c, "token_exchange_failed");
  const claims = validateIdToken(c.env, idToken, row.nonce);
  if ("error" in claims) return fail(c, claims.error);

  const userId = await upsertGoogleUser(c, claims);
  await createSession(c, userId);
  return c.redirect(safeNext(row.next_path), 302);
});

/**
 * Account resolution:
 *  1. Google identity already linked → that user.
 *  2. Same email, already verified → link the identity.
 *  3. Same email, NOT verified → someone may have pre-registered this address. Google proved
 *     ownership, so we link, mark verified, DISABLE the unverified password and revoke sessions.
 *  4. Otherwise → new verified user with no usable password.
 */
async function upsertGoogleUser(c: Context<AppEnv>, g: GoogleClaims): Promise<string> {
  const db = c.env.DB;
  const requestId = c.get("requestId");
  const ipHash = await hashIp(c.env, c.req.header("cf-connecting-ip"));
  const linked = await db.prepare("SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_subject = ?").bind(g.sub).first<{ user_id: string }>();
  if (linked) {
    await db.batch([
      db.prepare("UPDATE user_identities SET last_login_at = ?, email = ? WHERE provider = 'google' AND provider_subject = ?").bind(nowIso(), g.email, g.sub),
      db.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?").bind(linked.user_id),
      auditStmt(db, { organizationId: null, actorUserId: linked.user_id, action: "user.login_google", entityType: "user", entityId: linked.user_id, ipHash, requestId }),
    ]);
    return linked.user_id;
  }
  const existing = await db.prepare("SELECT id, email_verified_at FROM users WHERE email = ?").bind(g.email).first<{ id: string; email_verified_at: string | null }>();
  if (existing) {
    const identity = db.prepare("INSERT INTO user_identities (id, user_id, provider, provider_subject, email, last_login_at) VALUES (?, ?, 'google', ?, ?, ?)").bind(uuid(), existing.id, g.sub, g.email, nowIso());
    if (existing.email_verified_at) {
      await db.batch([
        identity,
        auditStmt(db, { organizationId: null, actorUserId: existing.id, action: "user.link_google", entityType: "user", entityId: existing.id, ipHash, requestId }),
      ]);
    } else {
      await db.batch([
        identity,
        db.prepare("UPDATE users SET email_verified_at = ?, password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), OAUTH_ONLY_PASSWORD, nowIso(), existing.id),
        db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(), existing.id),
        db.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(nowIso(), existing.id),
        auditStmt(db, { organizationId: null, actorUserId: existing.id, action: "user.link_google_verified", entityType: "user", entityId: existing.id, after: { unverifiedPasswordDisabled: true }, ipHash, requestId }),
      ]);
    }
    return existing.id;
  }
  const id = uuid();
  await db.batch([
    db.prepare("INSERT INTO users (id, email, name, password_hash, email_verified_at) VALUES (?, ?, ?, ?, ?)").bind(id, g.email, g.name, OAUTH_ONLY_PASSWORD, nowIso()),
    db.prepare("INSERT INTO user_identities (id, user_id, provider, provider_subject, email, last_login_at) VALUES (?, ?, 'google', ?, ?, ?)").bind(uuid(), id, g.sub, g.email, nowIso()),
    auditStmt(db, { organizationId: null, actorUserId: id, action: "user.register_google", entityType: "user", entityId: id, ipHash, requestId }),
  ]);
  return id;
}

