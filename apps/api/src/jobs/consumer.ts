import { redact, UrlBlockedError } from "@dni/core";
import type { Deps, Env, JobMessage } from "../env";
import { ledgerStmt } from "../lib/billing";
import { addSeconds, log, nowIso, parseJson, uuid } from "../lib/util";
import { runSiteAnalysis } from "./analyze";
import { runGa4Sync } from "./ga4";
import { runGscSync } from "./gsc";

export interface JobRow {
  id: string;
  organization_id: string;
  brand_id: string | null;
  kind: string;
  state: string;
  input_json: string;
  attempts: number;
  max_attempts: number;
  cost_estimate: number;
  actor_user_id: string | null;
}

export class PermanentJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class JobCancelledError extends Error {}

export interface JobContext {
  env: Env;
  deps: Deps;
  job: JobRow;
  event(level: "info" | "warn" | "error", kind: string, message: string, data?: Record<string, unknown>): Promise<void>;
  progress(pct: number): Promise<void>;
  /** Throws JobCancelledError if a user requested cancellation. */
  checkpoint(): Promise<void>;
}

export type ProcessOutcome = { action: "ack" } | { action: "retry"; delaySeconds: number };

const backoffSeconds = (attempt: number) => Math.min(600, 15 * 2 ** (attempt - 1));

/**
 * Idempotent job processor. The atomic claim (queued → running) guarantees that duplicate queue
 * deliveries never execute the same job twice in parallel.
 */
export async function processJobMessage(env: Env, msg: JobMessage, deps: Deps): Promise<ProcessOutcome> {
  const db = env.DB;
  const job = await db
    .prepare(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, started_at = ?, retry_after = NULL
       WHERE organization_id = ? AND id = ? AND state = 'queued' AND cancel_requested_at IS NULL RETURNING *`,
    )
    .bind(nowIso(), msg.organizationId, msg.jobId)
    .first<JobRow>();
  if (!job) {
    // Already running/finished/cancelled (duplicate delivery) or cancelled before start.
    await db
      .prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE organization_id = ? AND id = ? AND state = 'queued' AND cancel_requested_at IS NOT NULL")
      .bind(nowIso(), msg.organizationId, msg.jobId)
      .run();
    return { action: "ack" };
  }

  const ctx: JobContext = {
    env,
    deps,
    job,
    async event(level, kind, message, data = {}) {
      await db
        .prepare("INSERT INTO job_events (id, organization_id, job_id, level, kind, message, data_redacted_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(uuid(), job.organization_id, job.id, level, kind, message, JSON.stringify(redact(data)))
        .run();
    },
    async progress(pct) {
      await db.prepare("UPDATE jobs SET progress = ? WHERE organization_id = ? AND id = ?").bind(Math.max(0, Math.min(100, Math.round(pct))), job.organization_id, job.id).run();
    },
    async checkpoint() {
      const r = await db.prepare("SELECT cancel_requested_at FROM jobs WHERE organization_id = ? AND id = ?").bind(job.organization_id, job.id).first<{ cancel_requested_at: string | null }>();
      if (r?.cancel_requested_at) throw new JobCancelledError("cancelled");
    },
  };

  try {
    await ctx.event("info", "started", `Intento ${job.attempts} de ${job.max_attempts}`);
    let output: { creditsUsed: number; [k: string]: unknown };
    switch (job.kind) {
      case "site_analysis":
        output = await runSiteAnalysis(ctx, parseJson(job.input_json, {} as { url: string; brandId: string; siteId: string }));
        break;
      case "gsc_sync":
        output = await runGscSync(ctx, parseJson(job.input_json, {} as { propertyId: string }));
        break;
      case "ga4_sync":
        output = await runGa4Sync(ctx, parseJson(job.input_json, {} as { propertyId: string }));
        break;
      default:
        throw new PermanentJobError("unknown_job_kind", `Tipo de trabajo desconocido: ${job.kind}`);
    }
    await db.batch([
      db
        .prepare("UPDATE jobs SET state = 'completed', progress = 100, output_json = ?, cost_actual = ?, finished_at = ? WHERE organization_id = ? AND id = ?")
        .bind(JSON.stringify(output), output.creditsUsed, nowIso(), job.organization_id, job.id),
      // Free jobs (nothing reserved, nothing used) leave no zero-value ledger rows.
      ...(job.cost_estimate === 0 && output.creditsUsed === 0
        ? []
        : [
            ledgerStmt(db, { orgId: job.organization_id, jobId: job.id, kind: "release", amount: job.cost_estimate, category: job.kind }),
            ledgerStmt(db, { orgId: job.organization_id, jobId: job.id, kind: "settle", amount: -output.creditsUsed, category: job.kind }),
          ]),
    ]);
    await ctx.event("info", "completed", "Trabajo completado");
    return { action: "ack" };
  } catch (err) {
    const cancelled = err instanceof JobCancelledError;
    const permanent = cancelled || err instanceof PermanentJobError || err instanceof UrlBlockedError;
    const code = cancelled ? "cancelled" : err instanceof PermanentJobError ? err.code : err instanceof UrlBlockedError ? `url_blocked:${err.reason}` : "transient_error";
    const message = err instanceof Error ? err.message : String(err);
    log(permanent ? "warn" : "error", "job.failed_attempt", { jobId: job.id, code, attempt: job.attempts });
    if (!permanent && job.attempts < job.max_attempts) {
      const delay = backoffSeconds(job.attempts);
      await db
        .prepare("UPDATE jobs SET state = 'queued', last_error = ?, retry_after = ? WHERE organization_id = ? AND id = ?")
        .bind(message.slice(0, 500), addSeconds(delay), job.organization_id, job.id)
        .run();
      await ctx.event("warn", "retry_scheduled", `Error transitorio; reintento en ${delay}s`, { error: message.slice(0, 300) });
      return { action: "retry", delaySeconds: delay };
    }
    await db.batch([
      db
        .prepare(
          `UPDATE jobs SET state = ?, failure_code = ?, last_error = ?, finished_at = ?, dead_lettered_at = ? WHERE organization_id = ? AND id = ?`,
        )
        .bind(cancelled ? "cancelled" : "failed", code, message.slice(0, 500), nowIso(), permanent ? null : nowIso(), job.organization_id, job.id),
      // Failed/cancelled before consuming: release the reservation (no charge).
      ...(job.cost_estimate === 0 ? [] : [ledgerStmt(db, { orgId: job.organization_id, jobId: job.id, kind: "release", amount: job.cost_estimate, category: job.kind })]),
      db
        .prepare("UPDATE web_crawls SET status = ?, completed_at = ? WHERE organization_id = ? AND job_id = ? AND status = 'running'")
        .bind(cancelled ? "cancelled" : "failed", nowIso(), job.organization_id, job.id),
    ]);
    await ctx.event(cancelled ? "warn" : "error", cancelled ? "cancelled" : "failed", cancelled ? "Cancelado por el usuario" : message.slice(0, 300), { code });
    return { action: "ack" };
  }
}
