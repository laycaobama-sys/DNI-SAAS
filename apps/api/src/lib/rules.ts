import {
  assertResolvesPublic,
  AutomationAction,
  AutomationCondition,
  decryptJson,
  encryptJson,
  LEAD_STAGE_LABEL,
  matchesConditions,
  signWebhook,
  validatePublicUrl,
  type AutomationSubject,
} from "@dni/core";
import { z } from "zod";
import type { Deps, Env } from "../env";
import { emailHtml, encKey, sendMail } from "./mail";
import { log, nowIso, parseJson, uuid } from "./util";

/**
 * F5 automation engine. A rule = trigger + conditions + actions. Each (rule, trigger_ref) runs at
 * most once (UNIQUE in automation_runs), so retries and duplicate events never double-act.
 * Actions never send personal data by email or webhook: only ids, stage, UTM, value and a link.
 * A `set_stage` action does NOT fire stage_changed rules again (no loops).
 */
export type Trigger = "lead_created" | "stage_changed" | "task_overdue";
type RuleRow = { id: string; organization_id: string; name: string; trigger: Trigger; conditions_json: string; actions_json: string; webhook_secret_enc: string | null };
type LeadRow = { id: string; form_id: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; stage: string; value_cents: number | null; consent_marketing: number; landing_id: string | null; is_test: number };

export const WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
const secretAad = (orgId: string, ruleId: string) => `webhook-secret:${orgId}:${ruleId}`;

export async function newWebhookSecret(env: Env, orgId: string, ruleId: string): Promise<{ secret: string; enc: string }> {
  const key = encKey(env);
  if (!key) throw new Error("data_key_missing");
  const secret = "whsec_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { secret, enc: await encryptJson(key, { s: secret }, secretAad(orgId, ruleId)) };
}

async function loadLead(env: Env, orgId: string, leadId: string) {
  return env.DB.prepare("SELECT id, form_id, utm_source, utm_medium, utm_campaign, stage, value_cents, consent_marketing, landing_id, is_test FROM leads WHERE organization_id = ? AND id = ?").bind(orgId, leadId).first<LeadRow>();
}

const subjectOf = (l: LeadRow): AutomationSubject => ({ formId: l.form_id, utmSource: l.utm_source, stage: l.stage, valueEur: l.value_cents === null ? null : l.value_cents / 100, consentMarketing: !!l.consent_marketing });

export function parseRule(r: Pick<RuleRow, "conditions_json" | "actions_json">) {
  const conditions = z.array(AutomationCondition).safeParse(parseJson(r.conditions_json, []));
  const actions = z.array(AutomationAction).safeParse(parseJson(r.actions_json, []));
  return { conditions: conditions.success ? conditions.data : null, actions: actions.success ? actions.data : null };
}

/** What a rule WOULD do for a lead, without side effects. */
export function describeActions(actions: AutomationAction[]): string[] {
  return actions.map((a) => {
    switch (a.type) {
      case "create_task":
        return `Crear la tarea «${a.title}» con vencimiento en ${a.dueHours} h`;
      case "set_stage":
        return `Mover el contacto a la etapa «${LEAD_STAGE_LABEL[a.stage]}»`;
      case "assign":
        return "Asignar el contacto a una persona del equipo";
      case "notify_team":
        return "Avisar por correo al equipo (sin datos personales)";
      case "webhook":
        return `Enviar un aviso firmado a ${new URL(a.url).host}`;
    }
  });
}

async function teamEmails(env: Env, orgId: string) {
  const { results } = await env.DB.prepare(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND m.status = 'active' AND m.role IN ('owner','admin','marketing_manager') AND u.email_verified_at IS NOT NULL LIMIT 5`,
  )
    .bind(orgId)
    .all<{ email: string }>();
  return results.map((r) => r.email);
}

async function isActiveMember(env: Env, orgId: string, userId: string) {
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, userId).first());
}

async function runActions(env: Env, rule: RuleRow, actions: AutomationAction[], lead: LeadRow, triggerRef: string, trigger: Trigger) {
  const done: string[] = [];
  const failed: string[] = [];
  const now = nowIso();
  for (const a of actions) {
    try {
      switch (a.type) {
        case "create_task": {
          if (a.assignTo && !(await isActiveMember(env, rule.organization_id, a.assignTo))) throw new Error("assignee_not_member");
          const due = new Date(Date.now() + a.dueHours * 3600_000).toISOString();
          await env.DB.batch([
            env.DB.prepare("INSERT INTO crm_tasks (id, organization_id, lead_id, title, due_at, assigned_user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").bind(uuid(), rule.organization_id, lead.id, a.title, due, a.assignTo ?? null, now),
            env.DB.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, data_json, created_at) VALUES (?, ?, ?, 'task_created', ?, ?)").bind(uuid(), rule.organization_id, lead.id, JSON.stringify({ title: a.title, dueAt: due, automation: true, rule: rule.name }), now),
          ]);
          break;
        }
        case "set_stage": {
          if (lead.stage === a.stage) break;
          await env.DB.batch([
            env.DB.prepare("UPDATE leads SET stage = ?, stage_changed_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(a.stage, now, now, rule.organization_id, lead.id),
            env.DB.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, data_json, created_at) VALUES (?, ?, ?, 'stage_changed', ?, ?)").bind(uuid(), rule.organization_id, lead.id, JSON.stringify({ from: lead.stage, to: a.stage, automation: true, rule: rule.name }), now),
          ]);
          lead.stage = a.stage;
          break;
        }
        case "assign": {
          if (!(await isActiveMember(env, rule.organization_id, a.userId))) throw new Error("assignee_not_member");
          await env.DB.batch([
            env.DB.prepare("UPDATE leads SET assigned_user_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(a.userId, now, rule.organization_id, lead.id),
            env.DB.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, data_json, created_at) VALUES (?, ?, ?, 'assigned', ?, ?)").bind(uuid(), rule.organization_id, lead.id, JSON.stringify({ automation: true, rule: rule.name }), now),
          ]);
          break;
        }
        case "notify_team": {
          const url = `${env.APP_ORIGIN}/app/o/${rule.organization_id}/crm?lead=${lead.id}`;
          for (const to of await teamEmails(env, rule.organization_id)) {
            await sendMail(
              env,
              { to, subject: `Automatización «${rule.name}»`, text: `${a.message}\n\nAbrir en el CRM:\n${url}\n\nPor privacidad, este correo no incluye los datos de la persona.`, html: emailHtml(`Automatización «${rule.name}»`, [a.message, "Por privacidad, este correo no incluye los datos de la persona."], { label: "Abrir en el CRM", url }) },
              { kind: "notification", idempotencyKey: `rule-notify:${rule.id}:${triggerRef}:${to}`, organizationId: rule.organization_id },
            );
          }
          break;
        }
        case "webhook": {
          const eventId = `${rule.id}:${triggerRef}`;
          const payload = {
            id: eventId,
            type: trigger,
            created: now,
            organization_id: rule.organization_id,
            rule: { id: rule.id, name: rule.name },
            lead: { id: lead.id, stage: lead.stage, value_eur: lead.value_cents === null ? null : lead.value_cents / 100, form_id: lead.form_id, landing_id: lead.landing_id, utm: { source: lead.utm_source, medium: lead.utm_medium, campaign: lead.utm_campaign }, test: !!lead.is_test },
            note: "Sin datos personales. Consulta el contacto en DNI Growth.",
          };
          await env.DB.prepare(
            "INSERT OR IGNORE INTO webhook_deliveries (id, organization_id, rule_id, url, event_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)",
          )
            .bind(uuid(), rule.organization_id, rule.id, a.url, eventId, JSON.stringify(payload), now, now, now)
            .run();
          break;
        }
      }
      done.push(a.type);
    } catch (e) {
      failed.push(`${a.type}:${e instanceof Error ? e.message.slice(0, 40) : "error"}`);
    }
  }
  return { done, failed };
}

/** Runs every enabled rule of `trigger` for a lead. Never throws (the caller's request must not fail). */
export async function runRules(env: Env, input: { orgId: string; trigger: Trigger; leadId: string; triggerRef: string }) {
  try {
    const { results } = await env.DB.prepare("SELECT id, organization_id, name, trigger, conditions_json, actions_json, webhook_secret_enc FROM automation_rules WHERE organization_id = ? AND trigger = ? AND enabled = 1 LIMIT 50")
      .bind(input.orgId, input.trigger)
      .all<RuleRow>();
    if (!results.length) return;
    const lead = await loadLead(env, input.orgId, input.leadId);
    if (!lead) return;
    for (const rule of results) {
      const { conditions, actions } = parseRule(rule);
      if (!conditions || !actions) continue;
      if (!matchesConditions(conditions, subjectOf(lead))) continue;
      const runId = uuid();
      const claim = await env.DB.prepare("INSERT OR IGNORE INTO automation_runs (id, organization_id, rule_id, trigger_ref, status, detail_json, created_at) VALUES (?, ?, ?, ?, 'done', '{}', ?)")
        .bind(runId, input.orgId, rule.id, input.triggerRef, nowIso())
        .run();
      if (!claim.meta.changes) continue; // already ran for this event
      const r = await runActions(env, rule, actions, lead, input.triggerRef, input.trigger);
      const status = !r.failed.length ? "done" : r.done.length ? "partial" : "failed";
      await env.DB.prepare("UPDATE automation_runs SET status = ?, detail_json = ? WHERE organization_id = ? AND id = ?").bind(status, JSON.stringify({ leadId: lead.id, done: r.done, failed: r.failed }), input.orgId, runId).run();
    }
  } catch (e) {
    log("warn", "rules.run_failed", { trigger: input.trigger, error: e instanceof Error ? e.message.slice(0, 80) : "error" });
  }
}

/** Dry-run: evaluates conditions against a real lead and records a `dry_run` log; no actions run. */
export async function dryRun(env: Env, orgId: string, rule: RuleRow, leadId: string) {
  const lead = await loadLead(env, orgId, leadId);
  if (!lead) return null;
  const { conditions, actions } = parseRule(rule);
  const matches = !!conditions && matchesConditions(conditions, subjectOf(lead));
  const wouldDo = matches && actions ? describeActions(actions) : [];
  await env.DB.prepare("INSERT INTO automation_runs (id, organization_id, rule_id, trigger_ref, status, detail_json, created_at) VALUES (?, ?, ?, ?, 'dry_run', ?, ?)")
    .bind(uuid(), orgId, rule.id, `dry:${uuid()}`, JSON.stringify({ leadId, matches, wouldDo }), nowIso())
    .run();
  return { matches, wouldDo };
}

/** Cron: tasks past due (once each) fire `task_overdue`. Bounded per tick. */
export async function scanOverdueTasks(env: Env, now = new Date()) {
  const { results } = await env.DB.prepare(
    "SELECT id, organization_id, lead_id FROM crm_tasks WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? AND overdue_notified_at IS NULL ORDER BY due_at LIMIT 50",
  )
    .bind(now.toISOString())
    .all<{ id: string; organization_id: string; lead_id: string }>();
  for (const t of results) {
    const r = await env.DB.prepare("UPDATE crm_tasks SET overdue_notified_at = ? WHERE organization_id = ? AND id = ? AND overdue_notified_at IS NULL").bind(nowIso(now), t.organization_id, t.id).run();
    if (!r.meta.changes) continue;
    await runRules(env, { orgId: t.organization_id, trigger: "task_overdue", leadId: t.lead_id, triggerRef: `task:${t.id}` });
  }
  return results.length;
}

/** Cron: signed webhook delivery with SSRF checks, no redirects, backoff and a dead-letter state. */
export async function deliverWebhooks(env: Env, deps: Pick<Deps, "fetchImpl" | "resolve">, now = new Date()) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.organization_id, d.url, d.payload_json, d.attempts, r.webhook_secret_enc, r.id AS rule_id
     FROM webhook_deliveries d LEFT JOIN automation_rules r ON r.organization_id = d.organization_id AND r.id = d.rule_id
     WHERE d.status IN ('queued','failed') AND d.next_attempt_at <= ? ORDER BY d.next_attempt_at LIMIT 20`,
  )
    .bind(now.toISOString())
    .all<{ id: string; organization_id: string; url: string; payload_json: string; attempts: number; webhook_secret_enc: string | null; rule_id: string | null }>();
  const key = encKey(env);
  for (const d of results) {
    const attempts = d.attempts + 1;
    let status = 0;
    let error: string | null = null;
    try {
      if (!d.rule_id || !d.webhook_secret_enc || !key) throw new Error("rule_or_secret_missing");
      const { s } = await decryptJson<{ s: string }>(key, d.webhook_secret_enc, secretAad(d.organization_id, d.rule_id));
      const url = validatePublicUrl(d.url);
      if (url.protocol !== "https:") throw new Error("https_required");
      await assertResolvesPublic(url, deps.resolve);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await deps.fetchImpl(url.toString(), {
          method: "POST",
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "content-type": "application/json", "user-agent": "DNIGrowth-Webhooks/1.0", "x-dni-signature": await signWebhook(s, d.payload_json), "x-dni-event-id": JSON.parse(d.payload_json).id },
          body: d.payload_json,
        });
        status = res.status;
        await res.body?.cancel().catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
      if (status < 200 || status >= 300) error = `http_${status}`;
    } catch (e) {
      error = e instanceof Error ? (e.name === "UrlBlockedError" ? "blocked_url" : e.message.slice(0, 60)) : "error";
    }
    const permanent = error === "blocked_url" || error === "https_required" || error === "rule_or_secret_missing";
    const next = !error ? null : permanent || attempts > WEBHOOK_BACKOFF_SECONDS.length ? null : new Date(now.getTime() + WEBHOOK_BACKOFF_SECONDS[attempts - 1]! * 1000).toISOString();
    const newStatus = !error ? "delivered" : next ? "failed" : "dead";
    await env.DB.prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
      .bind(newStatus, attempts, status || null, error, next ?? now.toISOString(), nowIso(), d.organization_id, d.id)
      .run();
  }
  return results.length;
}
