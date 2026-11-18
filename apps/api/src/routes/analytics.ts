import { Hono, type Context } from "hono";
import { z } from "zod";
import { can } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { GA4_SOURCE, GoogleApiError, googleReady, markReauth } from "../lib/google";
import { GA4_PROVIDER, ga4AccessToken, ga4SyncJobStatements, listProperties, loadGa4Connection, storeGa4Properties } from "../lib/ga4";
import { ApiError, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { dispatchOutbox } from "../jobs/queue";
import { requireScope } from "../middleware";
import { uuid } from "../lib/util";
import { completeGoogleConnect, disconnectGoogle, startGoogleConnect } from "./googleConnect";

/** Caveats shown next to every Google Analytics figure. */
export const GA4_CAVEATS = [
  "Datos de Google Analytics 4 (API de datos). Los últimos 1-2 días pueden cambiar mientras Google los procesa; cada sincronización vuelve a leer los últimos 30 días.",
  "Las fechas siguen la zona horaria de la propiedad de Analytics.",
  "Los usuarios de un periodo son los que calcula GA4 sin duplicados; no son la suma de los usuarios de cada día.",
  "GA4 solo mide visitas con consentimiento y con la etiqueta instalada; los bloqueadores y el rechazo de cookies reducen las cifras.",
  "Los eventos clave son los que la propiedad tenga marcados como tales en GA4; no son ventas atribuidas.",
];

export const analytics = new Hono<AppEnv>();

const NOT_ALLOWED = () => new ApiError(403, "ga4_property_not_allowed", "La cuenta de Google conectada no puede leer esta propiedad de Analytics.");

type Totals = { sessions: number; total_users: number; screen_page_views: number; engaged_sessions: number; key_events: number; period_start: string; period_end: string };
const shapeTotals = (r: Totals | undefined) =>
  r
    ? {
        period: { start: r.period_start, end: r.period_end },
        sessions: r.sessions,
        totalUsers: r.total_users,
        screenPageViews: r.screen_page_views,
        engagedSessions: r.engaged_sessions,
        keyEvents: r.key_events,
        engagementRate: r.sessions ? r.engaged_sessions / r.sessions : null,
      }
    : null;

analytics.get("/analytics", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await db
    .prepare("SELECT id, status, scopes_json, account_ref, last_sync_at, last_error, created_at FROM integrations WHERE organization_id = ? AND provider = ?")
    .bind(t.orgId, GA4_PROVIDER)
    .first<{ id: string; status: string; scopes_json: string; account_ref: string | null; last_sync_at: string | null; last_error: string | null; created_at: string }>();
  const { results: props } = await db
    .prepare(
      "SELECT id, property, display_name, account_name, accessible, selected, time_zone, currency_code, last_thresholded, last_sampled, last_sync_at, last_error FROM ga4_properties WHERE organization_id = ? ORDER BY selected DESC, account_name, display_name",
    )
    .bind(t.orgId)
    .all<{
      id: string;
      property: string;
      display_name: string;
      account_name: string | null;
      accessible: number;
      selected: number;
      time_zone: string | null;
      currency_code: string | null;
      last_thresholded: number;
      last_sampled: number;
      last_sync_at: string | null;
      last_error: string | null;
    }>();
  const sel = props.find((p) => p.selected === 1) ?? null;
  const activeJob = await db
    .prepare("SELECT id, state, progress, created_at FROM jobs WHERE organization_id = ? AND kind = 'ga4_sync' AND state IN ('queued','validating','running') ORDER BY created_at DESC LIMIT 1")
    .bind(t.orgId)
    .first();
  const lastJob = await db
    .prepare("SELECT id, state, failure_code, finished_at FROM jobs WHERE organization_id = ? AND kind = 'ga4_sync' AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT 1")
    .bind(t.orgId)
    .first();

  let report: unknown = null;
  if (sel) {
    const { results: daily } = await db
      .prepare(
        "SELECT date, sessions, total_users, screen_page_views, engaged_sessions, key_events, observed_at FROM ga4_daily_metrics WHERE organization_id = ? AND property_id = ? ORDER BY date DESC LIMIT 90",
      )
      .bind(t.orgId, sel.id)
      .all<{ date: string; sessions: number; total_users: number; screen_page_views: number; engaged_sessions: number; key_events: number; observed_at: string }>();
    daily.reverse();
    const { results: totals } = await db
      .prepare("SELECT period, period_start, period_end, sessions, total_users, screen_page_views, engaged_sessions, key_events FROM ga4_period_totals WHERE organization_id = ? AND property_id = ?")
      .bind(t.orgId, sel.id)
      .all<Totals & { period: string }>();
    const top = async (dimension: "channel" | "landing_page") =>
      (
        await db
          .prepare(
            "SELECT key, sessions, total_users, engaged_sessions, key_events, period_start, period_end FROM ga4_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = ? ORDER BY sessions DESC, key LIMIT 25",
          )
          .bind(t.orgId, sel.id, dimension)
          .all()
      ).results;
    const observedAt = daily.reduce<string | null>((a, r) => (!a || r.observed_at > a ? r.observed_at : a), null);
    const caveats = [...GA4_CAVEATS];
    if (sel.last_thresholded) caveats.unshift("GA4 aplicó umbrales de privacidad en la última sincronización: algunas filas con pocos usuarios se han ocultado.");
    if (sel.last_sampled) caveats.unshift("GA4 muestreó parte de los datos en la última sincronización: las cifras son aproximadas.");
    report = {
      propertyId: sel.id,
      property: sel.property,
      displayName: sel.display_name,
      timeZone: sel.time_zone,
      lastSyncAt: sel.last_sync_at,
      source: "Google Analytics Data API · properties.runReport",
      observedAt,
      measurement: { daily: "observed", totals: "observed", engagementRate: "derived", topRows: "observed" },
      totals: shapeTotals(totals.find((r) => r.period === "current")),
      previousTotals: shapeTotals(totals.find((r) => r.period === "previous")),
      daily: daily.map((d) => ({
        date: d.date,
        sessions: d.sessions,
        totalUsers: d.total_users,
        screenPageViews: d.screen_page_views,
        engagedSessions: d.engaged_sessions,
        keyEvents: d.key_events,
      })),
      topChannels: await top("channel"),
      topLandingPages: await top("landing_page"),
      thresholded: sel.last_thresholded === 1,
      sampled: sel.last_sampled === 1,
      caveats,
    };
  }

  return c.json({
    configured: googleReady(c.env),
    canManage: can(t.role, "integrations:manage"),
    connection: conn
      ? {
          status: conn.status,
          scopes: JSON.parse(conn.scopes_json || "[]"),
          account: can(t.role, "integrations:read") ? conn.account_ref : null,
          connectedAt: conn.created_at,
          lastSyncAt: conn.last_sync_at,
          lastError: conn.last_error,
        }
      : null,
    properties: props.map((p) => ({
      id: p.id,
      property: p.property,
      displayName: p.display_name,
      accountName: p.account_name,
      readable: p.accessible === 1,
      selected: p.selected === 1,
      lastSyncAt: p.last_sync_at,
      lastError: p.last_error,
    })),
    activeJob,
    lastJob,
    report,
  });
});

/** Starts Google consent for the read-only Analytics scope. Returns the URL; the SPA navigates. */
analytics.post("/analytics/connect", requireScope("integrations:manage"), (c) => startGoogleConnect(c, GA4_SOURCE));

/** Shared Google callback → Analytics: stores the encrypted grant and lists the readable properties. */
export function completeGa4Connect(
  c: Context<AppEnv>,
  row: { code_verifier: string; nonce: string; organization_id: string | null; user_id: string | null },
  code: string | null,
) {
  return completeGoogleConnect(
    c,
    GA4_SOURCE,
    row,
    code,
    async (accessToken, orgId, integrationId) => storeGa4Properties(c.env.DB, orgId, integrationId, await listProperties(c.get("deps"), accessToken)),
    "properties",
  );
}

/** Re-reads the properties the connected account can access. */
analytics.post("/analytics/properties/refresh", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  await rateLimit(db, `ga4-props:${t.orgId}`, 20, 3600);
  const conn = await loadGa4Connection(c.env, t.orgId).catch((e) => {
    throw new ApiError(409, "ga4_not_connected", "Conecta Google Analytics primero.", { reason: e instanceof GoogleApiError ? e.code : "error" });
  });
  try {
    const token = await ga4AccessToken(c.env, c.get("deps"), conn.refreshToken);
    await storeGa4Properties(db, t.orgId, conn.integrationId, await listProperties(c.get("deps"), token));
    await db.prepare("UPDATE integrations SET last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, conn.integrationId).run();
  } catch (e) {
    const code = e instanceof GoogleApiError ? e.code : "error";
    if (code === "invalid_grant" || code === "scope_not_granted") {
      await markReauth(db, t.orgId, conn.integrationId, code);
      throw new ApiError(409, "ga4_reauth_required", "Google retiró el permiso. Vuelve a conectar Google Analytics.");
    }
    await db.prepare("UPDATE integrations SET last_error = ? WHERE organization_id = ? AND id = ?").bind(`properties:${code}`, t.orgId, conn.integrationId).run();
    throw new ApiError(502, "ga4_upstream_error", "Google no devolvió la lista de propiedades. Inténtalo más tarde.", { reason: code });
  }
  return c.json({ ok: true });
});

const SelectInput = z.object({ propertyId: z.string().uuid() });

/** Chooses which property feeds the panel. */
analytics.put("/analytics/property", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const { propertyId } = await parseBody(c, SelectInput);
  const p = await db
    .prepare("SELECT id, property, display_name, accessible FROM ga4_properties WHERE organization_id = ? AND id = ?")
    .bind(t.orgId, propertyId)
    .first<{ id: string; property: string; display_name: string; accessible: number }>();
  if (!p) throw notFound("Propiedad");
  if (p.accessible !== 1) throw NOT_ALLOWED();
  await db.batch([
    db.prepare("UPDATE ga4_properties SET selected = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE organization_id = ?").bind(p.id, t.orgId),
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "integration.ga4_property_select",
      entityType: "ga4_property",
      entityId: p.id,
      after: { property: p.property, displayName: p.display_name },
      requestId: c.get("requestId"),
    }),
  ]);
  return c.json({ ok: true });
});

/** Queues a sync of the selected property (durable job; one at a time per organization). */
analytics.post("/analytics/sync", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await db.prepare("SELECT status FROM integrations WHERE organization_id = ? AND provider = ?").bind(t.orgId, GA4_PROVIDER).first<{ status: string }>();
  if (conn?.status !== "connected") throw new ApiError(409, "ga4_not_connected", "Conecta Google Analytics primero.");
  const p = await db.prepare("SELECT id, accessible FROM ga4_properties WHERE organization_id = ? AND selected = 1").bind(t.orgId).first<{ id: string; accessible: number }>();
  if (!p) throw new ApiError(409, "ga4_no_property", "Elige primero la propiedad de Google Analytics.");
  if (p.accessible !== 1) throw NOT_ALLOWED();
  const active = await db
    .prepare("SELECT id, state FROM jobs WHERE organization_id = ? AND kind = 'ga4_sync' AND state IN ('queued','validating','running') LIMIT 1")
    .bind(t.orgId)
    .first<{ id: string; state: string }>();
  if (active) return c.json({ jobId: active.id, state: active.state, alreadyQueued: true }, 200);
  await rateLimit(db, `ga4-sync:${t.orgId}`, 10, 3600);
  const q = ga4SyncJobStatements(db, t.orgId, p.id, t.userId, `ga4-manual-${uuid()}`);
  await db.batch([
    ...q.stmts,
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "integration.ga4_sync", entityType: "job", entityId: q.jobId, requestId: c.get("requestId") }),
  ]);
  await dispatchOutbox(c.env, c.get("deps"), (pr) => c.executionCtx.waitUntil(pr), [q.outboxId]);
  return c.json({ jobId: q.jobId, state: "queued" }, 202);
});

/** Disconnect (revoke at Google, delete the encrypted token). Observed data stays unless `purge=true`. */
analytics.delete("/analytics", requireScope("integrations:manage"), (c) =>
  disconnectGoogle(c, GA4_SOURCE, (orgId) => [c.env.DB.prepare("DELETE FROM ga4_properties WHERE organization_id = ?").bind(orgId)]),
);
