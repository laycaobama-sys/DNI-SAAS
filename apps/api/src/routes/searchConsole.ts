import { Hono, type Context } from "hono";
import { z } from "zod";
import { can, DECLINE_DEFAULTS, DECLINE_REASON_LABEL, decliningPages, GSC_PAGE_ROWS } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { GSC_SOURCE } from "../lib/google";
import {
  GSC_PROVIDER,
  GscError,
  gscReady,
  gscSyncJobStatements,
  listSites,
  loadConnection,
  accessTokenFromRefresh,
  markReauth,
  READABLE_PERMISSIONS,
  storeProperties,
} from "../lib/gsc";
import { ApiError, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { dispatchOutbox } from "../jobs/queue";
import { requireScope } from "../middleware";
import { nowIso, uuid } from "../lib/util";
import { completeGoogleConnect, disconnectGoogle, startGoogleConnect } from "./googleConnect";

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
    // Pages that lose clicks: current 28 days vs the 28 before, compared deterministically (no AI, nothing leaves the platform).
    const pageRows = async (table: "gsc_top_rows" | "gsc_page_prev") =>
      (
        await db
          .prepare(`SELECT key, clicks, impressions, position, period_start, period_end FROM ${table} WHERE organization_id = ? AND property_id = ?${table === "gsc_top_rows" ? " AND dimension = 'page'" : ""}`)
          .bind(t.orgId, sel.id)
          .all<{ key: string; clicks: number; impressions: number; position: number; period_start: string; period_end: string }>()
      ).results;
    const [curPages, prevPages] = await Promise.all([pageRows("gsc_top_rows"), pageRows("gsc_page_prev")]);
    const declining = prevPages.length
      ? {
          source: "Google Search Console API · searchAnalytics.query por página",
          measurement: "derived",
          period: curPages[0] ? { start: curPages[0].period_start, end: curPages[0].period_end } : null,
          previousPeriod: { start: prevPages[0]!.period_start, end: prevPages[0]!.period_end },
          rule: `Pierde al menos ${DECLINE_DEFAULTS.minLostClicks} clics y al menos un ${Math.round(DECLINE_DEFAULTS.minDrop * 100)} % de los que tenía`,
          pages: decliningPages(curPages, prevPages, { currentComplete: curPages.length < GSC_PAGE_ROWS }).map((d) => ({ ...d, advice: DECLINE_REASON_LABEL[d.reason] })),
        }
      : null;
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
      declining,
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
searchConsole.post("/search-console/connect", requireScope("integrations:manage"), (c) => startGoogleConnect(c, GSC_SOURCE));

/** Shared Google callback → Search Console: stores the encrypted grant and lists the account's properties. */
export function completeGscConnect(
  c: Context<AppEnv>,
  row: { code_verifier: string; nonce: string; organization_id: string | null; user_id: string | null },
  code: string | null,
) {
  return completeGoogleConnect(
    c,
    GSC_SOURCE,
    row,
    code,
    async (accessToken, orgId, integrationId) => storeProperties(c.env.DB, orgId, integrationId, await listSites(c.get("deps"), accessToken)),
    "sites",
  );
}

/** Re-reads the properties the connected account can access (e.g. after adding one in Search Console). */
searchConsole.post("/search-console/properties/refresh", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  await rateLimit(db, `gsc-props:${t.orgId}`, 20, 3600);
  const conn = await loadConnection(c.env, t.orgId).catch((e) => {
    throw new ApiError(409, "gsc_not_connected", "Conecta Search Console primero.", { reason: e instanceof GscError ? e.code : "error" });
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
    throw new ApiError(502, "gsc_upstream_error", "Google no devolvió la lista de propiedades. Inténtalo más tarde.", { reason: code });
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

/**
 * Stops using the selected property: no more syncs (pending ones are cancelled). With `purge=true`
 * the data already imported from it is deleted too. The Google connection itself stays.
 */
searchConsole.delete("/search-console/property", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const purge = c.req.query("purge") === "true";
  const p = await db.prepare("SELECT id, site_url FROM gsc_properties WHERE organization_id = ? AND selected = 1").bind(t.orgId).first<{ id: string; site_url: string }>();
  if (!p) throw notFound("Propiedad seleccionada");
  await db.batch([
    db.prepare("UPDATE gsc_properties SET selected = 0 WHERE organization_id = ? AND id = ?").bind(t.orgId, p.id),
    db
      .prepare("UPDATE jobs SET cancel_requested_at = ? WHERE organization_id = ? AND kind = 'gsc_sync' AND state IN ('queued','validating','running') AND cancel_requested_at IS NULL")
      .bind(nowIso(), t.orgId),
    ...(purge
      ? [
          db.prepare("DELETE FROM gsc_daily_metrics WHERE organization_id = ? AND property_id = ?").bind(t.orgId, p.id),
          db.prepare("DELETE FROM gsc_top_rows WHERE organization_id = ? AND property_id = ?").bind(t.orgId, p.id),
          db.prepare("DELETE FROM gsc_page_prev WHERE organization_id = ? AND property_id = ?").bind(t.orgId, p.id),
          db.prepare("UPDATE gsc_properties SET last_sync_at = NULL, last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, p.id),
        ]
      : []),
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "integration.gsc_property_deselect",
      entityType: "gsc_property",
      entityId: p.id,
      after: { siteUrl: p.site_url, dataPurged: purge },
      requestId: c.get("requestId"),
    }),
  ]);
  return c.json({ ok: true, dataPurged: purge });
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
searchConsole.delete("/search-console", requireScope("integrations:manage"), (c) =>
  disconnectGoogle(c, GSC_SOURCE, (orgId) => [c.env.DB.prepare("DELETE FROM gsc_properties WHERE organization_id = ?").bind(orgId)]),
);

