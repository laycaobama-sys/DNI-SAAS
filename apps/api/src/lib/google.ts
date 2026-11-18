import { decryptJson, encryptJson } from "@dni/core";
import type { Deps, Env } from "../env";
import { uuid } from "./util";

/**
 * Shared plumbing for read-only Google data sources (Search Console, GA4). Each source gets its own
 * consent (minimal scope), its own integration row and its own encrypted refresh token. All calls go
 * to fixed Google hosts; access tokens live only in memory for the duration of one request or job.
 */
export interface GoogleDataSource {
  provider: string;
  stateProvider: string;
  scope: string;
  /** AAD prefix of the token envelope. Never change it for an existing source (old tokens would not open). */
  aadPrefix: string;
  /** SPA path segment of the panel: /app/o/<org>/<panel>. */
  panel: string;
  jobKind: string;
  label: string;
}

export const GSC_SOURCE: GoogleDataSource = {
  provider: "google_search_console",
  stateProvider: "google_gsc",
  scope: "https://www.googleapis.com/auth/webmasters.readonly",
  aadPrefix: "gsc",
  panel: "search-console",
  jobKind: "gsc_sync",
  label: "Search Console",
};

export const GA4_SOURCE: GoogleDataSource = {
  provider: "ga4",
  stateProvider: "google_ga4",
  scope: "https://www.googleapis.com/auth/analytics.readonly",
  aadPrefix: "ga4",
  panel: "analytics",
  jobKind: "ga4_sync",
  label: "Google Analytics",
};

export const GOOGLE_STATE_PROVIDERS = [GSC_SOURCE.stateProvider, GA4_SOURCE.stateProvider];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export class GoogleApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super(code);
  }
}

export const googleReady = (env: Env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET && /^[0-9a-f]{64}$/i.test(env.DATA_ENC_KEY ?? "");

const aad = (src: GoogleDataSource, orgId: string, integrationId: string) => `${src.aadPrefix}:${orgId}:${integrationId}`;
export const sealToken = (env: Env, src: GoogleDataSource, orgId: string, integrationId: string, refreshToken: string) =>
  encryptJson(env.DATA_ENC_KEY!, { rt: refreshToken }, aad(src, orgId, integrationId));
export async function openToken(env: Env, src: GoogleDataSource, orgId: string, integrationId: string, ciphertext: string): Promise<string> {
  return (await decryptJson<{ rt: string }>(env.DATA_ENC_KEY!, ciphertext, aad(src, orgId, integrationId))).rt;
}

/** JSON call to a fixed Google endpoint; errors become GoogleApiError with a sanitized code. */
export async function googleJson(deps: Deps, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new GoogleApiError("network_error");
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
    throw new GoogleApiError(String(raw).replace(/[^A-Za-z0-9_]/g, "").slice(0, 60) || `http_${res.status}`, res.status);
  }
  return body;
}

export async function googleAccessToken(env: Env, deps: Deps, refreshToken: string, scope: string): Promise<string> {
  const body = await googleJson(deps, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! }).toString(),
  });
  if (typeof body.access_token !== "string" || !body.access_token) throw new GoogleApiError("no_access_token");
  if (typeof body.scope === "string" && !body.scope.split(" ").includes(scope)) throw new GoogleApiError("scope_not_granted");
  return body.access_token;
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

/** Loads the decrypted refresh token of an organization's connection (or throws GoogleApiError). */
export async function loadGoogleConnection(env: Env, src: GoogleDataSource, orgId: string) {
  const row = await env.DB.prepare(
    `SELECT i.id, i.status, s.ciphertext FROM integrations i LEFT JOIN integration_secrets s ON s.organization_id = i.organization_id AND s.integration_id = i.id
     WHERE i.organization_id = ? AND i.provider = ?`,
  )
    .bind(orgId, src.provider)
    .first<{ id: string; status: string; ciphertext: string | null }>();
  if (!row || row.status !== "connected" || !row.ciphertext) throw new GoogleApiError("not_connected");
  let refreshToken: string;
  try {
    refreshToken = await openToken(env, src, orgId, row.id, row.ciphertext);
  } catch {
    throw new GoogleApiError("secret_unreadable");
  }
  return { integrationId: row.id, refreshToken };
}

export async function markReauth(db: D1Database, orgId: string, integrationId: string, code: string) {
  await db.prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND id = ?").bind(code.slice(0, 120), orgId, integrationId).run();
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number, now = Date.now()) => isoDay(new Date(now - n * 86_400_000));

/** Job + outbox row + first event for one sync (committed atomically by the caller; idempotent by key). */
export function syncJobStatements(db: D1Database, src: GoogleDataSource, orgId: string, propertyId: string, actorUserId: string | null, idempotencyKey: string) {
  const jobId = uuid();
  const outboxId = uuid();
  return {
    jobId,
    outboxId,
    stmts: [
      db
        .prepare("INSERT INTO jobs (id, organization_id, kind, idempotency_key, input_json, cost_estimate, actor_user_id) VALUES (?, ?, ?, ?, ?, 0, ?)")
        .bind(jobId, orgId, src.jobKind, idempotencyKey, JSON.stringify({ propertyId }), actorUserId),
      db
        .prepare("INSERT INTO outbox_events (id, organization_id, topic, payload_json, dedupe_key) VALUES (?, ?, 'jobs', ?, ?)")
        .bind(outboxId, orgId, JSON.stringify({ jobId, organizationId: orgId, outboxId }), `job:${jobId}`),
      db.prepare("INSERT INTO job_events (id, organization_id, job_id, level, kind, message) VALUES (?, ?, ?, 'info', 'queued', ?)").bind(uuid(), orgId, jobId, `En cola: sincronizar ${src.label}`),
    ],
  };
}

/** Cron: one automatic refresh per selected property per day per source (at most 5 per tick). */
export async function scheduleSyncs(env: Env, src: GoogleDataSource, propertiesTable: "gsc_properties" | "ga4_properties"): Promise<string[]> {
  if (!googleReady(env)) return [];
  const today = isoDay(new Date());
  const { results } = await env.DB.prepare(
    `SELECT p.organization_id, p.id FROM ${propertiesTable} p
     JOIN integrations i ON i.organization_id = p.organization_id AND i.id = p.integration_id AND i.status = 'connected'
     WHERE p.selected = 1 AND (p.last_sync_at IS NULL OR p.last_sync_at < ?)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.organization_id = p.organization_id AND j.kind = ? AND j.created_at > ?)
     LIMIT 5`,
  )
    .bind(new Date(Date.now() - 20 * 3600_000).toISOString(), src.jobKind, new Date(Date.now() - 6 * 3600_000).toISOString())
    .all<{ organization_id: string; id: string }>();
  const outboxIds: string[] = [];
  for (const r of results) {
    const q = syncJobStatements(env.DB, src, r.organization_id, r.id, null, `${src.aadPrefix}-auto-${r.id}-${today}`);
    try {
      await env.DB.batch(q.stmts);
      outboxIds.push(q.outboxId);
    } catch {
      // Already queued today (unique idempotency key): nothing to do.
    }
  }
  return outboxIds;
}
