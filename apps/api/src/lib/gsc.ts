import { decryptJson, encryptJson } from "@dni/core";
import type { Deps, Env } from "../env";
import { uuid } from "./util";

/**
 * Google Search Console (read-only). Every network call goes to fixed Google hosts; the only
 * user-influenced value (the property URL) is validated and percent-encoded as a path segment, so
 * there is no SSRF surface. Refresh tokens are stored only as AES-256-GCM envelopes bound to the
 * organization and integration; access tokens live in memory for the duration of one sync.
 */
export const GSC_PROVIDER = "google_search_console";
export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GSC_STATE_PROVIDER = "google_gsc";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/webmasters/v3";

/** Permission levels that can read Search Analytics data. `siteUnverifiedUser` cannot. */
export const READABLE_PERMISSIONS = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

export class GscError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super(code);
  }
}

export function validSiteUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048) return false;
  if (/^sc-domain:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(s)) return true;
  try {
    const u = new URL(s);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && s.endsWith("/");
  } catch {
    return false;
  }
}

export const gscReady = (env: Env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && /^[0-9a-f]{64}$/i.test(env.DATA_ENC_KEY ?? "");

const aad = (orgId: string, integrationId: string) => `gsc:${orgId}:${integrationId}`;
export const sealRefreshToken = (env: Env, orgId: string, integrationId: string, refreshToken: string) =>
  encryptJson(env.DATA_ENC_KEY!, { rt: refreshToken }, aad(orgId, integrationId));
export async function openRefreshToken(env: Env, orgId: string, integrationId: string, ciphertext: string): Promise<string> {
  return (await decryptJson<{ rt: string }>(env.DATA_ENC_KEY!, ciphertext, aad(orgId, integrationId))).rt;
}

async function googleJson(deps: Deps, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new GscError("network_error");
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    const raw = typeof body?.error === "string" ? body.error : body?.error?.status ?? `http_${res.status}`;
    throw new GscError(String(raw).replace(/[^A-Za-z0-9_]/g, "").slice(0, 60) || `http_${res.status}`, res.status);
  }
  return body;
}

export async function accessTokenFromRefresh(env: Env, deps: Deps, refreshToken: string): Promise<string> {
  const body = await googleJson(deps, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! }).toString(),
  });
  if (typeof body.access_token !== "string" || !body.access_token) throw new GscError("no_access_token");
  if (typeof body.scope === "string" && !body.scope.split(" ").includes(GSC_SCOPE)) throw new GscError("scope_not_granted");
  return body.access_token;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(deps: Deps, accessToken: string): Promise<GscSite[]> {
  const body = await googleJson(deps, `${API}/sites`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  const entries: unknown[] = Array.isArray(body.siteEntry) ? body.siteEntry : [];
  return entries
    .map((e: any) => ({ siteUrl: e?.siteUrl, permissionLevel: typeof e?.permissionLevel === "string" ? e.permissionLevel.slice(0, 40) : "unknown" }))
    .filter((e): e is GscSite => validSiteUrl(e.siteUrl))
    .slice(0, 200);
}

export interface AnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchAnalytics(
  deps: Deps,
  accessToken: string,
  siteUrl: string,
  q: { startDate: string; endDate: string; dimensions: ("date" | "query" | "page")[]; rowLimit: number },
): Promise<AnalyticsRow[]> {
  if (!validSiteUrl(siteUrl)) throw new GscError("invalid_site_url");
  const body = await googleJson(deps, `${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...q, dataState: "final" }),
  });
  const rows: unknown[] = Array.isArray(body.rows) ? body.rows : [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return rows
    .map((r: any) => ({
      keys: Array.isArray(r?.keys) ? r.keys.map((k: unknown) => String(k).slice(0, 2048)) : [],
      clicks: Math.max(0, Math.round(num(r?.clicks))),
      impressions: Math.max(0, Math.round(num(r?.impressions))),
      ctr: Math.min(1, Math.max(0, num(r?.ctr))),
      position: Math.max(0, num(r?.position)),
    }))
    .filter((r) => r.keys.length === q.dimensions.length);
}

/** Best effort: tells Google to invalidate the grant. Disconnecting never depends on it. */
export async function revokeToken(deps: Deps, token: string): Promise<boolean> {
  try {
    const res = await deps.fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Upserts the properties the account can see; properties it no longer sees lose access and selection. */
export async function storeProperties(db: D1Database, orgId: string, integrationId: string, sites: GscSite[]) {
  const stmts: D1PreparedStatement[] = sites.map((s) =>
    db
      .prepare(
        `INSERT INTO gsc_properties (id, organization_id, integration_id, site_url, permission_level) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (organization_id, site_url) DO UPDATE SET permission_level = excluded.permission_level, integration_id = excluded.integration_id`,
      )
      .bind(uuid(), orgId, integrationId, s.siteUrl, s.permissionLevel),
  );
  const seen = sites.map((s) => s.siteUrl);
  stmts.push(
    db
      .prepare(
        `UPDATE gsc_properties SET permission_level = 'none', selected = 0 WHERE organization_id = ?${seen.length ? ` AND site_url NOT IN (${seen.map(() => "?").join(",")})` : ""}`,
      )
      .bind(orgId, ...seen),
  );
  // A single readable property is selected automatically; otherwise the admin chooses.
  const readable = sites.filter((s) => READABLE_PERMISSIONS.has(s.permissionLevel));
  if (readable.length === 1) {
    stmts.push(
      db
        .prepare(
          "UPDATE gsc_properties SET selected = 1 WHERE organization_id = ? AND site_url = ? AND NOT EXISTS (SELECT 1 FROM gsc_properties WHERE organization_id = ? AND selected = 1)",
        )
        .bind(orgId, readable[0]!.siteUrl, orgId),
    );
  }
  await db.batch(stmts);
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number, now = Date.now()) => isoDay(new Date(now - n * 86_400_000));

/** Loads the decrypted refresh token for an organization's connection (or throws GscError). */
export async function loadConnection(env: Env, orgId: string) {
  const row = await env.DB.prepare(
    `SELECT i.id, i.status, s.ciphertext FROM integrations i LEFT JOIN integration_secrets s ON s.organization_id = i.organization_id AND s.integration_id = i.id
     WHERE i.organization_id = ? AND i.provider = ?`,
  )
    .bind(orgId, GSC_PROVIDER)
    .first<{ id: string; status: string; ciphertext: string | null }>();
  if (!row || row.status !== "connected" || !row.ciphertext) throw new GscError("not_connected");
  let refreshToken: string;
  try {
    refreshToken = await openRefreshToken(env, orgId, row.id, row.ciphertext);
  } catch {
    throw new GscError("secret_unreadable");
  }
  return { integrationId: row.id, refreshToken };
}

export async function markReauth(db: D1Database, orgId: string, integrationId: string, code: string) {
  await db
    .prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND id = ?")
    .bind(code.slice(0, 120), orgId, integrationId)
    .run();
}

/**
 * Statements that queue one sync job (job + outbox row, committed atomically by the caller).
 * The (organization_id, idempotency_key) unique constraint makes duplicates impossible.
 */
export function gscSyncJobStatements(db: D1Database, orgId: string, propertyId: string, actorUserId: string | null, idempotencyKey: string) {
  const jobId = uuid();
  const outboxId = uuid();
  return {
    jobId,
    outboxId,
    stmts: [
      db
        .prepare("INSERT INTO jobs (id, organization_id, kind, idempotency_key, input_json, cost_estimate, actor_user_id) VALUES (?, ?, 'gsc_sync', ?, ?, 0, ?)")
        .bind(jobId, orgId, idempotencyKey, JSON.stringify({ propertyId }), actorUserId),
      db
        .prepare("INSERT INTO outbox_events (id, organization_id, topic, payload_json, dedupe_key) VALUES (?, ?, 'jobs', ?, ?)")
        .bind(outboxId, orgId, JSON.stringify({ jobId, organizationId: orgId, outboxId }), `job:${jobId}`),
      db.prepare("INSERT INTO job_events (id, organization_id, job_id, level, kind, message) VALUES (?, ?, ?, 'info', 'queued', ?)").bind(uuid(), orgId, jobId, "En cola: sincronizar Search Console"),
    ],
  };
}

/** Cron: one automatic refresh per selected property per day (at most 5 per tick). */
export async function scheduleGscSyncs(env: Env): Promise<string[]> {
  if (!gscReady(env)) return [];
  const today = isoDay(new Date());
  const { results } = await env.DB.prepare(
    `SELECT p.organization_id, p.id FROM gsc_properties p
     JOIN integrations i ON i.organization_id = p.organization_id AND i.id = p.integration_id AND i.status = 'connected'
     WHERE p.selected = 1 AND (p.last_sync_at IS NULL OR p.last_sync_at < ?)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.organization_id = p.organization_id AND j.kind = 'gsc_sync' AND j.created_at > ?)
     LIMIT 5`,
  )
    .bind(new Date(Date.now() - 20 * 3600_000).toISOString(), new Date(Date.now() - 6 * 3600_000).toISOString())
    .all<{ organization_id: string; id: string }>();
  const outboxIds: string[] = [];
  for (const r of results) {
    const q = gscSyncJobStatements(env.DB, r.organization_id, r.id, null, `gsc-auto-${r.id}-${today}`);
    try {
      await env.DB.batch(q.stmts);
      outboxIds.push(q.outboxId);
    } catch {
      // Already queued today (unique idempotency key): nothing to do.
    }
  }
  return outboxIds;
}
