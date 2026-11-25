/**
 * /estado: synthetic checks run by the cron every 5 minutes, 90 days of history and alerts to the
 * platform owners (email) when a check fails twice in a row and when it recovers.
 * Every check reads real state (pages served, database, queues, payments, Google syncs, email,
 * backups); nothing is assumed. Results are public without personal data.
 */
import { buildPublicAuditResult, META_GRAPH_VERSION, runSeoRules } from "@dni/core";
import type { Deps, Env } from "../env";
import { crawlSite } from "../jobs/crawl";
import { emailHtml, sendMail } from "./mail";
import { getSetting, setSetting } from "./stripe";
import { log, nowIso } from "./util";

export interface CheckDef {
  key: string;
  label: string;
  description: string;
}

export const STATUS_CHECKS: CheckDef[] = [
  { key: "web", label: "Web pública", description: "La portada y las páginas públicas se sirven correctamente." },
  { key: "api", label: "Aplicación y base de datos", description: "La API responde y la base de datos acepta consultas." },
  { key: "audit", label: "Auditoría gratuita", description: "Una auditoría de prueba de una página propia termina con resultado (cada hora)." },
  { key: "jobs", label: "Trabajos en segundo plano", description: "Análisis, sincronizaciones y auditorías no se quedan atascados en la cola." },
  { key: "payments", label: "Pagos (Stripe)", description: "Los avisos de Stripe llegan y se procesan sin errores." },
  { key: "google", label: "Search Console y Analytics", description: "Las sincronizaciones diarias con Google terminan sin errores." },
  { key: "email", label: "Correo", description: "Los correos de la plataforma salen sin quedarse atascados." },
  { key: "backup", label: "Copias de seguridad", description: "Hay una copia de la base de datos de las últimas 26 horas." },
  { key: "meta", label: "Facebook e Instagram", description: "Meta acepta las credenciales de la app de DNI Growth (cada hora)." },
];

export const STATUS_INTERVAL_MIN = 5;
const RETENTION_DAYS = 90;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Result = { ok: boolean; latency?: number; detail: string };

async function timed(fn: () => Promise<Result>): Promise<Result> {
  const t = Date.now();
  try {
    const r = await fn();
    return { ...r, latency: r.latency ?? Date.now() - t };
  } catch (e) {
    return { ok: false, latency: Date.now() - t, detail: `Error: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` };
  }
}

async function runCheck(key: string, env: Env, deps: Deps, last: Map<string, { ok: number; checked_at: string }>): Promise<Result | null> {
  const db = env.DB;
  switch (key) {
    case "web":
      return timed(async () => {
        if (!env.ASSETS) return { ok: true, detail: "Sin archivos estáticos en este entorno." };
        const res = await env.ASSETS.fetch(new Request(new URL("/", env.APP_ORIGIN)));
        const html = res.ok ? await res.text() : "";
        return { ok: res.ok && html.includes("DNI Growth"), detail: `Portada: HTTP ${res.status}` };
      });
    case "api":
      return timed(async () => {
        const r = await db.prepare("SELECT 1 AS one").first<{ one: number }>();
        return { ok: r?.one === 1, detail: "Consulta a la base de datos correcta." };
      });
    case "audit": {
      // Hourly: a real crawl of one own page with the same crawler and rules customers get.
      const prev = last.get("audit");
      if (prev && Date.now() - Date.parse(prev.checked_at) < 55 * 60_000) return null;
      return timed(async () => {
        const noop = async () => {};
        const { site } = await crawlSite(deps, `${env.APP_ORIGIN.replace(/\/$/, "")}/seguridad`, 1, { event: noop, progress: noop, checkpoint: noop }, { timeoutMs: 10_000 });
        const r = buildPublicAuditResult(runSeoRules(site), { origin: site.origin, pagesAnalyzed: site.pages.length, observedAt: nowIso() });
        return { ok: site.pages.length > 0, detail: `Página analizada, nota ${r.scores.global}/100.` };
      });
    }
    case "jobs":
      return timed(async () => {
        const stuck = await db
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','validating','running') AND created_at < ?")
          .bind(ago(60 * 60_000))
          .first<{ n: number }>();
        const audits = await db.prepare("SELECT COUNT(*) AS n FROM public_audits WHERE status IN ('queued','running') AND created_at < ?").bind(ago(30 * 60_000)).first<{ n: number }>();
        const n = (stuck?.n ?? 0) + (audits?.n ?? 0);
        return { ok: n === 0, detail: n === 0 ? "Ningún trabajo atascado." : `${n} trabajo(s) esperando más de lo normal.` };
      });
    case "payments":
      return timed(async () => {
        const failed = await db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'stripe' AND status = 'failed' AND received_at > ?").bind(ago(24 * 3_600_000)).first<{ n: number }>();
        const lastEvt = await db.prepare("SELECT MAX(received_at) AS at FROM webhook_events WHERE provider = 'stripe'").first<{ at: string | null }>();
        const n = failed?.n ?? 0;
        const when = lastEvt?.at ? `Último aviso de Stripe: ${lastEvt.at.slice(0, 16).replace("T", " ")} UTC.` : "Aún no ha llegado ningún aviso de Stripe.";
        return { ok: n === 0, detail: n === 0 ? when : `${n} aviso(s) de Stripe con error en 24 h. ${when}` };
      });
    case "google":
      return timed(async () => {
        const r = await db
          .prepare("SELECT SUM(state = 'failed') AS failed, SUM(state = 'completed') AS done FROM jobs WHERE kind IN ('gsc_sync','ga4_sync') AND created_at > ?")
          .bind(ago(48 * 3_600_000))
          .first<{ failed: number | null; done: number | null }>();
        const failed = r?.failed ?? 0;
        return { ok: failed === 0, detail: `${r?.done ?? 0} sincronización(es) completada(s) y ${failed} con error en 48 h.` };
      });
    case "email":
      return timed(async () => {
        const r = await db
          .prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE (status = 'dead' AND updated_at > ?) OR (status IN ('queued','sending') AND next_attempt_at < ?)")
          .bind(ago(24 * 3_600_000), ago(60 * 60_000))
          .first<{ n: number }>();
        const n = r?.n ?? 0;
        return { ok: n === 0, detail: n === 0 ? "Sin correos atascados." : `${n} correo(s) sin salir.` };
      });
    case "backup":
      return timed(async () => {
        const r = await db.prepare("SELECT MAX(created_at) AS at FROM db_backups WHERE deleted_at IS NULL").first<{ at: string | null }>();
        const fresh = !!r?.at && Date.now() - Date.parse(r.at) < 26 * 3_600_000;
        return { ok: fresh, detail: r?.at ? `Última copia: ${r.at.slice(0, 16).replace("T", " ")} UTC.` : "Todavía no hay copias." };
      });
    case "meta": {
      const prev = last.get("meta");
      if (prev && prev.ok === 1 && Date.now() - Date.parse(prev.checked_at) < 55 * 60_000) return null;
      const appId = env.META_APP_ID;
      const appSecret = env.META_APP_SECRET;
      if (!appId || !appSecret) return null; // not set up in this environment
      return timed(async () => {
        // App access token request: only succeeds when the app id and secret match. The token is discarded.
        const res = await deps.fetchImpl(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: "client_credentials" }).toString(),
          signal: AbortSignal.timeout(10_000),
        });
        const j = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { code?: number } };
        const ok = res.ok && typeof j.access_token === "string" && j.access_token.length > 10;
        return { ok, detail: ok ? "Meta acepta las credenciales de la app." : `Meta rechaza las credenciales (HTTP ${res.status}${j.error?.code ? `, código ${j.error.code}` : ""}).` };
      });
    }
    default:
      return null;
  }
}

/** Cron: runs the checks at most every 5 minutes, stores them, prunes 90 days and sends alerts. */
export async function runStatusChecks(env: Env, deps: Deps, opts: { force?: boolean } = {}): Promise<number> {
  const db = env.DB;
  if (!opts.force) {
    const lastRun = await getSetting(db, "status_last_run");
    if (lastRun && Date.now() - Date.parse(lastRun) < (STATUS_INTERVAL_MIN * 60_000 - 15_000)) return 0;
  }
  await setSetting(db, "status_last_run", nowIso());
  const { results: lastRows } = await db
    .prepare("SELECT s.check_key, s.ok, s.checked_at FROM status_checks s JOIN (SELECT check_key, MAX(checked_at) AS m FROM status_checks GROUP BY check_key) x ON x.check_key = s.check_key AND x.m = s.checked_at")
    .all<{ check_key: string; ok: number; checked_at: string }>();
  const last = new Map(lastRows.map((r) => [r.check_key, r]));
  let written = 0;
  for (const c of STATUS_CHECKS) {
    const r = await runCheck(c.key, env, deps, last);
    if (!r) continue;
    const at = nowIso();
    await db.prepare("INSERT INTO status_checks (check_key, ok, latency_ms, detail, checked_at) VALUES (?, ?, ?, ?, ?)").bind(c.key, r.ok ? 1 : 0, r.latency ?? null, r.detail.slice(0, 300), at).run();
    written++;
    await maybeAlert(env, c, r, last.get(c.key)?.ok === 0);
  }
  await db.prepare("DELETE FROM status_checks WHERE checked_at < ?").bind(ago(RETENTION_DAYS * 86_400_000)).run();
  return written;
}

/** Alert on the second failure in a row (not on one blip) and on recovery; one email per change of state. */
async function maybeAlert(env: Env, c: CheckDef, r: Result, previousFailed: boolean) {
  const stateKey = `status_alert_${c.key}`;
  const state = (await getSetting(env.DB, stateKey)) ?? "up";
  let change: "down" | "up" | null = null;
  if (!r.ok && previousFailed && state !== "down") change = "down";
  if (r.ok && state === "down") change = "up";
  if (!change) return;
  await setSetting(env.DB, stateKey, change);
  // Active platform owners/admins/security (Control Center); the legacy flag only counts before the first claim.
  const { results: admins } = await env.DB.prepare(
    `SELECT u.email FROM users u JOIN platform_members m ON m.user_id = u.id WHERE m.status = 'active' AND m.role IN ('platform_owner','platform_admin','platform_security')
     UNION SELECT email FROM users WHERE is_platform_admin = 1 AND email_verified_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_members WHERE role = 'platform_owner' AND status = 'active')
     LIMIT 5`,
  ).all<{ email: string }>();
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  const subject = change === "down" ? `DNI Growth · Fallo: ${c.label}` : `DNI Growth · Resuelto: ${c.label}`;
  const text = change === "down" ? `La comprobación «${c.label}» ha fallado dos veces seguidas. ${r.detail}` : `La comprobación «${c.label}» vuelve a funcionar. ${r.detail}`;
  for (const a of admins) {
    await sendMail(
      env,
      { to: a.email, subject, html: emailHtml(subject, [text, "Puedes ver el detalle y el historial en la página de estado."], { label: "Ver /estado", url: `${origin}/estado` }), text: `${text}\n${origin}/estado` },
      { kind: "notification", idempotencyKey: `status:${c.key}:${change}:${nowIso().slice(0, 16)}:${a.email}` },
    ).catch((e) => log("warn", "status.alert_failed", { check: c.key, error: String(e).slice(0, 80) }));
  }
  log(change === "down" ? "warn" : "info", "status.alert", { check: c.key, change });
}

export interface CheckSummary extends CheckDef {
  ok: boolean | null;
  lastCheckedAt: string | null;
  detail: string | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime90d: number | null;
  days: Array<{ day: string; total: number; failed: number }>;
}

/** Public summary (no personal data): current state, uptime and one bar per day for 90 days. */
export async function statusSummary(db: D1Database): Promise<{ checks: CheckSummary[]; generatedAt: string; allOk: boolean }> {
  const since90 = ago(RETENTION_DAYS * 86_400_000);
  const [{ results: daily }, { results: latest }, { results: windows }] = await Promise.all([
    db
      .prepare("SELECT check_key, substr(checked_at, 1, 10) AS day, COUNT(*) AS total, SUM(ok = 0) AS failed FROM status_checks WHERE checked_at >= ? GROUP BY check_key, day")
      .bind(since90)
      .all<{ check_key: string; day: string; total: number; failed: number }>(),
    db
      .prepare("SELECT s.check_key, s.ok, s.detail, s.checked_at FROM status_checks s JOIN (SELECT check_key, MAX(checked_at) AS m FROM status_checks GROUP BY check_key) x ON x.check_key = s.check_key AND x.m = s.checked_at")
      .all<{ check_key: string; ok: number; detail: string | null; checked_at: string }>(),
    db
      .prepare(
        `SELECT check_key, SUM(checked_at >= ?1) AS t24, SUM(checked_at >= ?1 AND ok = 1) AS o24, SUM(checked_at >= ?2) AS t7, SUM(checked_at >= ?2 AND ok = 1) AS o7, COUNT(*) AS t90, SUM(ok = 1) AS o90
         FROM status_checks WHERE checked_at >= ?3 GROUP BY check_key`,
      )
      .bind(ago(86_400_000), ago(7 * 86_400_000), since90)
      .all<{ check_key: string; t24: number; o24: number; t7: number; o7: number; t90: number; o90: number }>(),
  ]);
  const pct = (ok: number, total: number) => (total > 0 ? Math.round((ok / total) * 10000) / 100 : null);
  const checks = STATUS_CHECKS.map((c) => {
    const l = latest.find((x) => x.check_key === c.key);
    const w = windows.find((x) => x.check_key === c.key);
    return {
      ...c,
      ok: l ? l.ok === 1 : null,
      lastCheckedAt: l?.checked_at ?? null,
      detail: l?.detail ?? null,
      uptime24h: w ? pct(w.o24, w.t24) : null,
      uptime7d: w ? pct(w.o7, w.t7) : null,
      uptime90d: w ? pct(w.o90, w.t90) : null,
      days: daily.filter((d) => d.check_key === c.key).map((d) => ({ day: d.day, total: d.total, failed: d.failed })),
    };
  });
  return { checks, generatedAt: nowIso(), allOk: checks.every((c) => c.ok !== false) };
}
