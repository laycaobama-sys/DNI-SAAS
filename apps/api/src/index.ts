import { createDohResolver } from "@dni/core";
import { createApp } from "./app";
import type { Deps, Env, JobMessage, QueueMessage } from "./env";
import { processJobMessage } from "./jobs/consumer";
import { isPublicAuditMessage, processPublicAudit, publicAuditMaintenance } from "./jobs/public-audit";
import { sendLifecycleEmails } from "./lib/lifecycle";
import { dispatchOutbox, recoverStuckJobs } from "./jobs/queue";
import { scheduleGa4Syncs } from "./lib/ga4";
import { scheduleGscSyncs } from "./lib/gsc";
import { drainEmailOutbox } from "./lib/mail";
import { maybeSyncCatalog } from "./lib/openrouter";
import { purgeProductEvents } from "./lib/product-events";
import { maybeAutoSyncStripe } from "./lib/stripe";
import { billingMaintenance, reconcileStripe } from "./routes/billing";
import { deliverWebhooks, scanOverdueTasks } from "./lib/rules";
import { log } from "./lib/util";
import { dailyBackup } from "./lib/backup";
import { runStatusChecks } from "./lib/status";
import { publishDueSocialPosts } from "./lib/social-publish";
import { guideMaintenance } from "./routes/guide";

const deps: Deps = {
  fetchImpl: (...args) => fetch(...args),
  resolve: createDohResolver((...args) => fetch(...args)),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const app = createApp(deps);

export default {
  fetch: app.fetch,

  /** Cloudflare Queues consumer: retries with backoff, DLQ configured in wrangler.jsonc. */
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      try {
        if (isPublicAuditMessage(msg.body)) {
          // Free audit without an account: idempotent claim inside; failures are stored on the row.
          await processPublicAudit(env, deps, msg.body.auditId);
          msg.ack();
          continue;
        }
        const outcome = await processJobMessage(env, msg.body as JobMessage, deps);
        if (outcome.action === "retry") msg.retry({ delaySeconds: outcome.delaySeconds });
        else msg.ack();
      } catch (e) {
        log("error", "queue.message_failed", { jobId: (msg.body as Partial<JobMessage> | undefined)?.jobId, error: String(e) });
        msg.retry({ delaySeconds: 60 });
      }
    }
  },

  /** Cron: drain the transactional outbox, recover stuck jobs, prune expired rate-limit windows. */
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    await recoverStuckJobs(env);
    await scheduleGscSyncs(env).catch((e) => log("error", "gsc.schedule_failed", { error: String(e).slice(0, 120) }));
    await scheduleGa4Syncs(env).catch((e) => log("error", "ga4.schedule_failed", { error: String(e).slice(0, 120) }));
    await dispatchOutbox(env, deps, (p) => ctx.waitUntil(p));
    await drainEmailOutbox(env).catch((e) => log("error", "mail.drain_failed", { error: String(e) }));
    await scanOverdueTasks(env).catch((e) => log("error", "rules.overdue_failed", { error: String(e).slice(0, 120) }));
    await deliverWebhooks(env, deps).catch((e) => log("error", "webhooks.deliver_failed", { error: String(e).slice(0, 120) }));
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(Math.floor(Date.now() / 1000) - 86400).run();
    await maybeSyncCatalog(env, deps).catch((e) => log("error", "openrouter.cron_failed", { error: String(e).slice(0, 120) }));
    // Stripe: catalogue/portal/webhook created automatically once a key exists; grace periods and trial reminders.
    await maybeAutoSyncStripe(env, deps, env.APP_ORIGIN).catch((e) => log("error", "stripe.autosync_cron_failed", { error: String(e).slice(0, 120) }));
    await billingMaintenance(env).catch((e) => log("error", "billing.maintenance_failed", { error: String(e).slice(0, 120) }));
    await reconcileStripe(env, deps).catch((e) => log("error", "billing.reconcile_failed", { error: String(e).slice(0, 120) }));
    await env.DB.prepare("DELETE FROM ai_quota_counters WHERE updated_at < ?").bind(new Date(Date.now() - 3 * 86400_000).toISOString()).run();
    // Expiry sweep of the AI response cache (all tenants by design: rows are only deleted, never read).
    await env.DB.prepare("DELETE FROM ai_response_cache WHERE expires_at < ?").bind(new Date().toISOString()).run();
    // Free audits without an account: lost messages re-sent, anonymous rows deleted after 30 days.
    await publicAuditMaintenance(env, deps, (p) => ctx.waitUntil(p)).catch((e) => log("error", "public_audit.maintenance_failed", { error: String(e).slice(0, 120) }));
    // Guide signups never confirmed are deleted after 7 days.
    await guideMaintenance(env).catch((e) => log("error", "guide.maintenance_failed", { error: String(e).slice(0, 120) }));
    // Help emails 24 h and 72 h after signup (once each, never to users who opted out).
    await sendLifecycleEmails(env).catch((e) => log("error", "lifecycle.cron_failed", { error: String(e).slice(0, 120) }));
    // Retention of the cookieless product analytics (13 months).
    await purgeProductEvents(env.DB).catch((e) => log("error", "product_events.purge_failed", { error: String(e).slice(0, 120) }));
    // Facebook / Instagram: approved posts whose time has come (never twice; see lib/social-publish.ts).
    await publishDueSocialPosts(env, deps).catch((e) => log("error", "social.cron_failed", { error: String(e).slice(0, 120) }));
    // Daily D1 backup to R2 (30 days) and the /estado checks (every 5 minutes, alerts after two failures).
    await dailyBackup(env).catch((e) => log("error", "backup.failed", { error: String(e).slice(0, 120) }));
    await runStatusChecks(env, deps).catch((e) => log("error", "status.checks_failed", { error: String(e).slice(0, 120) }));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
