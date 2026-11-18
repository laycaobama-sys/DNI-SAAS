import { z } from "zod";
import type { Env } from "../env";
import { emailHtml, sendMail } from "./mail";
import { log, nowIso, parseJson, uuid } from "./util";

/**
 * F5 follow-up automations, per lead form. Only two safe kinds, both off by default and switched
 * on by someone with `forms:manage`:
 *  - auto_reply: one acknowledgement email to a NEW lead (they asked to be contacted), with quiet
 *    hours (queued until morning), a daily cap per organisation and the org's own reply-to address.
 *  - follow_up_task: a CRM task for the team, due N hours after the lead arrives.
 * Each run is logged once per lead (crm_automation_runs, unique) — never twice for the same lead.
 */

export const AUTO_REPLY_DAILY_CAP = 50;
export const TIMEZONE = "Europe/Madrid";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato HH:MM");
export const AutoReplyConfig = z.strictObject({
  subject: z.string().trim().min(3).max(120),
  body: z.string().trim().min(10).max(3000),
  replyTo: z.email("Email de respuesta no válido.").max(254),
  quietStart: hhmm.default("21:00"),
  quietEnd: hhmm.default("08:00"),
});
export const FollowUpConfig = z.strictObject({
  title: z.string().trim().min(3).max(200),
  dueHours: z.number().int().min(1).max(720).default(24),
  assignTo: z.string().uuid().nullable().optional(),
});
export type AutoReplyConfig = z.infer<typeof AutoReplyConfig>;
export type FollowUpConfig = z.infer<typeof FollowUpConfig>;

const minutesOf = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
function localMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}
export function inQuietHours(d: Date, start: string, end: string): boolean {
  const m = localMinutes(d);
  const s = minutesOf(start);
  const e = minutesOf(end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}
/** When the quiet window ends (local Madrid time), or null if now is outside it. */
export function nextSendTime(now: Date, start: string, end: string): Date | null {
  if (!inQuietHours(now, start, end)) return null;
  const delta = (minutesOf(end) - localMinutes(now) + 1440) % 1440 || 1440;
  let t = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + delta * 60_000);
  // Daylight-saving changes can shift the local clock by an hour: step forward until outside the window.
  for (let i = 0; i < 8 && inQuietHours(t, start, end); i++) t = new Date(t.getTime() + 15 * 60_000);
  return t;
}

/** «{nombre}» is the only placeholder; the lead's text is never interpreted. */
export const renderTemplate = (tpl: string, vars: { nombre: string }) => tpl.replace(/\{nombre\}/g, vars.nombre.split(" ")[0] ?? vars.nombre);

async function claimRun(env: Env, orgId: string, automationId: string, leadId: string, status: string, detail: string | null) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO crm_automation_runs (id, organization_id, automation_id, lead_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(uuid(), orgId, automationId, leadId, status, detail, nowIso())
    .run();
  return !!r.meta.changes;
}

export async function runLeadAutomations(env: Env, input: { orgId: string; orgName: string; formId: string; leadId: string; isNew: boolean; name: string; email: string }) {
  if (!input.isNew) return;
  const { results } = await env.DB.prepare("SELECT id, kind, config_json FROM crm_automations WHERE organization_id = ? AND form_id = ? AND enabled = 1")
    .bind(input.orgId, input.formId)
    .all<{ id: string; kind: "auto_reply" | "follow_up_task"; config_json: string }>();
  for (const a of results) {
    try {
      if (a.kind === "follow_up_task") {
        const cfg = FollowUpConfig.safeParse(parseJson(a.config_json, {}));
        if (!cfg.success) continue;
        if (!(await claimRun(env, input.orgId, a.id, input.leadId, "done", null))) continue;
        const due = new Date(Date.now() + cfg.data.dueHours * 3600_000).toISOString();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO crm_tasks (id, organization_id, lead_id, title, due_at, assigned_user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").bind(uuid(), input.orgId, input.leadId, cfg.data.title, due, cfg.data.assignTo ?? null, nowIso()),
          env.DB.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, data_json, created_at) VALUES (?, ?, ?, 'task_created', ?, ?)").bind(uuid(), input.orgId, input.leadId, JSON.stringify({ title: cfg.data.title, dueAt: due, automation: true }), nowIso()),
        ]);
      } else {
        const cfg = AutoReplyConfig.safeParse(parseJson(a.config_json, {}));
        if (!cfg.success) continue;
        const day = nowIso().slice(0, 10);
        const sent = await env.DB.prepare("SELECT COUNT(*) AS n FROM crm_automation_runs WHERE organization_id = ? AND automation_id = ? AND created_at >= ? AND status IN ('done','scheduled')")
          .bind(input.orgId, a.id, `${day}T00:00:00.000Z`)
          .first<{ n: number }>();
        if ((sent?.n ?? 0) >= AUTO_REPLY_DAILY_CAP) {
          await claimRun(env, input.orgId, a.id, input.leadId, "skipped", "daily_cap");
          continue;
        }
        const when = nextSendTime(new Date(), cfg.data.quietStart, cfg.data.quietEnd);
        if (!(await claimRun(env, input.orgId, a.id, input.leadId, when ? "scheduled" : "done", when ? `quiet_hours_until:${when.toISOString()}` : null))) continue;
        const subject = renderTemplate(cfg.data.subject, { nombre: input.name });
        const body = renderTemplate(cfg.data.body, { nombre: input.name });
        const footer = `Recibes este mensaje porque escribiste a ${input.orgName} a través de su formulario. Si no fuiste tú, ignóralo.`;
        await sendMail(
          env,
          { to: input.email, subject, text: `${body}\n\n—\n${footer}`, html: emailHtml(subject, [...body.split(/\n{2,}/), footer]), fromName: input.orgName.slice(0, 60), replyTo: cfg.data.replyTo },
          { kind: "notification", idempotencyKey: `auto-reply:${a.id}:${input.leadId}`, organizationId: input.orgId, notBefore: when?.toISOString() },
        );
        await env.DB.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, data_json, created_at) VALUES (?, ?, ?, 'auto_reply', ?, ?)")
          .bind(uuid(), input.orgId, input.leadId, JSON.stringify({ subject, scheduledFor: when?.toISOString() ?? null }), nowIso())
          .run();
      }
    } catch (e) {
      log("warn", "crm.automation_failed", { automationId: a.id, error: e instanceof Error ? e.message.slice(0, 80) : "error" });
      await claimRun(env, input.orgId, a.id, input.leadId, "failed", "error").catch(() => undefined);
    }
  }
}
