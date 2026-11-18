import type { Deps, Env } from "../env";
import { GA4_SOURCE, googleAccessToken, googleJson, GoogleApiError, loadGoogleConnection, scheduleSyncs, syncJobStatements } from "./google";
import { uuid } from "./util";

/**
 * Google Analytics 4 (read-only, scope analytics.readonly). Two fixed Google hosts: the Admin API
 * (which properties the account can read) and the Data API (reports). The only user-influenced value
 * placed in a URL is the property name, validated as `properties/<digits>`; no SSRF surface.
 */
const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

export const GA4_PROVIDER = GA4_SOURCE.provider;
export const GA4_STATE_PROVIDER = GA4_SOURCE.stateProvider;

export const validProperty = (s: unknown): s is string => typeof s === "string" && /^properties\/\d{1,20}$/.test(s);

export const ga4AccessToken = (env: Env, deps: Deps, refreshToken: string) => googleAccessToken(env, deps, refreshToken, GA4_SOURCE.scope);
export const loadGa4Connection = (env: Env, orgId: string) => loadGoogleConnection(env, GA4_SOURCE, orgId);

export interface Ga4Property {
  property: string;
  displayName: string;
  accountName: string | null;
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** Every GA4 property the account can read (accountSummaries.list; at most 5 pages × 200). */
export async function listProperties(deps: Deps, accessToken: string): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
    const body = await googleJson(deps, `${ADMIN}/accountSummaries?${qs}`, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    const accounts: unknown[] = Array.isArray(body.accountSummaries) ? body.accountSummaries : [];
    for (const a of accounts as any[]) {
      const props: unknown[] = Array.isArray(a?.propertySummaries) ? a.propertySummaries : [];
      for (const p of props as any[]) {
        if (!validProperty(p?.property)) continue;
        out.push({ property: p.property, displayName: clip(p.displayName, 200) || p.property, accountName: clip(a?.displayName, 200) || null });
      }
    }
    pageToken = typeof body.nextPageToken === "string" && /^[A-Za-z0-9_\-=.]{1,512}$/.test(body.nextPageToken) ? body.nextPageToken : "";
    if (!pageToken) break;
  }
  return out.slice(0, 500);
}

export const METRICS = ["sessions", "totalUsers", "screenPageViews", "engagedSessions", "keyEvents"] as const;
export type MetricValues = { sessions: number; totalUsers: number; screenPageViews: number; engagedSessions: number; keyEvents: number };

export interface ReportResult {
  rows: { dims: string[]; values: MetricValues }[];
  timeZone: string | null;
  currencyCode: string | null;
  thresholded: boolean;
  sampled: boolean;
}

/** runReport with fixed metrics. GA4 returns metric values as strings; non-numbers become 0. */
export async function runReport(
  deps: Deps,
  accessToken: string,
  property: string,
  q: { dateRanges: { startDate: string; endDate: string; name?: string }[]; dimensions: string[]; limit: number; orderBySessions?: boolean; metrics?: readonly string[] },
): Promise<ReportResult> {
  if (!validProperty(property)) throw new GoogleApiError("invalid_property");
  const metrics = q.metrics ?? METRICS;
  const body = await googleJson(deps, `${DATA}/${property}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      dateRanges: q.dateRanges,
      dimensions: q.dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: String(q.limit),
      ...(q.orderBySessions ? { orderBys: [{ metric: { metricName: "sessions" }, desc: true }] } : {}),
    }),
  });
  const mh: string[] = Array.isArray(body.metricHeaders) ? body.metricHeaders.map((h: any) => String(h?.name)) : [];
  const nDims = Array.isArray(body.dimensionHeaders) ? body.dimensionHeaders.length : 0;
  const num = (v: unknown) => {
    const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const rows: unknown[] = Array.isArray(body.rows) ? body.rows : [];
  const meta = body.metadata ?? {};
  return {
    rows: (rows as any[])
      .map((r) => {
        const dims: string[] = Array.isArray(r?.dimensionValues) ? r.dimensionValues.map((d: any) => clip(d?.value, 2048)) : [];
        const mv: unknown[] = Array.isArray(r?.metricValues) ? r.metricValues : [];
        const get = (name: string) => {
          const i = mh.indexOf(name);
          return i >= 0 ? num((mv[i] as any)?.value) : 0;
        };
        return {
          dims,
          values: {
            sessions: Math.round(get("sessions")),
            totalUsers: Math.round(get("totalUsers")),
            screenPageViews: Math.round(get("screenPageViews")),
            engagedSessions: Math.round(get("engagedSessions")),
            keyEvents: get("keyEvents"),
          },
        };
      })
      .filter((r) => r.dims.length >= nDims),
    timeZone: clip(meta.timeZone, 64) || null,
    currencyCode: clip(meta.currencyCode, 8) || null,
    thresholded: meta.subjectToThresholding === true,
    sampled: Array.isArray(meta.samplingMetadatas) && meta.samplingMetadatas.length > 0,
  };
}

/** GA4 dates come as YYYYMMDD. */
export const gaDate = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

/** Upserts the properties the account can read; properties it no longer lists lose access and selection. */
export async function storeGa4Properties(db: D1Database, orgId: string, integrationId: string, props: Ga4Property[]) {
  const stmts: D1PreparedStatement[] = props.map((p) =>
    db
      .prepare(
        `INSERT INTO ga4_properties (id, organization_id, integration_id, property, display_name, account_name, accessible) VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (organization_id, property) DO UPDATE SET display_name = excluded.display_name, account_name = excluded.account_name, integration_id = excluded.integration_id, accessible = 1`,
      )
      .bind(uuid(), orgId, integrationId, p.property, p.displayName, p.accountName),
  );
  const seen = props.map((p) => p.property);
  stmts.push(
    db
      .prepare(`UPDATE ga4_properties SET accessible = 0, selected = 0 WHERE organization_id = ?${seen.length ? ` AND property NOT IN (${seen.map(() => "?").join(",")})` : ""}`)
      .bind(orgId, ...seen),
  );
  // Never selected automatically: one Google account often reaches properties of other brands or
  // clients, so importing data always needs an explicit, audited choice by an admin.
  await db.batch(stmts);
}

export const ga4SyncJobStatements = (db: D1Database, orgId: string, propertyId: string, actorUserId: string | null, idempotencyKey: string) =>
  syncJobStatements(db, GA4_SOURCE, orgId, propertyId, actorUserId, idempotencyKey);

/** Cron: one automatic refresh per selected property per day (at most 5 per tick). */
export const scheduleGa4Syncs = (env: Env) => scheduleSyncs(env, GA4_SOURCE, "ga4_properties");
