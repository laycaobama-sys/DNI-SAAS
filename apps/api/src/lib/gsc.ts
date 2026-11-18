import type { Deps, Env } from "../env";
import {
  daysAgo,
  googleAccessToken,
  googleJson,
  googleReady,
  GoogleApiError,
  GSC_SOURCE,
  isoDay,
  loadGoogleConnection,
  markReauth,
  openToken,
  revokeToken,
  scheduleSyncs,
  sealToken,
  syncJobStatements,
} from "./google";
import { uuid } from "./util";

/**
 * Google Search Console (read-only). Every network call goes to fixed Google hosts; the only
 * user-influenced value (the property URL) is validated and percent-encoded as a path segment, so
 * there is no SSRF surface. Token handling lives in ./google (shared with GA4).
 */
export const GSC_PROVIDER = GSC_SOURCE.provider;
export const GSC_SCOPE = GSC_SOURCE.scope;
export const GSC_STATE_PROVIDER = GSC_SOURCE.stateProvider;
const API = "https://www.googleapis.com/webmasters/v3";

/** Permission levels that can read Search Analytics data. `siteUnverifiedUser` cannot. */
export const READABLE_PERMISSIONS = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);

export { GoogleApiError as GscError, revokeToken, markReauth, isoDay, daysAgo };

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

export const gscReady = googleReady;
export const sealRefreshToken = (env: Env, orgId: string, integrationId: string, refreshToken: string) => sealToken(env, GSC_SOURCE, orgId, integrationId, refreshToken);
export const openRefreshToken = (env: Env, orgId: string, integrationId: string, ciphertext: string) => openToken(env, GSC_SOURCE, orgId, integrationId, ciphertext);
export const accessTokenFromRefresh = (env: Env, deps: Deps, refreshToken: string) => googleAccessToken(env, deps, refreshToken, GSC_SCOPE);
export const loadConnection = (env: Env, orgId: string) => loadGoogleConnection(env, GSC_SOURCE, orgId);

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
  if (!validSiteUrl(siteUrl)) throw new GoogleApiError("invalid_site_url");
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

export const gscSyncJobStatements = (db: D1Database, orgId: string, propertyId: string, actorUserId: string | null, idempotencyKey: string) =>
  syncJobStatements(db, GSC_SOURCE, orgId, propertyId, actorUserId, idempotencyKey);

/** Cron: one automatic refresh per selected property per day (at most 5 per tick). */
export const scheduleGscSyncs = (env: Env) => scheduleSyncs(env, GSC_SOURCE, "gsc_properties");
