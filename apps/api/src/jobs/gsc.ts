import {
  accessTokenFromRefresh,
  daysAgo,
  GscError,
  listSites,
  loadConnection,
  markReauth,
  READABLE_PERMISSIONS,
  searchAnalytics,
  storeProperties,
} from "../lib/gsc";
import { GSC_PAGE_ROWS } from "@dni/core";
import { nowIso } from "../lib/util";
import { PermanentJobError, type JobContext } from "./consumer";

/** Days requested on the first sync (Search Console keeps ~16 months) and on later refreshes. */
const BACKFILL_DAYS = 90;
const REFRESH_DAYS = 30;
const TOP_DAYS = 28;
const TOP_ROWS = 25;
const PAGE_ROWS = GSC_PAGE_ROWS;

const PERMANENT = new Set(["not_connected", "secret_unreadable", "invalid_grant", "scope_not_granted", "PERMISSION_DENIED", "invalid_site_url", "UNAUTHENTICATED"]);

/**
 * Pulls observed Search Analytics data for the selected property. Read-only against Google; writes
 * only this organization's rows. Re-validates the property permission on every run.
 */
export async function runGscSync(ctx: JobContext, input: { propertyId: string }) {
  const { env, deps, job } = ctx;
  const db = env.DB;
  const orgId = job.organization_id;
  try {
    const conn = await loadConnection(env, orgId);
    let accessToken: string;
    try {
      accessToken = await accessTokenFromRefresh(env, deps, conn.refreshToken);
    } catch (e) {
      if (e instanceof GscError && (e.code === "invalid_grant" || e.code === "scope_not_granted")) await markReauth(db, orgId, conn.integrationId, e.code);
      throw e;
    }
    await ctx.progress(10);

    // "Lectura de propiedad permitida": the account must still have read access right now.
    await storeProperties(db, orgId, conn.integrationId, await listSites(deps, accessToken));
    const prop = await db
      .prepare("SELECT id, site_url, permission_level, selected FROM gsc_properties WHERE organization_id = ? AND id = ?")
      .bind(orgId, input.propertyId)
      .first<{ id: string; site_url: string; permission_level: string; selected: number }>();
    if (!prop) throw new PermanentJobError("gsc_property_not_found", "La propiedad ya no existe en esta organización.");
    if (!READABLE_PERMISSIONS.has(prop.permission_level)) {
      throw new PermanentJobError("gsc_property_not_allowed", "La cuenta de Google conectada ya no tiene permiso de lectura sobre esta propiedad.");
    }
    if (prop.selected !== 1) throw new PermanentJobError("gsc_property_not_selected", "La propiedad ya no está elegida para sincronizar; no se importa nada.");
    await ctx.checkpoint();
    await ctx.progress(25);

    const hasData = await db.prepare("SELECT 1 FROM gsc_daily_metrics WHERE organization_id = ? AND property_id = ? LIMIT 1").bind(orgId, prop.id).first();
    const endDate = daysAgo(1);
    const startDate = daysAgo(hasData ? REFRESH_DAYS : BACKFILL_DAYS);
    const observedAt = nowIso();
    const daily = await searchAnalytics(deps, accessToken, prop.site_url, { startDate, endDate, dimensions: ["date"], rowLimit: 1000 });
    const dailyStmts = daily
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.keys[0]!))
      .map((r) =>
        db
          .prepare(
            `INSERT INTO gsc_daily_metrics (organization_id, property_id, date, clicks, impressions, ctr, position, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (organization_id, property_id, date) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, ctr = excluded.ctr, position = excluded.position, observed_at = excluded.observed_at`,
          )
          .bind(orgId, prop.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position, observedAt),
      );
    if (dailyStmts.length) await db.batch(dailyStmts);
    await ctx.checkpoint();
    await ctx.progress(55);

    const topStart = daysAgo(TOP_DAYS);
    const tops: D1PreparedStatement[] = [];
    let queries = 0;
    let pages = 0;
    for (const dimension of ["query", "page"] as const) {
      const rows = await searchAnalytics(deps, accessToken, prop.site_url, { startDate: topStart, endDate, dimensions: [dimension], rowLimit: dimension === "page" ? PAGE_ROWS : TOP_ROWS });
      tops.push(db.prepare("DELETE FROM gsc_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = ?").bind(orgId, prop.id, dimension));
      for (const r of rows) {
        tops.push(
          db
            .prepare(
              "INSERT OR REPLACE INTO gsc_top_rows (organization_id, property_id, dimension, key, clicks, impressions, ctr, position, period_start, period_end, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(orgId, prop.id, dimension, r.keys[0], r.clicks, r.impressions, r.ctr, r.position, topStart, endDate, observedAt),
        );
      }
      if (dimension === "query") queries = rows.length;
      else pages = rows.length;
    }
    // The 28 days before: same read-only query, kept only to show which pages lose clicks (never sent to an AI model).
    const prevEnd = daysAgo(TOP_DAYS + 1);
    const prevStart = daysAgo(TOP_DAYS * 2);
    const prevRows = await searchAnalytics(deps, accessToken, prop.site_url, { startDate: prevStart, endDate: prevEnd, dimensions: ["page"], rowLimit: PAGE_ROWS });
    tops.push(db.prepare("DELETE FROM gsc_page_prev WHERE organization_id = ? AND property_id = ?").bind(orgId, prop.id));
    for (const r of prevRows) {
      tops.push(
        db
          .prepare("INSERT OR REPLACE INTO gsc_page_prev (organization_id, property_id, key, clicks, impressions, ctr, position, period_start, period_end, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(orgId, prop.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position, prevStart, prevEnd, observedAt),
      );
    }
    await db.batch([
      ...tops,
      db.prepare("UPDATE gsc_properties SET last_sync_at = ?, last_error = NULL WHERE organization_id = ? AND id = ?").bind(observedAt, orgId, prop.id),
      db.prepare("UPDATE integrations SET last_sync_at = ?, last_error = NULL WHERE organization_id = ? AND id = ?").bind(observedAt, orgId, conn.integrationId),
    ]);
    await ctx.event("info", "gsc_synced", `Search Console: ${daily.length} días, ${queries} consultas y ${pages} páginas`, { startDate, endDate });
    return { creditsUsed: 0, siteUrl: prop.site_url, startDate, endDate, days: daily.length, queries, pages };
  } catch (e) {
    if (e instanceof GscError) {
      await db.prepare("UPDATE gsc_properties SET last_error = ? WHERE organization_id = ? AND id = ?").bind(e.code, orgId, input.propertyId).run();
      if (PERMANENT.has(e.code) || e.status === 403 || e.status === 401 || e.status === 400) throw new PermanentJobError(`gsc_${e.code}`, `Search Console: ${e.code}`);
      throw new Error(`Search Console: ${e.code}`, { cause: e });
    }
    if (e instanceof PermanentJobError) {
      await db.prepare("UPDATE gsc_properties SET last_error = ? WHERE organization_id = ? AND id = ?").bind(e.code, orgId, input.propertyId).run();
    }
    throw e;
  }
}
