import type { Deps, Env, JobMessage } from "../env";
import { log, nowIso } from "../lib/util";
import { processJobMessage } from "./consumer";

/**
 * Outbox dispatcher. Business state + outbox row are committed atomically by the caller;
 * this function forwards pending rows to Cloudflare Queues (or, when no queue binding exists,
 * runs the job in the background with waitUntil — local/dev fallback, still idempotent).
 * The cron trigger calls drainOutbox() so nothing is lost if dispatch fails after commit.
 */
export async function dispatchOutbox(env: Env, deps: Deps, waitUntil: (p: Promise<unknown>) => void, outboxIds?: string[]) {
  const rows = outboxIds?.length
    ? (
        await env.DB.prepare(
          `SELECT id, organization_id, payload_json FROM outbox_events WHERE status = 'pending' AND id IN (${outboxIds.map(() => "?").join(",")})`,
        )
          .bind(...outboxIds)
          .all<{ id: string; organization_id: string; payload_json: string }>()
      ).results
    : (
        await env.DB.prepare("SELECT id, organization_id, payload_json FROM outbox_events WHERE status = 'pending' AND available_at <= ? ORDER BY created_at LIMIT 50")
          .bind(nowIso())
          .all<{ id: string; organization_id: string; payload_json: string }>()
      ).results;

  for (const row of rows) {
    const msg = JSON.parse(row.payload_json) as JobMessage;
    try {
      // Claim the outbox row first so concurrent drains never double-dispatch.
      const claimed = await env.DB.prepare("UPDATE outbox_events SET status = 'dispatched', dispatched_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'")
        .bind(nowIso(), row.id)
        .run();
      if (!claimed.meta.changes) continue;
      if (env.JOBS_QUEUE) {
        await env.JOBS_QUEUE.send(msg, { contentType: "json" });
      } else {
        waitUntil(processJobMessage(env, msg, deps).catch((e) => log("error", "job.inline_failed", { jobId: msg.jobId, error: String(e) })));
      }
    } catch (e) {
      log("error", "outbox.dispatch_failed", { outboxId: row.id, error: String(e) });
      await env.DB.prepare("UPDATE outbox_events SET status = 'pending', available_at = ? WHERE id = ?")
        .bind(new Date(Date.now() + 30_000).toISOString(), row.id)
        .run();
    }
  }
  return rows.length;
}

/** Re-queues jobs whose worker vanished (e.g. isolate eviction) — "running" with no progress for 20 min. */
export async function recoverStuckJobs(env: Env) {
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  const { results } = await env.DB.prepare("SELECT id, organization_id, attempts, max_attempts FROM jobs WHERE state = 'running' AND started_at < ?")
    .bind(cutoff)
    .all<{ id: string; organization_id: string; attempts: number; max_attempts: number }>();
  for (const j of results) {
    const exhausted = j.attempts >= j.max_attempts;
    await env.DB.prepare(
      exhausted
        ? "UPDATE jobs SET state = 'failed', failure_code = 'timeout', last_error = 'worker_timeout', dead_lettered_at = ?, finished_at = ? WHERE organization_id = ? AND id = ? AND state = 'running'"
        : "UPDATE jobs SET state = 'queued', last_error = 'worker_timeout', retry_after = ?, started_at = ? WHERE organization_id = ? AND id = ? AND state = 'running'",
    )
      .bind(nowIso(), nowIso(), j.organization_id, j.id)
      .run();
    if (!exhausted) {
      await env.DB.prepare("INSERT OR IGNORE INTO outbox_events (id, organization_id, topic, payload_json, dedupe_key) VALUES (?, ?, 'jobs', ?, ?)")
        .bind(crypto.randomUUID(), j.organization_id, JSON.stringify({ jobId: j.id, organizationId: j.organization_id, outboxId: "recovery" }), `recover:${j.id}:${j.attempts}`)
        .run();
    }
  }
}
