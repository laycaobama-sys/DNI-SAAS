import { createDohResolver } from "@dni/core";
import { createApp } from "./app";
import type { Deps, Env, JobMessage } from "./env";
import { processJobMessage } from "./jobs/consumer";
import { dispatchOutbox, recoverStuckJobs } from "./jobs/queue";
import { drainEmailOutbox } from "./lib/mail";
import { maybeSyncCatalog } from "./lib/openrouter";
import { log } from "./lib/util";

const deps: Deps = {
  fetchImpl: (...args) => fetch(...args),
  resolve: createDohResolver((...args) => fetch(...args)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const app = createApp(deps);

export default {
  fetch: app.fetch,

  /** Cloudflare Queues consumer: retries with backoff, DLQ configured in wrangler.jsonc. */
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    for (const msg of batch.messages) {
      try {
        const outcome = await processJobMessage(env, msg.body, deps);
        if (outcome.action === "retry") msg.retry({ delaySeconds: outcome.delaySeconds });
        else msg.ack();
      } catch (e) {
        log("error", "queue.message_failed", { jobId: msg.body?.jobId, error: String(e) });
        msg.retry({ delaySeconds: 60 });
      }
    }
  },

  /** Cron: drain the transactional outbox, recover stuck jobs, prune expired rate-limit windows. */
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    await recoverStuckJobs(env);
    await dispatchOutbox(env, deps, (p) => ctx.waitUntil(p));
    await drainEmailOutbox(env).catch((e) => log("error", "mail.drain_failed", { error: String(e) }));
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 86400).run();
    await maybeSyncCatalog(env, deps).catch((e) => log("error", "openrouter.cron_failed", { error: String(e).slice(0, 120) }));
    await env.DB.prepare("DELETE FROM ai_quota_counters WHERE updated_at < ?").bind(new Date(Date.now() - 3 * 86400_000).toISOString()).run();
  },
} satisfies ExportedHandler<Env, JobMessage>;
