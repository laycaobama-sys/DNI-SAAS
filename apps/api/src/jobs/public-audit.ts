import { buildPublicAuditResult, PUBLIC_AUDIT_PAGES, runSeoRules, UrlBlockedError } from "@dni/core";
import type { Deps, Env } from "../env";
import { log, nowIso } from "../lib/util";
import { crawlSite } from "./crawl";

/** Queue message of the free audit without an account (the other messages are organisation jobs). */
export interface PublicAuditMessage {
  kind: "public_audit";
  auditId: string;
}

export const isPublicAuditMessage = (m: unknown): m is PublicAuditMessage =>
  !!m && typeof m === "object" && (m as { kind?: unknown }).kind === "public_audit" && typeof (m as { auditId?: unknown }).auditId === "string";

export const PUBLIC_AUDIT_MAX_ATTEMPTS = 3;
/** A run that has not finished after this long is considered lost (isolate evicted) and may run again. */
const STALE_RUN_MS = 5 * 60_000;

/** Spanish message for each failure code shown on /auditoria/{id}. */
export const PUBLIC_AUDIT_ERRORS: Record<string, string> = {
  url_blocked: "Esa dirección no es una web pública que podamos revisar (por ejemplo, una red interna o una IP). Escribe el dominio de tu web, como tunegocio.es.",
  unreachable: "No hemos podido abrir la web: no responde, tarda demasiado o rechaza las visitas automáticas. Revisa la dirección e inténtalo de nuevo en unos minutos.",
  no_pages: "La web no permite que nuestro rastreador lea sus páginas (robots.txt) o no devuelve páginas HTML, así que no hay nada que revisar.",
  timeout: "La revisión tardó demasiado y se detuvo. Inténtalo de nuevo en unos minutos.",
};

/**
 * Runs one free audit: claim (queued → running) so a duplicate delivery never runs it twice, crawl at most
 * PUBLIC_AUDIT_PAGES pages, apply the same deterministic rules as the full analysis and store the result.
 * No AI and no credits are used. Failures are stored with a code, never with the raw error text.
 */
export async function processPublicAudit(env: Env, deps: Deps, auditId: string): Promise<void> {
  const db = env.DB;
  const now = nowIso();
  const staleBefore = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const row = await db
    .prepare(
      `UPDATE public_audits SET status = 'running', attempts = attempts + 1, started_at = ?
       WHERE id = ? AND attempts < ? AND (status = 'queued' OR (status = 'running' AND started_at < ?)) RETURNING url`,
    )
    .bind(now, auditId, PUBLIC_AUDIT_MAX_ATTEMPTS, staleBefore)
    .first<{ url: string }>();
  if (!row) return;

  const noop = async () => {};
  try {
    const { site, skipped } = await crawlSite(
      deps,
      row.url,
      PUBLIC_AUDIT_PAGES,
      {
        event: async (level, kind) => {
          if (level !== "info") log("warn", "public_audit.crawl_event", { auditId, kind });
        },
        progress: noop,
        checkpoint: noop,
      },
      { timeoutMs: 8000 },
    );
    if (!site.pages.length) {
      await fail(db, auditId, skipped.some((s) => s.reason === "robots_disallow") ? "no_pages" : "unreachable");
      return;
    }
    const result = buildPublicAuditResult(runSeoRules(site), { origin: site.origin, pagesAnalyzed: site.pages.length, observedAt: nowIso() });
    await db
      .prepare("UPDATE public_audits SET status = 'completed', result_json = ?, error_code = NULL, finished_at = ? WHERE id = ? AND status = 'running'")
      .bind(JSON.stringify(result), nowIso(), auditId)
      .run();
  } catch (e) {
    const code = e instanceof UrlBlockedError ? "url_blocked" : "unreachable";
    log("warn", "public_audit.failed", { auditId, code, error: e instanceof Error ? e.name : "error" });
    await fail(db, auditId, code);
  }
}

async function fail(db: D1Database, id: string, code: string) {
  await db.prepare("UPDATE public_audits SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ? AND status = 'running'").bind(code, nowIso(), id).run();
}

/** Starts a free audit: on the queue when there is one, otherwise in the background of this request. */
export async function enqueuePublicAudit(env: Env, deps: Deps, auditId: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  if (env.JOBS_QUEUE) {
    try {
      await env.JOBS_QUEUE.send({ kind: "public_audit", auditId }, { contentType: "json" });
      return;
    } catch (e) {
      log("error", "public_audit.enqueue_failed", { auditId, error: String(e).slice(0, 120) });
    }
  }
  waitUntil(processPublicAudit(env, deps, auditId).catch((e) => log("error", "public_audit.inline_failed", { auditId, error: String(e).slice(0, 120) })));
}

/**
 * Cron: re-sends audits whose message was lost (queued for more than 2 minutes, or a run that vanished),
 * fails those that used every attempt, and deletes anonymous audits after 30 days.
 */
export async function publicAuditMaintenance(env: Env, deps: Deps, waitUntil: (p: Promise<unknown>) => void): Promise<{ resent: number; timedOut: number; purged: number }> {
  const db = env.DB;
  const now = nowIso();
  const queuedBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  const staleBefore = new Date(Date.now() - STALE_RUN_MS).toISOString();
  const timedOut = await db
    .prepare("UPDATE public_audits SET status = 'failed', error_code = 'timeout', finished_at = ? WHERE attempts >= ? AND ((status = 'running' AND started_at < ?) OR status = 'queued')")
    .bind(now, PUBLIC_AUDIT_MAX_ATTEMPTS, staleBefore)
    .run();
  const { results } = await db
    .prepare(
      `SELECT id FROM public_audits WHERE attempts < ? AND ((status = 'queued' AND created_at < ?) OR (status = 'running' AND started_at < ?))
       ORDER BY created_at LIMIT 10`,
    )
    .bind(PUBLIC_AUDIT_MAX_ATTEMPTS, queuedBefore, staleBefore)
    .all<{ id: string }>();
  for (const r of results) await enqueuePublicAudit(env, deps, r.id, waitUntil);
  const purged = await db.prepare("DELETE FROM public_audits WHERE claimed_org_id IS NULL AND expires_at < ?").bind(now).run();
  return { resent: results.length, timedOut: timedOut.meta.changes ?? 0, purged: purged.meta.changes ?? 0 };
}
