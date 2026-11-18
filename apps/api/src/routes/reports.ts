import { Hono } from "hono";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, assertUuid } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, toCsv } from "../lib/util";
import { requireScope } from "../middleware";
import { GA4_CAVEATS } from "./analytics";
import { geoRecommendations, geoVisibility } from "./geo";
import { GSC_CAVEATS } from "./searchConsole";

/**
 * F3 — Exportable performance report (JSON / CSV; PDF is printed from the app's report view).
 * Every section states its source, period, observation time, measurement type and caveats.
 * Nothing is estimated or invented: a section without data says so ("not_connected" / "no_data").
 */
export const reports = new Hono<AppEnv>();

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

async function gscSection(env: Env, orgId: string) {
  const db = env.DB;
  const prop = await db.prepare("SELECT id, site_url, last_sync_at FROM gsc_properties WHERE organization_id = ? AND selected = 1").bind(orgId).first<{ id: string; site_url: string; last_sync_at: string | null }>();
  if (!prop) return { status: "not_connected" as const, source: "Google Search Console API · searchanalytics.query", note: "Search Console no está conectado o no hay propiedad elegida." };
  const { results: days } = await db
    .prepare("SELECT date, clicks, impressions, position, observed_at FROM gsc_daily_metrics WHERE organization_id = ? AND property_id = ? ORDER BY date DESC LIMIT 28")
    .bind(orgId, prop.id)
    .all<{ date: string; clicks: number; impressions: number; position: number; observed_at: string }>();
  if (!days.length) return { status: "no_data" as const, property: prop.site_url, source: "Google Search Console API · searchanalytics.query", note: "Aún no hay datos sincronizados." };
  const clicks = days.reduce((a, d) => a + d.clicks, 0);
  const impressions = days.reduce((a, d) => a + d.impressions, 0);
  const posWeighted = impressions ? days.reduce((a, d) => a + d.position * d.impressions, 0) / impressions : null;
  const top = async (dimension: "query" | "page") =>
    (
      await db
        .prepare("SELECT key, clicks, impressions, ctr, position FROM gsc_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = ? ORDER BY clicks DESC, impressions DESC LIMIT 10")
        .bind(orgId, prop.id, dimension)
        .all<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>()
    ).results.map((x) => ({ ...x, ctr: r4(x.ctr), position: r2(x.position) }));
  const sorted = days.map((d) => d.date).sort();
  return {
    status: "ok" as const,
    property: prop.site_url,
    period: { from: sorted[0]!, to: sorted[sorted.length - 1]!, days: days.length },
    totals: { clicks, impressions, ctr: impressions ? r4(clicks / impressions) : null, averagePosition: posWeighted === null ? null : r2(posWeighted) },
    measurement: { clicks: "observed", impressions: "observed", ctr: "derived", averagePosition: "derived (media ponderada por impresiones de los valores diarios)" },
    topQueries: await top("query"),
    topPages: await top("page"),
    source: "Google Search Console API · searchanalytics.query (dataState=final)",
    observedAt: days.reduce((a, d) => (d.observed_at > a ? d.observed_at : a), days[0]!.observed_at),
    caveats: GSC_CAVEATS,
  };
}

async function ga4Section(env: Env, orgId: string) {
  const db = env.DB;
  const prop = await db
    .prepare("SELECT id, property, display_name, time_zone, last_thresholded, last_sampled FROM ga4_properties WHERE organization_id = ? AND selected = 1")
    .bind(orgId)
    .first<{ id: string; property: string; display_name: string; time_zone: string | null; last_thresholded: number; last_sampled: number }>();
  if (!prop) return { status: "not_connected" as const, source: "Google Analytics Data API · properties.runReport", note: "Analytics no está conectado o no hay propiedad elegida." };
  const { results: totals } = await db
    .prepare("SELECT period, period_start, period_end, sessions, total_users, screen_page_views, engaged_sessions, key_events, observed_at FROM ga4_period_totals WHERE organization_id = ? AND property_id = ?")
    .bind(orgId, prop.id)
    .all<{ period: string; period_start: string; period_end: string; sessions: number; total_users: number; screen_page_views: number; engaged_sessions: number; key_events: number; observed_at: string }>();
  const cur = totals.find((x) => x.period === "current");
  if (!cur) return { status: "no_data" as const, property: prop.display_name, source: "Google Analytics Data API · properties.runReport", note: "Aún no hay datos sincronizados." };
  const prev = totals.find((x) => x.period === "previous") ?? null;
  const shape = (x: typeof cur) => ({
    period: { from: x.period_start, to: x.period_end },
    sessions: x.sessions,
    totalUsers: x.total_users,
    screenPageViews: x.screen_page_views,
    engagedSessions: x.engaged_sessions,
    engagementRate: x.sessions ? r4(x.engaged_sessions / x.sessions) : null,
    keyEvents: x.key_events,
  });
  const top = async (dimension: "channel" | "landing_page") =>
    (
      await db
        .prepare("SELECT key, sessions, total_users, engaged_sessions, key_events FROM ga4_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = ? ORDER BY sessions DESC, key LIMIT 10")
        .bind(orgId, prop.id, dimension)
        .all<{ key: string; sessions: number; total_users: number; engaged_sessions: number; key_events: number }>()
    ).results;
  const caveats = [...GA4_CAVEATS];
  if (prop.last_thresholded) caveats.unshift("GA4 aplicó umbrales de privacidad en la última sincronización: algunas filas con pocos usuarios se han ocultado.");
  if (prop.last_sampled) caveats.unshift("GA4 muestreó parte de los datos en la última sincronización: las cifras son aproximadas.");
  return {
    status: "ok" as const,
    property: prop.display_name,
    timeZone: prop.time_zone,
    current: shape(cur),
    previous: prev ? shape(prev) : null,
    measurement: { sessions: "observed", totalUsers: "observed", screenPageViews: "observed", engagedSessions: "observed", keyEvents: "observed", engagementRate: "derived" },
    topChannels: await top("channel"),
    topLandingPages: await top("landing_page"),
    source: "Google Analytics Data API · properties.runReport",
    observedAt: cur.observed_at,
    caveats,
  };
}

export async function buildPerformanceReport(env: Env, orgId: string, brandId: string | null) {
  const db = env.DB;
  const org = await db.prepare("SELECT name FROM organizations WHERE id = ?").bind(orgId).first<{ name: string }>();
  const brand = brandId
    ? await db.prepare("SELECT id, name, domain FROM brands WHERE organization_id = ? AND id = ?").bind(orgId, brandId).first<{ id: string; name: string; domain: string | null }>()
    : await db.prepare("SELECT id, name, domain FROM brands WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(orgId).first<{ id: string; name: string; domain: string | null }>();
  if (brandId && !brand) throw new ApiError(404, "not_found", "Marca no encontrada.");
  const [gsc, ga4] = await Promise.all([gscSection(env, orgId), ga4Section(env, orgId)]);
  let geo: unknown = { status: "no_brand", note: "La organización aún no tiene marca." };
  if (brand) {
    const vis = await geoVisibility(env, orgId, brand);
    const recs = await geoRecommendations(env, orgId, brand);
    geo = vis.summary.sampledPrompts
      ? {
          status: "ok",
          visibility: vis.summary,
          prompts: vis.rows.map((r) => ({ question: r.question, intent: r.intent, category: r.category, model: r.model, grounded: r.grounded === 1, mentioned: r.brand_mentioned === 1, sampledAt: r.sampled_at })),
          recommendations: recs.items.map((x) => ({ priority: x.priority, title: x.title, action: x.action, target: x.target.url ?? x.target.title, targetType: x.target.type })),
          recommendationsMethod: recs.method,
        }
      : { status: "no_data", visibility: vis.summary, note: "Aún no hay respuestas muestreadas en los últimos 30 días." };
  }
  return {
    report: "Informe de rendimiento SEO, analítica y visibilidad en IA",
    organization: org?.name ?? null,
    brand: brand ? { id: brand.id, name: brand.name, domain: brand.domain } : null,
    generatedAt: nowIso(),
    generatedBy: "DNI Growth",
    sections: { searchConsole: gsc, analytics: ga4, geo },
    disclaimers: [
      "Cada cifra indica su fuente, periodo, fecha de observación y tipo de medida: observada (dato del proveedor), derivada (cálculo sobre datos observados) o muestra (respuestas de IA puntuales).",
      "Las secciones usan periodos distintos según su fuente: no sumes ni compares directamente cifras de secciones diferentes.",
      "Ningún buscador ni motor de IA garantiza posiciones, tráfico ni menciones: este informe describe lo observado, no predice resultados.",
      "No incluye datos estimados ni de demostración. Si una sección no está conectada o no tiene datos, se indica así.",
    ],
  };
}

type Report = Awaited<ReturnType<typeof buildPerformanceReport>>;

/** Long-format CSV: one metric per row, each with its own source, period, measurement and observation time. */
export function reportToCsv(rep: Report): string {
  const rows: unknown[][] = [];
  const add = (section: string, metric: string, value: unknown, from: string | null, to: string | null, source: string, measurement: string, observedAt: string | null, note = "") =>
    rows.push([section, metric, value, from, to, source, measurement, observedAt, note]);
  const g = rep.sections.searchConsole as any;
  if (g.status === "ok") {
    for (const [k, label] of [["clicks", "Clics"], ["impressions", "Impresiones"], ["ctr", "CTR"], ["averagePosition", "Posición media"]] as const)
      add("Search Console", label, g.totals[k], g.period.from, g.period.to, g.source, g.measurement[k], g.observedAt, g.property);
    for (const q of g.topQueries) add("Search Console · consultas", q.key, q.clicks, g.period.from, g.period.to, g.source, "observed", g.observedAt, `impresiones=${q.impressions}; ctr=${q.ctr}; posicion=${q.position}`);
    for (const q of g.topPages) add("Search Console · páginas", q.key, q.clicks, g.period.from, g.period.to, g.source, "observed", g.observedAt, `impresiones=${q.impressions}; ctr=${q.ctr}; posicion=${q.position}`);
  } else add("Search Console", "estado", g.status, null, null, g.source, "none", null, g.note);
  const a = rep.sections.analytics as any;
  if (a.status === "ok") {
    for (const [k, label] of [["sessions", "Sesiones"], ["totalUsers", "Usuarios"], ["screenPageViews", "Vistas"], ["engagedSessions", "Sesiones con interacción"], ["engagementRate", "Tasa de interacción"], ["keyEvents", "Eventos clave"]] as const) {
      add("Analytics", label, a.current[k], a.current.period.from, a.current.period.to, a.source, a.measurement[k], a.observedAt, a.property);
      if (a.previous) add("Analytics · periodo anterior", label, a.previous[k], a.previous.period.from, a.previous.period.to, a.source, a.measurement[k], a.observedAt, a.property);
    }
    for (const x of a.topChannels) add("Analytics · canales", x.key, x.sessions, a.current.period.from, a.current.period.to, a.source, "observed", a.observedAt, `usuarios=${x.total_users}; eventos_clave=${x.key_events}`);
    for (const x of a.topLandingPages) add("Analytics · páginas de entrada", x.key, x.sessions, a.current.period.from, a.current.period.to, a.source, "observed", a.observedAt, `usuarios=${x.total_users}; eventos_clave=${x.key_events}`);
  } else add("Analytics", "estado", a.status, null, null, a.source, "none", null, a.note);
  const geo = rep.sections.geo as any;
  if (geo.status === "ok") {
    const v = geo.visibility;
    const ci = v.mentionRateInterval ? `IC95% ${v.mentionRateInterval.low}–${v.mentionRateInterval.high}` : "";
    add("Visibilidad en IA", "Preguntas muestreadas", v.sampledPrompts, v.period?.from ?? null, v.period?.to ?? null, v.source, "observed_sample", v.observedAt);
    add("Visibilidad en IA", "Menciones de la marca", v.mentioned, v.period?.from ?? null, v.period?.to ?? null, v.source, "observed_sample", v.observedAt);
    add("Visibilidad en IA", "Tasa de mención", v.mentionRate === null ? "" : r4(v.mentionRate), v.period?.from ?? null, v.period?.to ?? null, v.source, "derived", v.observedAt, ci);
    add("Visibilidad en IA", "Tasa de citas (solo respuestas con búsqueda)", v.citationRate === null ? "" : r4(v.citationRate), v.period?.from ?? null, v.period?.to ?? null, v.source, "derived", v.observedAt, `${v.groundedSamples} respuestas con búsqueda`);
    for (const p of geo.prompts) add("Visibilidad en IA · preguntas", p.question, p.mentioned ? "mencionada" : "no mencionada", p.sampledAt, p.sampledAt, v.source, "observed_sample", p.sampledAt, `modelo=${p.model}; busqueda=${p.grounded ? "sí" : "no"}; intencion=${p.intent}`);
    for (const r of geo.recommendations) add("Recomendaciones GEO", r.title, r.priority, null, null, "Reglas de DNI Growth sobre las muestras", "derived", v.observedAt, `${r.action} Destino: ${r.target ?? "—"}`);
  } else add("Visibilidad en IA", "estado", geo.status, null, null, "Gemini API", "none", null, geo.note ?? "");
  for (const d of rep.disclaimers) add("Aviso", "", "", null, null, "DNI Growth", "none", rep.generatedAt, d);
  return toCsv(["seccion", "metrica", "valor", "desde", "hasta", "fuente", "tipo_de_medida", "observado_en", "nota"], rows);
}

reports.get("/reports/performance", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const brandIdQ = c.req.query("brandId");
  const brandId = brandIdQ ? assertUuid(brandIdQ, "Marca") : null;
  const format = c.req.query("format");
  const rep = await buildPerformanceReport(c.env, t.orgId, brandId);
  if (format !== "json" && format !== "csv") return c.json(rep);
  // Downloads are data exports: rate-limited and recorded in the audit log.
  await rateLimit(db, `report-export:${t.orgId}:${t.userId}`, 30, 3600);
  await auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "report.export", entityType: "report", entityId: rep.brand?.id ?? null, after: { format, report: "performance" }, requestId: c.get("requestId") }).run();
  const fileBase = `informe-${(rep.brand?.domain ?? rep.brand?.name ?? "organizacion").replace(/[^a-z0-9.-]+/gi, "-").toLowerCase()}-${rep.generatedAt.slice(0, 10)}`;
  if (format === "json") {
    c.header("content-disposition", `attachment; filename="${fileBase}.json"`);
    return c.json(rep);
  }
  return c.body(reportToCsv(rep), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fileBase}.csv"` });
});
