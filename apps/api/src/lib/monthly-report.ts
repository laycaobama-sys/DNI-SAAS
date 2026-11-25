import { decliningPages, GSC_PAGE_ROWS, hmacSha256Hex, timingSafeEqual } from "@dni/core";
import type { Env } from "../env";
import { emailHtml, sendMail } from "./mail";
import { log, nowIso } from "./util";

/**
 * Monthly report email (Entrega 2 · B3.6): on the first days of each month, owners and admins of each
 * organisation get what was done the previous month and the Search Console results with source and period.
 * Only observed data or plain counts: nothing estimated, nothing from an AI model, and Google data is
 * not sent anywhere except to the organisation's own owners/admins. Organisations with nothing to report
 * get no email. One row per organisation, month and recipient is claimed before sending (never twice).
 */
const SEND_DAYS = 7; // days 1–7 of the month (catch-up if the cron was down)
const SEND_FROM_HOUR_UTC = 7;
const BATCH_ORGS = 10;

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const nf = new Intl.NumberFormat("es-ES");

function unsubscribeKey(env: Env): string {
  return `monthly-report-unsubscribe:${env.DATA_ENC_KEY ?? env.IP_HASH_SALT ?? "dev-only-key"}`;
}
export async function reportUnsubscribeToken(env: Env, userId: string): Promise<string> {
  return (await hmacSha256Hex(unsubscribeKey(env), userId)).slice(0, 32);
}
export async function verifyReportUnsubscribeToken(env: Env, userId: string, token: string): Promise<boolean> {
  return /^[0-9a-f]{32}$/.test(token) && timingSafeEqual(await reportUnsubscribeToken(env, userId), token);
}

/** The calendar month before `now` (UTC): label, `YYYY-MM` key and [start, end) ISO days, plus the month before it. */
export function reportPeriod(now: Date) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // current month index; the report covers m-1
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  const prevStart = new Date(Date.UTC(y, m - 2, 1));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    key: day(start).slice(0, 7),
    label: `${MONTHS[start.getUTCMonth()]} de ${start.getUTCFullYear()}`,
    prevLabel: `${MONTHS[prevStart.getUTCMonth()]} de ${prevStart.getUTCFullYear()}`,
    start: day(start),
    end: day(end),
    prevStart: day(prevStart),
    daysInMonth: Math.round((end.getTime() - start.getTime()) / 86400_000),
  };
}

type Period = ReturnType<typeof reportPeriod>;

interface Gsc {
  site: string;
  days: number;
  clicks: number;
  impressions: number;
  prev: { days: number; clicks: number; impressions: number } | null;
  declining: number;
  observedAt: string | null;
}

async function gscMonth(db: D1Database, orgId: string, p: Period): Promise<Gsc | null> {
  const prop = await db.prepare("SELECT id, site_url FROM gsc_properties WHERE organization_id = ? AND selected = 1").bind(orgId).first<{ id: string; site_url: string }>();
  if (!prop) return null;
  const sum = (from: string, to: string) =>
    db
      .prepare("SELECT COUNT(*) AS days, COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(impressions), 0) AS impressions, MAX(observed_at) AS observed FROM gsc_daily_metrics WHERE organization_id = ? AND property_id = ? AND date >= ? AND date < ?")
      .bind(orgId, prop.id, from, to)
      .first<{ days: number; clicks: number; impressions: number; observed: string | null }>();
  const [cur, prev] = await Promise.all([sum(p.start, p.end), sum(p.prevStart, p.start)]);
  if (!cur || !cur.days) return null;
  const rows = async (sql: string) => (await db.prepare(sql).bind(orgId, prop.id).all<{ key: string; clicks: number; impressions: number; position: number }>()).results;
  const [now, before] = await Promise.all([
    rows("SELECT key, clicks, impressions, position FROM gsc_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = 'page'"),
    rows("SELECT key, clicks, impressions, position FROM gsc_page_prev WHERE organization_id = ? AND property_id = ?"),
  ]);
  return {
    site: prop.site_url,
    days: cur.days,
    clicks: cur.clicks,
    impressions: cur.impressions,
    prev: prev && prev.days ? { days: prev.days, clicks: prev.clicks, impressions: prev.impressions } : null,
    declining: before.length ? decliningPages(now, before, { currentComplete: now.length < GSC_PAGE_ROWS }).length : 0,
    observedAt: cur.observed,
  };
}

async function workDone(db: D1Database, orgId: string, p: Period) {
  const count = async (sql: string) => (await db.prepare(sql).bind(orgId, `${p.start}T00:00:00.000Z`, `${p.end}T00:00:00.000Z`).first<{ n: number }>())?.n ?? 0;
  const [audits, approved, cms, social] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM web_crawls WHERE organization_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?"),
    count("SELECT COUNT(*) AS n FROM content_items WHERE organization_id = ? AND approved_at >= ? AND approved_at < ?"),
    count("SELECT COUNT(*) AS n FROM cms_publications WHERE organization_id = ? AND published_at >= ? AND published_at < ?"),
    count("SELECT COUNT(*) AS n FROM social_posts WHERE organization_id = ? AND status = 'published' AND published_at >= ? AND published_at < ?"),
  ]);
  return { audits, approved, cms, social };
}

const change = (cur: number, prev: number) => {
  if (!prev) return "";
  const d = (cur - prev) / prev;
  const pct = Math.abs(d * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 });
  return d === 0 ? " (igual que el mes anterior)" : ` (${d > 0 ? "+" : "−"}${pct} % frente al mes anterior)`;
};

export function buildMonthlyReport(org: { id: string; name: string }, p: Period, gsc: Gsc | null, work: Awaited<ReturnType<typeof workDone>>, origin: string) {
  const name = org.name.replace(/[\r\n]+/g, " ").slice(0, 80);
  const subject = `Tu mes en DNI Growth: ${p.label} · ${name}`;
  const paragraphs: string[] = [`Resumen de ${p.label} para «${name}».`];
  const done: string[] = [];
  if (work.audits) done.push(`${nf.format(work.audits)} ${work.audits === 1 ? "auditoría completada" : "auditorías completadas"}`);
  if (work.approved) done.push(`${nf.format(work.approved)} ${work.approved === 1 ? "contenido aprobado" : "contenidos aprobados"}`);
  if (work.cms) done.push(`${nf.format(work.cms)} ${work.cms === 1 ? "envío a tu web" : "envíos a tu web"}`);
  if (work.social) done.push(`${nf.format(work.social)} ${work.social === 1 ? "publicación en redes" : "publicaciones en redes"}`);
  paragraphs.push(done.length ? `Trabajo hecho: ${done.join(", ")}.` : "Este mes no se completó ninguna auditoría, aprobación ni publicación.");
  if (gsc) {
    const partial = gsc.days < p.daysInMonth ? ` Hay datos de ${gsc.days} de ${p.daysInMonth} días.` : "";
    const comparable = gsc.prev && gsc.prev.days === gsc.days;
    paragraphs.push(
      `Google Search Console (${gsc.site}): ${nf.format(gsc.clicks)} clics${comparable ? change(gsc.clicks, gsc.prev!.clicks) : ""} y ${nf.format(gsc.impressions)} impresiones${comparable ? change(gsc.impressions, gsc.prev!.impressions) : ""}.${partial}`,
    );
    if (gsc.declining) paragraphs.push(`${nf.format(gsc.declining)} ${gsc.declining === 1 ? "página pierde" : "páginas pierden"} clics frente a los 28 días anteriores. En la app verás cuáles y qué revisar.`);
    paragraphs.push(
      `Fuente: Google Search Console API, datos finales, sumas por día de ${p.label}${gsc.prev && !comparable ? ` (no se compara con ${p.prevLabel} porque no tenemos los mismos días)` : ""}. Google omite consultas anónimas y los datos pueden cambiar unos días después. No garantizamos posiciones.`,
    );
  } else {
    paragraphs.push("Search Console no está conectado o no tiene datos de este mes: conéctalo para ver clics e impresiones reales.");
  }
  const cta = { label: gsc ? "Ver el detalle en la app" : "Conectar Search Console", url: `${origin}/app/o/${org.id}/${gsc ? "search-console" : "integrations"}` };
  return { subject, paragraphs, cta };
}

export async function sendMonthlyReports(env: Env, now = new Date()): Promise<{ sent: number; skipped: number }> {
  if (now.getUTCDate() > SEND_DAYS || now.getUTCHours() < SEND_FROM_HOUR_UTC) return { sent: 0, skipped: 0 };
  const db = env.DB;
  const p = reportPeriod(now);
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  const recipientsSql = `FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
     WHERE m.status = 'active' AND m.role IN ('owner', 'admin') AND u.email_verified_at IS NOT NULL AND u.monthly_report_opt_out_at IS NULL
       AND o.deleted_at IS NULL AND o.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM monthly_report_sends s WHERE s.organization_id = m.organization_id AND s.period = ? AND s.user_id = m.user_id)`;
  const { results: orgs } = await db
    .prepare(`SELECT DISTINCT m.organization_id AS id, o.name AS name ${recipientsSql} ORDER BY m.organization_id LIMIT ?`)
    .bind(`${p.end}T00:00:00.000Z`, p.key, BATCH_ORGS)
    .all<{ id: string; name: string }>();
  let sent = 0;
  let skipped = 0;
  for (const org of orgs) {
    const [gsc, work] = await Promise.all([gscMonth(db, org.id, p), workDone(db, org.id, p)]);
    const nothing = !gsc && !work.audits && !work.approved && !work.cms && !work.social;
    const report = nothing ? null : buildMonthlyReport(org, p, gsc, work, origin);
    const { results: users } = await db
      .prepare(`SELECT u.id, u.email, u.name ${recipientsSql} AND m.organization_id = ?`)
      .bind(`${p.end}T00:00:00.000Z`, p.key, org.id)
      .all<{ id: string; email: string; name: string }>();
    for (const u of users) {
      const claim = await db
        .prepare("INSERT OR IGNORE INTO monthly_report_sends (organization_id, period, user_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(org.id, p.key, u.id, report ? "sent" : "skipped", report ? null : "nothing_to_report", nowIso(now))
        .run();
      if (!claim.meta.changes) continue;
      if (!report) {
        skipped++;
        continue;
      }
      const first = (u.name || "").trim().split(/\s+/)[0] || "";
      const paragraphs = [first ? `Hola, ${first}:` : "Hola:", ...report.paragraphs];
      const unsub = `${origin}/api/v1/public/monthly-report/unsubscribe?u=${encodeURIComponent(u.id)}&t=${await reportUnsubscribeToken(env, u.id)}`;
      const text = `${paragraphs.join("\n\n")}\n\n${report.cta.label}: ${report.cta.url}\n\n—\nNo quiero recibir el informe mensual: ${unsub}`;
      const result = await sendMail(
        env,
        { to: u.email, subject: report.subject, text, html: emailHtml(report.subject, paragraphs, report.cta, { unsubscribeUrl: unsub }) },
        { kind: "notification", idempotencyKey: `monthly-report:${org.id}:${p.key}:${u.id}`, organizationId: org.id },
      );
      if (result === "not_configured") {
        await db.prepare("UPDATE monthly_report_sends SET status = 'skipped', reason = 'mail_not_configured' WHERE organization_id = ? AND period = ? AND user_id = ?").bind(org.id, p.key, u.id).run();
        skipped++;
      } else sent++;
    }
  }
  if (sent || skipped) log("info", "monthly_report.run", { period: p.key, sent, skipped });
  return { sent, skipped };
}
