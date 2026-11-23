import { hmacSha256Hex, timingSafeEqual } from "@dni/core";
import type { Env } from "../env";
import { activationFor } from "./activation";
import { emailHtml, sendMail } from "./mail";
import { log, nowIso } from "./util";

/**
 * Help emails after signup (Phase 2): one at 24 h and one at 72 h, each at most once per user, only while
 * there is a set-up step left, never to users who opted out, and never to accounts created before this
 * feature went live (platform setting «lifecycle_emails_since», written on the first run). They go through
 * the normal email outbox (monthly cap, retries, encrypted payload). No personal data is logged.
 */
export const LIFECYCLE_KINDS = [
  { kind: "onboarding_24h", hours: 24 },
  { kind: "onboarding_72h", hours: 72 },
] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number]["kind"];

/** A help email that is more than this late (e.g. the cron was down) is not sent any more. */
const MAX_LATE_HOURS = 48;
const BATCH = 10;
const SINCE_KEY = "lifecycle_emails_since";

function unsubscribeKey(env: Env): string {
  return `lifecycle-unsubscribe:${env.DATA_ENC_KEY ?? env.IP_HASH_SALT ?? "dev-only-key"}`;
}

export async function unsubscribeToken(env: Env, userId: string): Promise<string> {
  return (await hmacSha256Hex(unsubscribeKey(env), userId)).slice(0, 32);
}

export async function verifyUnsubscribeToken(env: Env, userId: string, token: string): Promise<boolean> {
  return /^[0-9a-f]{32}$/.test(token) && timingSafeEqual(await unsubscribeToken(env, userId), token);
}

export async function unsubscribeUrl(env: Env, userId: string): Promise<string> {
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  return `${origin}/api/v1/public/lifecycle/unsubscribe?u=${encodeURIComponent(userId)}&t=${await unsubscribeToken(env, userId)}`;
}

async function startDate(db: D1Database, now: Date): Promise<string> {
  const iso = nowIso(now);
  await db.prepare("INSERT OR IGNORE INTO platform_settings (k, v, updated_at) VALUES (?, ?, ?)").bind(SINCE_KEY, iso, iso).run();
  const r = await db.prepare("SELECT v FROM platform_settings WHERE k = ?").bind(SINCE_KEY).first<{ v: string }>();
  return r?.v ?? iso;
}

interface Candidate {
  id: string;
  email: string;
  name: string;
}

export async function sendLifecycleEmails(env: Env, now = new Date()): Promise<{ sent: number; skipped: number }> {
  const db = env.DB;
  const since = await startDate(db, now);
  const origin = env.APP_ORIGIN.replace(/\/$/, "");
  let sent = 0;
  let skipped = 0;
  for (const { kind, hours } of LIFECYCLE_KINDS) {
    const dueBefore = new Date(now.getTime() - hours * 3600_000).toISOString();
    const lateLimit = new Date(now.getTime() - (hours + MAX_LATE_HOURS) * 3600_000).toISOString();
    const from = lateLimit > since ? lateLimit : since;
    const { results } = await db
      .prepare(
        `SELECT u.id, u.email, u.name FROM users u
         WHERE u.email_verified_at IS NOT NULL AND u.lifecycle_emails_opt_out_at IS NULL AND u.created_at >= ? AND u.created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM lifecycle_emails l WHERE l.user_id = u.id AND l.kind = ?)
         ORDER BY u.created_at LIMIT ?`,
      )
      .bind(from, dueBefore, kind, BATCH)
      .all<Candidate>();
    for (const u of results) {
      const org = await db
        .prepare("SELECT m.organization_id AS id FROM memberships m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL ORDER BY m.created_at LIMIT 1")
        .bind(u.id)
        .first<{ id: string }>();
      const activation = org ? await activationFor(db, org.id) : null;
      const step = activation?.next ? activation.steps.find((s) => s.key === activation.next) : null;
      // Claim first (one row per user and kind) so two cron runs never send the same email twice.
      const reason = org && !step ? "nothing_pending" : null;
      const claim = await db
        .prepare("INSERT OR IGNORE INTO lifecycle_emails (user_id, kind, status, reason, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(u.id, kind, reason ? "skipped" : "sent", reason, nowIso(now))
        .run();
      if (!claim.meta.changes) continue;
      if (reason) {
        skipped++;
        continue;
      }
      const first = (u.name || "").trim().split(/\s+/)[0] || "";
      const hello = first ? `Hola, ${first}:` : "Hola:";
      const cta = step ? { label: step.cta, url: `${origin}/app${step.href}` } : { label: "Crear mi espacio de trabajo", url: `${origin}/app/onboarding` };
      const progress = activation ? `Llevas ${activation.done} de ${activation.total} pasos de la configuración.` : "Tu cuenta está creada, pero todavía no tienes un espacio de trabajo para tu web.";
      const nextLine = step ? `Siguiente paso: ${step.title}. ${step.description}` : "Crea tu espacio de trabajo y analiza tu web: en unos minutos tendrás tu informe completo y un plan de 30 días.";
      const subject = kind === "onboarding_24h" ? "Tu siguiente paso en DNI Growth" : "¿Te ayudamos a terminar la configuración?";
      const paragraphs =
        kind === "onboarding_24h"
          ? [hello, progress, nextLine, "Solo leemos tu web pública y nada se publica sin tu permiso."]
          : [hello, progress, nextLine, "Si algo no está claro o te has atascado, responde a este correo y te ayudamos personalmente."];
      const unsub = await unsubscribeUrl(env, u.id);
      const text = `${paragraphs.join("\n\n")}\n\n${cta.label}: ${cta.url}\n\n—\nNo quiero recibir más consejos de configuración: ${unsub}`;
      const result = await sendMail(
        env,
        { to: u.email, subject, text, html: emailHtml(subject, paragraphs, cta, { unsubscribeUrl: unsub }) },
        { kind: "notification", idempotencyKey: `lifecycle:${kind}:${u.id}`, organizationId: org?.id ?? null },
      );
      if (result === "not_configured") {
        await db.prepare("UPDATE lifecycle_emails SET status = 'skipped', reason = 'mail_not_configured' WHERE user_id = ? AND kind = ?").bind(u.id, kind).run();
        skipped++;
      } else sent++;
    }
  }
  if (sent || skipped) log("info", "lifecycle.run", { sent, skipped });
  return { sent, skipped };
}
