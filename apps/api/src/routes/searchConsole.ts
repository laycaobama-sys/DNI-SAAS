import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { can, isRole, maskEmail, randomToken, sha256Hex } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import {
  GSC_PROVIDER,
  GSC_SCOPE,
  GSC_STATE_PROVIDER,
  GscError,
  gscReady,
  gscSyncJobStatements,
  listSites,
  loadConnection,
  accessTokenFromRefresh,
  markReauth,
  READABLE_PERMISSIONS,
  revokeToken,
  sealRefreshToken,
  storeProperties,
} from "../lib/gsc";
import { ApiError, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { dispatchOutbox } from "../jobs/queue";
import { requireScope } from "../middleware";
import { addSeconds, log, nowIso, uuid } from "../lib/util";
import { validateIdToken } from "./oauth";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_COOKIE = "dni_oauth_state";
const STATE_TTL = 600;

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const panelPath = (orgId: string) => `/app/o/${orgId}/search-console`;
const secure = (c: Context<AppEnv>) => c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test";

/** Caveats shown next to every Search Console figure. */
export const GSC_CAVEATS = [
  "Datos de Google Search Console con estado «final»: los últimos 2-3 días aún no aparecen.",
  "Google omite consultas anónimas o poco frecuentes por privacidad: la suma de consultas no coincide con el total.",
  "Clics e impresiones son de la Búsqueda de Google (web); no incluyen otros buscadores ni respuestas de IA.",
  "Search Console no garantiza posiciones futuras: describe el pasado observado.",
];

export const searchConsole = new Hono<AppEnv>();

const num = (v: unknown) => (typeof v === "number" ? v : 0);

searchConsole.get("/search-console", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await db
    .prepare("SELECT id, status, scopes_json, account_ref, last_sync_at, last_error, created_at FROM integrations WHERE organization_id = ? AND provider = ?")
    .bind(t.orgId, GSC_PROVIDER)
    .first<{ id: string; status: string; scopes_json: string; account_ref: string | null; last_sync_at: string | null; last_error: string | null; created_at: string }>();
  const canSeeAccount = can(t.role, "integrations:read");
  const { results: props } = await db
    .prepare("SELECT id, site_url, permission_level, selected, last_sync_at, last_error FROM gsc_properties WHERE organization_id = ? ORDER BY selected DESC, site_url")
    .bind(t.orgId)
    .all<{ id: string; site_url: string; permission_level: string; selected: number; last_sync_at: string | null; last_error: string | null }>();
  const sel = props.find((p) => p.selected === 1) ?? null;
  const activeJob = await db
    .prepare("SELECT id, state, progress, created_at FROM jobs WHERE organization_id = ? AND kind = 'gsc_sync' AND state IN ('queued','validating','running') ORDER BY created_at DESC LIMIT 1")
    .bind(t.orgId)
    .first();
  const lastJob = await db
    .prepare("SELECT id, state, failure_code, finished_at FROM jobs WHERE organization_id = ? AND kind = 'gsc_sync' AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT 1")
    .bind(t.orgId)
    .first();

  let report: unknown = null;
  if (sel) {
    const { results: daily } = await db
      .prepare("SELECT date, clicks, impressions, ctr, position, observed_at FROM gsc_daily_metrics WHERE organization_id = ? AND property_id = ? ORDER BY date DESC LIMIT 90")
      .bind(t.orgId, sel.id)
      .all<{ date: string; clicks: number; impressions: number; ctr: number; position: number; observed_at: string }>();
    daily.reverse();
    const sum = (rows: typeof daily) => {
      const clicks = rows.reduce((a, r) => a + num(r.clicks), 0);
      const impressions = rows.reduce((a, r) => a + num(r.impressions), 0);
      const pos = impressions ? rows.reduce((a, r) => a + num(r.position) * num(r.impressions), 0) / impressions : null;
      return { days: rows.length, clicks, impressions, ctr: impressions ? clicks / impressions : null, position: pos };
    };
    const last = daily.slice(-28);
    const prev = daily.length > 28 ? daily.slice(-56, -28) : [];
    const top = async (dimension: "query" | "page") =>
      (
        await db
          .prepare("SELECT key, clicks, impressions, ctr, position, period_start, period_end FROM gsc_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = ? ORDER BY clicks DESC, impressions DESC LIMIT 25")
          .bind(t.orgId, sel.id, dimension)
          .all()
      ).results;
    const observedAt = daily.reduce<string | null>((a, r) => (!a || r.observed_at > a ? r.observed_at : a), null);
    report = {
      propertyId: sel.id,
      siteUrl: sel.site_url,
      lastSyncAt: sel.last_sync_at,
      source: "Google Search Console API · searchAnalytics.query (dataState=final)",
      observedAt,
      measurement: { daily: "observed", totals: "derived", topRows: "observed" },
      period: last.length ? { start: last[0]!.date, end: last[last.length - 1]!.date } : null,
      previousPeriod: prev.length ? { start: prev[0]!.date, end: prev[prev.length - 1]!.date } : null,
      totals: last.length ? sum(last) : null,
      previousTotals: prev.length ? sum(prev) : null,
      daily,
      topQueries: await top("query"),
      topPages: await top("page"),
      caveats: GSC_CAVEATS,
    };
  }

  return c.json({
    configured: gscReady(c.env),
    canManage: can(t.role, "integrations:manage"),
    connection: conn
      ? {
          status: conn.status,
          scopes: JSON.parse(conn.scopes_json || "[]"),
          account: canSeeAccount ? conn.account_ref : null,
          connectedAt: conn.created_at,
          lastSyncAt: conn.last_sync_at,
          lastError: conn.last_error,
        }
      : null,
    properties: props.map((p) => ({
      id: p.id,
      siteUrl: p.site_url,
      permissionLevel: p.permission_level,
      readable: READABLE_PERMISSIONS.has(p.permission_level),
      selected: p.selected === 1,
      lastSyncAt: p.last_sync_at,
      lastError: p.last_error,
    })),
    activeJob,
    lastJob,
    report,
  });
});

/** Starts Google consent for the read-only Search Console scope. Returns the URL; the SPA navigates. */
searchConsole.post("/search-console/connect", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  if (!gscReady(c.env)) throw new ApiError(503, "gsc_not_configured", "La conexión con Google no está configurada en este entorno.");
  await rateLimit(c.env.DB, `gsc-connect:${t.orgId}`, 10, 3600);
  const state = randomToken(32);
  const nonce = randomToken(16);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(nowIso()),
    c.env.DB.prepare("INSERT INTO oauth_states (id, provider, code_verifier, nonce, next_path, expires_at, organization_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
      await sha256Hex(state),
      GSC_STATE_PROVIDER,
      verifier,
      nonce,
      panelPath(t.orgId),
      addSeconds(STATE_TTL),
      t.orgId,
      t.userId,
    ),
  ]);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: secure(c), sameSite: "Lax", path: "/api/v1/auth/google", maxAge: STATE_TTL });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${c.env.APP_ORIGIN}/api/v1/auth/google/callback`,
    response_type: "code",
    scope: `openid email ${GSC_SCOPE}`,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
  }).toString();
  return c.json({ url: url.toString() });
});

/**
 * Second half of the connect flow, called from the shared Google callback once the one-time state
 * row has been consumed. The session user must be the one who started it and must still be allowed
 * to manage integrations in that organization.
 */
export async function completeGscConnect(
  c: Context<AppEnv>,
  row: { code_verifier: string; nonce: string; organization_id: string | null; user_id: string | null },
  code: string | null,
) {
  const orgId = row.organization_id ?? "";
  const back = (q: string) => c.redirect(`${panelPath(orgId)}?${q}`, 302);
  const fail = (code: string) => {
    log("warn", "gsc.connect_failed", { code, requestId: c.get("requestId") });
    return /^[0-9a-f-]{36}$/.test(orgId) ? back(`gsc_error=${encodeURIComponent(code)}`) : c.redirect("/app/", 302);
  };
  const user = c.get("user");
  if (!user || !row.user_id || user.id !== row.user_id) return fail("session_mismatch");
  const m = await c.env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, user.id).first<{ role: string }>();
  if (!m || !isRole(m.role) || !can(m.role, "integrations:manage")) return fail("forbidden");
  if (!gscReady(c.env)) return fail("not_configured");
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
        redirect_uri: `${c.env.APP_ORIGIN}/api/v1/auth/google/callback`,
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
  // Granular consent: the user may untick the Search Console permission.
  if (!(tok.scope ?? "").split(" ").includes(GSC_SCOPE)) return fail("scope_not_granted");
  if (!tok.refresh_token) return fail("no_refresh_token");

  const db = c.env.DB;
  const existing = await db.prepare("SELECT id FROM integrations WHERE organization_id = ? AND provider = ?").bind(orgId, GSC_PROVIDER).first<{ id: string }>();
  const integrationId = existing?.id ?? uuid();
  const secretId = uuid();
  const sealed = await sealRefreshToken(c.env, orgId, integrationId, tok.refresh_token);
  const scopes = JSON.stringify([GSC_SCOPE]);
  await db.batch([
    existing
      ? db
          .prepare("UPDATE integrations SET status = 'connected', scopes_json = ?, account_ref = ?, secret_ref = ?, last_error = NULL WHERE organization_id = ? AND id = ?")
          .bind(scopes, claims.email, `integration_secrets:${secretId}`, orgId, integrationId)
      : db
          .prepare("INSERT INTO integrations (id, organization_id, provider, status, scopes_json, account_ref, secret_ref) VALUES (?, ?, ?, 'connected', ?, ?, ?)")
          .bind(integrationId, orgId, GSC_PROVIDER, scopes, claims.email, `integration_secrets:${secretId}`),
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(orgId, integrationId),
    db.prepare("INSERT INTO integration_secrets (id, organization_id, integration_id, ciphertext) VALUES (?, ?, ?, ?)").bind(secretId, orgId, integrationId, sealed),
    auditStmt(db, {
      organizationId: orgId,
      actorUserId: user.id,
      action: "integration.connect",
      entityType: "integration",
      entityId: integrationId,
      after: { provider: GSC_PROVIDER, account: maskEmail(claims.email), scopes: [GSC_SCOPE] },
      requestId: c.get("requestId"),
    }),
  ]);
  try {
    await storeProperties(db, orgId, integrationId, await listSites(c.get("deps"), tok.access_token));
  } catch (e) {
    const codeStr = e instanceof GscError ? e.code : "sites_list_failed";
    await db.prepare("UPDATE integrations SET last_error = ? WHERE organization_id = ? AND id = ?").bind(`sites:${codeStr}`, orgId, integrationId).run();
    return back(`gsc=connected&gsc_error=${encodeURIComponent(`sites_${codeStr}`)}`);
  }
  return back("gsc=connected");
}

/** Re-reads the properties the connected account can access (e.g. after adding one in Search Console). */
searchConsole.post("/search-console/properties/refresh", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  await rateLimit(db, `gsc-props:${t.orgId}`, 20, 3600);
  const conn = await loadConnection(c.env, t.orgId).catch((e) => {
    throw new ApiError(409, "gsc_not_connected", "Conecta Search Console primero.", { code: e instanceof GscError ? e.code : "error" });
  });
  try {
    const token = await accessTokenFromRefresh(c.env, c.get("deps"), conn.refreshToken);
    await storeProperties(db, t.orgId, conn.integrationId, await listSites(c.get("deps"), token));
    await db.prepare("UPDATE integrations SET last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, conn.integrationId).run();
  } catch (e) {
    const code = e instanceof GscError ? e.code : "error";
    if (code === "invalid_grant" || code === "scope_not_granted") {
      await markReauth(db, t.orgId, conn.integrationId, code);
      throw new ApiError(409, "gsc_reauth_required", "Google retiró el permiso. Vuelve a conectar Search Console.");
    }
    await db.prepare("UPDATE integrations SET last_error = ? WHERE organization_id = ? AND id = ?").bind(`sites:${code}`, t.orgId, conn.integrationId).run();
    throw new ApiError(502, "gsc_upstream_error", "Google no devolvió la lista de propiedades. Inténtalo más tarde.", { code });
  }
  return c.json({ ok: true });
});

const SelectInput = z.object({ propertyId: z.string().uuid() });

/** Chooses which property feeds the panel, then queues its first sync. */
searchConsole.put("/search-console/property", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const { propertyId } = await parseBody(c, SelectInput);
  const p = await db.prepare("SELECT id, site_url, permission_level FROM gsc_properties WHERE organization_id = ? AND id = ?").bind(t.orgId, propertyId).first<{ id: string; site_url: string; permission_level: string }>();
  if (!p) throw notFound("Propiedad");
  if (!READABLE_PERMISSIONS.has(p.permission_level)) throw new ApiError(403, "gsc_property_not_allowed", "La cuenta de Google conectada no tiene permiso de lectura sobre esta propiedad.");
  await db.batch([
    db.prepare("UPDATE gsc_properties SET selected = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE organization_id = ?").bind(p.id, t.orgId),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "integration.gsc_property_select", entityType: "gsc_property", entityId: p.id, after: { siteUrl: p.site_url }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

/** Queues a sync of the selected property (durable job; one at a time per organization). */
searchConsole.post("/search-console/sync", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await db.prepare("SELECT status FROM integrations WHERE organization_id = ? AND provider = ?").bind(t.orgId, GSC_PROVIDER).first<{ status: string }>();
  if (conn?.status !== "connected") throw new ApiError(409, "gsc_not_connected", "Conecta Search Console primero.");
  const p = await db.prepare("SELECT id, permission_level FROM gsc_properties WHERE organization_id = ? AND selected = 1").bind(t.orgId).first<{ id: string; permission_level: string }>();
  if (!p) throw new ApiError(409, "gsc_no_property", "Elige primero la propiedad de Search Console.");
  if (!READABLE_PERMISSIONS.has(p.permission_level)) throw new ApiError(403, "gsc_property_not_allowed", "La cuenta de Google conectada no tiene permiso de lectura sobre esta propiedad.");
  const active = await db
    .prepare("SELECT id, state FROM jobs WHERE organization_id = ? AND kind = 'gsc_sync' AND state IN ('queued','validating','running') LIMIT 1")
    .bind(t.orgId)
    .first<{ id: string; state: string }>();
  if (active) return c.json({ jobId: active.id, state: active.state, alreadyQueued: true }, 200);
  await rateLimit(db, `gsc-sync:${t.orgId}`, 10, 3600);
  const q = gscSyncJobStatements(db, t.orgId, p.id, t.userId, `gsc-manual-${uuid()}`);
  await db.batch([
    ...q.stmts,
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "integration.gsc_sync", entityType: "job", entityId: q.jobId, requestId: c.get("requestId") }),
  ]);
  await dispatchOutbox(c.env, c.get("deps"), (pr) => c.executionCtx.waitUntil(pr), [q.outboxId]);
  return c.json({ jobId: q.jobId, state: "queued" }, 202);
});

/**
 * Disconnect: Google is asked to revoke the grant (best effort), the encrypted token is deleted and
 * the connection marked disconnected. Imported observed data stays unless `purge=true`.
 */
searchConsole.delete("/search-console", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const purge = c.req.query("purge") === "true";
  const row = await db.prepare("SELECT id FROM integrations WHERE organization_id = ? AND provider = ?").bind(t.orgId, GSC_PROVIDER).first<{ id: string }>();
  if (!row) throw notFound("Conexión");
  let revoked: boolean;
  try {
    const conn = await loadConnection(c.env, t.orgId);
    revoked = await revokeToken(c.get("deps"), conn.refreshToken);
  } catch {
    revoked = false; // nothing usable to revoke (already disconnected or reauth needed)
  }
  await db.batch([
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, row.id),
    db.prepare("UPDATE integrations SET status = 'disconnected', secret_ref = NULL, last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, row.id),
    db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE organization_id = ? AND kind = 'gsc_sync' AND state IN ('queued','validating','running') AND cancel_requested_at IS NULL").bind(nowIso(), t.orgId),
    ...(purge ? [db.prepare("DELETE FROM gsc_properties WHERE organization_id = ?").bind(t.orgId)] : []),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "integration.disconnect", entityType: "integration", entityId: row.id, after: { provider: GSC_PROVIDER, revokedAtGoogle: revoked, dataPurged: purge }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, revokedAtGoogle: revoked, dataPurged: purge });
});

