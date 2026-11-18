import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { can, isRole, maskEmail, randomToken, sha256Hex } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { GoogleApiError, googleReady, loadGoogleConnection, revokeToken, sealToken, type GoogleDataSource } from "../lib/google";
import { ApiError, notFound } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { addSeconds, log, nowIso, uuid } from "../lib/util";
import { validateIdToken } from "./oauth";

/**
 * Connect / complete / disconnect for read-only Google data sources. One consent per source with
 * the minimal scope, PKCE S256, a one-time state bound to organization + user, the shared registered
 * callback, and the refresh token stored only as an envelope bound to organization + integration.
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "dni_oauth_state";
const STATE_TTL = 600;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const panelPath = (src: GoogleDataSource, orgId: string) => `/app/o/${orgId}/${src.panel}`;
const callbackUri = (c: Context<AppEnv>) => `${c.env.APP_ORIGIN}/api/v1/auth/google/callback`;
const secure = (c: Context<AppEnv>) => c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test";

/** POST …/connect: returns the Google consent URL (the SPA navigates to it). */
export async function startGoogleConnect(c: Context<AppEnv>, src: GoogleDataSource) {
  const t = c.get("tenant");
  if (!googleReady(c.env)) throw new ApiError(503, `${src.aadPrefix}_not_configured`, "La conexión con Google no está configurada en este entorno.");
  await rateLimit(c.env.DB, `${src.aadPrefix}-connect:${t.orgId}`, 10, 3600);
  const state = randomToken(32);
  const nonce = randomToken(16);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(nowIso()),
    c.env.DB.prepare("INSERT INTO oauth_states (id, provider, code_verifier, nonce, next_path, expires_at, organization_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      await sha256Hex(state),
      src.stateProvider,
      verifier,
      nonce,
      panelPath(src, t.orgId),
      addSeconds(STATE_TTL),
      t.orgId,
      t.userId,
    ),
  ]);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/api/v1/auth/google", maxAge: STATE_TTL });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUri(c),
    response_type: "code",
    scope: `openid email ${src.scope}`,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return c.json({ url: url.toString() });
}

/**
 * Second half of the connect flow, called from the shared Google callback once the one-time state row
 * has been consumed. The session user must be the one who started it and must still be allowed to
 * manage integrations in that organization. `afterConnect` lists what the account can read.
 */
export async function completeGoogleConnect(
  c: Context<AppEnv>,
  src: GoogleDataSource,
  row: { code_verifier: string; nonce: string; organization_id: string | null; user_id: string | null },
  code: string | null,
  afterConnect: (accessToken: string, orgId: string, integrationId: string) => Promise<void>,
  listErrorPrefix: string,
) {
  const p = src.aadPrefix;
  const orgId = row.organization_id ?? "";
  const back = (q: string) => c.redirect(`${panelPath(src, orgId)}?${q}`, 302);
  const fail = (err: string) => {
    log("warn", `${p}.connect_failed`, { code: err, requestId: c.get("requestId") });
    return /^[0-9a-f-]{36}$/.test(orgId) ? back(`${p}_error=${encodeURIComponent(err)}`) : c.redirect("/app/", 302);
  };
  const user = c.get("user");
  if (!user || !row.user_id || user.id !== row.user_id) return fail("session_mismatch");
  const m = await c.env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, user.id).first<{ role: string }>();
  if (!m || !isRole(m.role) || !can(m.role, "integrations:manage")) return fail("forbidden");
  if (!googleReady(c.env)) return fail("not_configured");
  if (!code) return fail("google_denied");
  if (code.length > 2048) return fail("missing_code");

  let tok: { access_token?: string; refresh_token?: string; scope?: string; id_token?: string };
  try {
    const res = await c.get("deps").fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: callbackUri(c),
        code_verifier: row.code_verifier,
      }).toString(),
    });
    if (!res.ok) return fail("token_exchange_failed");
    tok = (await res.json()) as typeof tok;
  } catch {
    return fail("token_exchange_failed");
  }
  if (!tok.id_token || !tok.access_token) return fail("token_exchange_failed");
  const claims = validateIdToken(c.env, tok.id_token, row.nonce);
  if ("error" in claims) return fail(claims.error);
  // Granular consent: the user may untick the data permission.
  if (!(tok.scope ?? "").split(" ").includes(src.scope)) return fail("scope_not_granted");
  if (!tok.refresh_token) return fail("no_refresh_token");

  const db = c.env.DB;
  const existing = await db.prepare("SELECT id FROM integrations WHERE organization_id = ? AND provider = ?").bind(orgId, src.provider).first<{ id: string }>();
  const integrationId = existing?.id ?? uuid();
  const secretId = uuid();
  const sealed = await sealToken(c.env, src, orgId, integrationId, tok.refresh_token);
  const scopes = JSON.stringify([src.scope]);
  await db.batch([
    existing
      ? db
          .prepare("UPDATE integrations SET status = 'connected', scopes_json = ?, account_ref = ?, secret_ref = ?, last_error = NULL WHERE organization_id = ? AND id = ?")
          .bind(scopes, claims.email, `integration_secrets:${secretId}`, orgId, integrationId)
      : db
          .prepare("INSERT INTO integrations (id, organization_id, provider, status, scopes_json, account_ref, secret_ref) VALUES (?, ?, ?, 'connected', ?, ?, ?)")
          .bind(integrationId, orgId, src.provider, scopes, claims.email, `integration_secrets:${secretId}`),
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(orgId, integrationId),
    db.prepare("INSERT INTO integration_secrets (id, organization_id, integration_id, ciphertext) VALUES (?, ?, ?, ?)").bind(secretId, orgId, integrationId, sealed),
    auditStmt(db, {
      organizationId: orgId,
      actorUserId: user.id,
      action: "integration.connect",
      entityType: "integration",
      entityId: integrationId,
      after: { provider: src.provider, account: maskEmail(claims.email), scopes: [src.scope] },
      requestId: c.get("requestId"),
    }),
  ]);
  try {
    await afterConnect(tok.access_token, orgId, integrationId);
  } catch (e) {
    const codeStr = e instanceof GoogleApiError ? e.code : "list_failed";
    await db.prepare("UPDATE integrations SET last_error = ? WHERE organization_id = ? AND id = ?").bind(`${listErrorPrefix}:${codeStr}`, orgId, integrationId).run();
    return back(`${p}=connected&${p}_error=${encodeURIComponent(`${listErrorPrefix}_${codeStr}`)}`);
  }
  return back(`${p}=connected`);
}

/**
 * DELETE: Google is asked to revoke the grant (best effort), the encrypted token is deleted, pending
 * syncs are cancelled and the connection is marked disconnected. Observed data stays unless purged.
 */
export async function disconnectGoogle(c: Context<AppEnv>, src: GoogleDataSource, purgeStmts: (orgId: string) => D1PreparedStatement[]) {
  const t = c.get("tenant");
  const db = c.env.DB;
  const purge = c.req.query("purge") === "true";
  const row = await db.prepare("SELECT id FROM integrations WHERE organization_id = ? AND provider = ?").bind(t.orgId, src.provider).first<{ id: string }>();
  if (!row) throw notFound("Conexión");
  let revoked: boolean;
  try {
    const conn = await loadGoogleConnection(c.env, src, t.orgId);
    revoked = await revokeToken(c.get("deps"), conn.refreshToken);
  } catch {
    revoked = false; // nothing usable to revoke (already disconnected or reauth needed)
  }
  await db.batch([
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, row.id),
    db.prepare("UPDATE integrations SET status = 'disconnected', secret_ref = NULL, last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, row.id),
    db
      .prepare("UPDATE jobs SET cancel_requested_at = ? WHERE organization_id = ? AND kind = ? AND state IN ('queued','validating','running') AND cancel_requested_at IS NULL")
      .bind(nowIso(), t.orgId, src.jobKind),
    ...(purge ? purgeStmts(t.orgId) : []),
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "integration.disconnect",
      entityType: "integration",
      entityId: row.id,
      after: { provider: src.provider, revokedAtGoogle: revoked, dataPurged: purge },
      requestId: c.get("requestId"),
    }),
  ]);
  return c.json({ ok: true, revokedAtGoogle: revoked, dataPurged: purge });
}
