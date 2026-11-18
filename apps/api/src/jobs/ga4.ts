import { daysAgo, GoogleApiError, markReauth } from "../lib/google";
import { ga4AccessToken, gaDate, listProperties, loadGa4Connection, runReport, storeGa4Properties } from "../lib/ga4";
import { nowIso } from "../lib/util";
import { PermanentJobError, type JobContext } from "./consumer";

/** Days requested on the first sync and on later refreshes; comparison periods of 28 days. */
const BACKFILL_DAYS = 90;
const REFRESH_DAYS = 30;
const PERIOD_DAYS = 28;
const TOP_ROWS = 25;

const PERMANENT = new Set(["not_connected", "secret_unreadable", "invalid_grant", "scope_not_granted", "PERMISSION_DENIED", "invalid_property", "UNAUTHENTICATED", "INVALID_ARGUMENT"]);

/**
 * Pulls observed GA4 data for the selected property. Read-only against Google; writes only this
 * organization's rows. Re-validates on every run that the account can still read the property.
 */
export async function runGa4Sync(ctx: JobContext, input: { propertyId: string }) {
  const { env, deps, job } = ctx;
  const db = env.DB;
  const orgId = job.organization_id;
  try {
    const conn = await loadGa4Connection(env, orgId);
    let accessToken: string;
    try {
      accessToken = await ga4AccessToken(env, deps, conn.refreshToken);
    } catch (e) {
      if (e instanceof GoogleApiError && (e.code === "invalid_grant" || e.code === "scope_not_granted")) await markReauth(db, orgId, conn.integrationId, e.code);
      throw e;
    }
    await ctx.progress(10);

    // The account must still be able to read this property right now.
    await storeGa4Properties(db, orgId, conn.integrationId, await listProperties(deps, accessToken));
    const prop = await db
      .prepare("SELECT id, property, accessible, selected FROM ga4_properties WHERE organization_id = ? AND id = ?")
      .bind(orgId, input.propertyId)
      .first<{ id: string; property: string; accessible: number; selected: number }>();
    if (!prop) throw new PermanentJobError("ga4_property_not_found", "La propiedad ya no existe en esta organización.");
    if (prop.accessible !== 1) throw new PermanentJobError("ga4_property_not_allowed", "La cuenta de Google conectada ya no puede leer esta propiedad de Analytics.");
    if (prop.selected !== 1) throw new PermanentJobError("ga4_property_not_selected", "La propiedad ya no está elegida para sincronizar; no se importa nada.");
    await ctx.checkpoint();
    await ctx.progress(25);

    const hasData = await db.prepare("SELECT 1 FROM ga4_daily_metrics WHERE organization_id = ? AND property_id = ? LIMIT 1").bind(orgId, prop.id).first();
    const endDate = daysAgo(1);
    const startDate = daysAgo(hasData ? REFRESH_DAYS : BACKFILL_DAYS);
    const observedAt = nowIso();
    const daily = await runReport(deps, accessToken, prop.property, { dateRanges: [{ startDate, endDate }], dimensions: ["date"], limit: 1000 });
    const dailyStmts = daily.rows.flatMap((r) => {
      const d = gaDate(r.dims[0]!);
      if (!d) return [];
      const v = r.values;
      return [
        db
          .prepare(
            `INSERT INTO ga4_daily_metrics (organization_id, property_id, date, sessions, total_users, screen_page_views, engaged_sessions, key_events, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (organization_id, property_id, date) DO UPDATE SET sessions = excluded.sessions, total_users = excluded.total_users, screen_page_views = excluded.screen_page_views,
               engaged_sessions = excluded.engaged_sessions, key_events = excluded.key_events, observed_at = excluded.observed_at`,
          )
          .bind(orgId, prop.id, d, v.sessions, v.totalUsers, v.screenPageViews, v.engagedSessions, v.keyEvents, observedAt),
      ];
    });
    if (dailyStmts.length) await db.batch(dailyStmts);
    await ctx.checkpoint();
    await ctx.progress(50);

    // Whole-period totals straight from GA4 (users are de-duplicated across the period).
    const cur = { startDate: daysAgo(PERIOD_DAYS), endDate, name: "current" };
    const prev = { startDate: daysAgo(PERIOD_DAYS * 2), endDate: daysAgo(PERIOD_DAYS + 1), name: "previous" };
    const totals = await runReport(deps, accessToken, prop.property, { dateRanges: [cur, prev], dimensions: [], limit: 10 });
    const stmts: D1PreparedStatement[] = [db.prepare("DELETE FROM ga4_period_totals WHERE organization_id = ? AND property_id = ?").bind(orgId, prop.id)];
    for (const r of totals.rows) {
      // With several date ranges GA4 adds a `dateRange` dimension holding the range name.
      const range = r.dims[0] === "current" ? cur : r.dims[0] === "previous" ? prev : null;
      if (!range) continue;
      const v = r.values;
      stmts.push(
        db
          .prepare(
            "INSERT INTO ga4_period_totals (organization_id, property_id, period, period_start, period_end, sessions, total_users, screen_page_views, engaged_sessions, key_events, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(orgId, prop.id, range.name, range.startDate, range.endDate, v.sessions, v.totalUsers, v.screenPageViews, v.engagedSessions, v.keyEvents, observedAt),
      );
    }
    await ctx.checkpoint();
    await ctx.progress(70);

    let thresholded = daily.thresholded || totals.thresholded;
    let sampled = daily.sampled || totals.sampled;
    const counts = { channel: 0, landing_page: 0 };
    for (const [dimension, gaDim] of [
      ["channel", "sessionDefaultChannelGroup"],
      ["landing_page", "landingPage"],
    ] as const) {
      const rep = await runReport(deps, accessToken, prop.property, {
        dateRanges: [{ startDate: cur.startDate, endDate }],
        dimensions: [gaDim],
        limit: TOP_ROWS,
        orderBySessions: true,
        metrics: ["sessions", "totalUsers", "engagedSessions", "keyEvents"],
      });
      thresholded ||= rep.thresholded;
      sampled ||= rep.sampled;
      stmts.push(db.prepare("DELETE FROM ga4_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = ?").bind(orgId, prop.id, dimension));
      for (const r of rep.rows) {
        const key = r.dims[0] || "(not set)";
        stmts.push(
          db
            .prepare(
              "INSERT OR REPLACE INTO ga4_top_rows (organization_id, property_id, dimension, key, sessions, total_users, engaged_sessions, key_events, period_start, period_end, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(orgId, prop.id, dimension, key, r.values.sessions, r.values.totalUsers, r.values.engagedSessions, r.values.keyEvents, cur.startDate, endDate, observedAt),
        );
      }
      counts[dimension] = rep.rows.length;
    }
    await db.batch([
      ...stmts,
      db
        .prepare("UPDATE ga4_properties SET last_sync_at = ?, last_error = NULL, time_zone = ?, currency_code = ?, last_thresholded = ?, last_sampled = ? WHERE organization_id = ? AND id = ?")
        .bind(observedAt, daily.timeZone, daily.currencyCode, thresholded ? 1 : 0, sampled ? 1 : 0, orgId, prop.id),
      db.prepare("UPDATE integrations SET last_sync_at = ?, last_error = NULL WHERE organization_id = ? AND id = ?").bind(observedAt, orgId, conn.integrationId),
    ]);
    await ctx.event("info", "ga4_synced", `Google Analytics: ${daily.rows.length} días, ${counts.channel} canales y ${counts.landing_page} páginas de entrada`, { startDate, endDate });
    return { creditsUsed: 0, property: prop.property, startDate, endDate, days: daily.rows.length, channels: counts.channel, landingPages: counts.landing_page, thresholded, sampled };
  } catch (e) {
    if (e instanceof GoogleApiError) {
      await db.prepare("UPDATE ga4_properties SET last_error = ? WHERE organization_id = ? AND id = ?").bind(e.code, orgId, input.propertyId).run();
      if (PERMANENT.has(e.code) || e.status === 403 || e.status === 401 || e.status === 400) throw new PermanentJobError(`ga4_${e.code}`, `Google Analytics: ${e.code}`);
      throw new Error(`Google Analytics: ${e.code}`, { cause: e });
    }
    if (e instanceof PermanentJobError) {
      await db.prepare("UPDATE ga4_properties SET last_error = ? WHERE organization_id = ? AND id = ?").bind(e.code, orgId, input.propertyId).run();
    }
    throw e;
  }
}
