import { decryptJson, encryptJson, maskEmail, sha256Hex } from "@dni/core";
import type { Env } from "../env";
import { addSeconds, log, nowIso, uuid } from "./util";

/**
 * Transactional email with a durable outbox.
 *
 *  enqueue → email_outbox (recipient hashed+masked, message AES-GCM encrypted)
 *          → immediate dispatch attempt → provider
 *          → retries with backoff from the cron (max 5) → 'dead'
 *
 * Providers:
 *  - CloudflareEmailProvider: official `send_email` binding (Cloudflare Email Service).
 *    Requires EMAIL binding + MAIL_FROM on a domain onboarded in Email Sending.
 *  - DevMailboxProvider: development/test only (stored in dev_mailbox, never sent).
 *  - none → mode "not_configured": nothing is queued and the caller tells the user honestly.
 *
 * "accepted" means the provider accepted the message — it does NOT prove inbox delivery.
 */

export type MailKind = "verify_email" | "reset_password" | "invitation" | "notification";
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Display name of the sender (address is always MAIL_FROM). */
  fromName?: string;
  /** Where replies go (e.g. the organisation's own inbox for automatic replies to its leads). */
  replyTo?: string;
}
export type SendResult = { ok: true; messageId: string | null } | { ok: false; code: string; retryable: boolean };

export interface TransactionalEmailProvider {
  readonly name: string;
  send(msg: MailMessage): Promise<SendResult>;
}

/** Minimal shape of the Cloudflare `send_email` binding we rely on (keeps tests network-free). */
export interface EmailBinding {
  send(msg: { from: string | { email: string; name: string }; to: string; subject: string; text?: string; html?: string; replyTo?: string }): Promise<{ messageId?: string }>;
}

export class CloudflareEmailProvider implements TransactionalEmailProvider {
  readonly name = "cloudflare_email";
  constructor(
    private readonly binding: EmailBinding,
    private readonly from: string,
    private readonly replyTo?: string,
  ) {}
  async send(msg: MailMessage): Promise<SendResult> {
    try {
      const r = await this.binding.send({
        from: { email: this.from, name: msg.fromName ?? "DNI Growth" },
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.replyTo || this.replyTo ? { replyTo: msg.replyTo ?? this.replyTo } : {}),
      });
      return { ok: true, messageId: r?.messageId ?? null };
    } catch (e) {
      const m = String((e as Error)?.message ?? e).toLowerCase();
      // Configuration problems (unverified sender/domain, recipient not allowed) are not retryable.
      const permanent = /not (verified|allowed|authori[sz]ed)|unverified|invalid (from|sender|recipient|address)|domain/.test(m);
      return { ok: false, code: permanent ? "provider_rejected" : "provider_error", retryable: !permanent };
    }
  }
}

export class DevMailboxProvider implements TransactionalEmailProvider {
  readonly name = "dev_mailbox";
  constructor(private readonly db: D1Database) {}
  async send(msg: MailMessage): Promise<SendResult> {
    await this.db.prepare("INSERT INTO dev_mailbox (id, to_email, subject, body) VALUES (?, ?, ?, ?)").bind(uuid(), msg.to.toLowerCase(), msg.subject, msg.text).run();
    return { ok: true, messageId: null };
  }
}

const isDevLike = (env: Env) => env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";
const DEV_KEY = "0".repeat(63) + "1"; // dev/test only; production requires DATA_ENC_KEY

export function resolveProvider(env: Env): TransactionalEmailProvider | null {
  if (env.EMAIL && env.MAIL_FROM && env.EMAIL_SENDING_ENABLED === "true") return new CloudflareEmailProvider(env.EMAIL as unknown as EmailBinding, env.MAIL_FROM, env.MAIL_REPLY_TO);
  if (isDevLike(env)) return new DevMailboxProvider(env.DB);
  return null;
}

/** Public, user-independent delivery mode (safe to expose: no enumeration signal). */
export function mailMode(env: Env): "enabled" | "dev_mailbox" | "not_configured" {
  const p = resolveProvider(env);
  return !p ? "not_configured" : p.name === "dev_mailbox" ? "dev_mailbox" : "enabled";
}

export function encKey(env: Env): string | null {
  if (env.DATA_ENC_KEY) return env.DATA_ENC_KEY;
  return isDevLike(env) ? DEV_KEY : null;
}

export type EnqueueResult = "queued" | "accepted" | "dev_mailbox" | "not_configured";

/**
 * Enqueue + immediate dispatch attempt. Never throws for delivery failures: the outbox keeps
 * retrying. `idempotencyKey` makes repeated calls for the same logical email a no-op.
 */
export async function sendMail(
  env: Env,
  msg: MailMessage,
  opts: { kind: MailKind; idempotencyKey: string; organizationId?: string | null; /** ISO time: queue now, send from then on (quiet hours). */ notBefore?: string },
): Promise<EnqueueResult> {
  const provider = resolveProvider(env);
  const key = encKey(env);
  if (!provider || !key) {
    log("warn", "mail.not_configured", { kind: opts.kind });
    return "not_configured";
  }
  const id = uuid();
  const now = nowIso();
  const payload = await encryptJson(key, msg, id);
  const ins = await env.DB.prepare(
    // Timestamps come from the Worker clock (not the DB clock) so the immediate claim below is always due.
    `INSERT OR IGNORE INTO email_outbox (id, organization_id, kind, to_hash, to_masked, payload_enc, idempotency_key, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, opts.organizationId ?? null, opts.kind, await sha256Hex(msg.to.toLowerCase()), maskEmail(msg.to), payload, opts.idempotencyKey, opts.notBefore && opts.notBefore > now ? opts.notBefore : now, now, now)
    .run();
  if (!ins.meta.changes) return provider.name === "dev_mailbox" ? "dev_mailbox" : "queued";
  if (opts.notBefore && opts.notBefore > now) return "queued";
  const status = await dispatchEmail(env, id, provider);
  if (provider.name === "dev_mailbox") return "dev_mailbox";
  return status === "accepted" ? "accepted" : "queued";
}

const backoff = (attempt: number) => Math.min(60 * 2 ** (attempt - 1), 3600);

/** Monthly ceiling for real sends (default 2500 < 3000 included in Workers Paid). */
export function monthlyCap(env: Env): number {
  const n = Number(env.EMAIL_MONTHLY_CAP ?? "2500");
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2500;
}

/** Emails accepted by the real provider since the start of the current UTC month. */
export async function monthlySent(env: Env): Promise<number> {
  const start = `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'accepted' AND provider <> 'dev_mailbox' AND accepted_at >= ?")
    .bind(start)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Claims one outbox row and sends it. Safe under concurrent cron + request dispatch. */
export async function dispatchEmail(env: Env, id: string, provider = resolveProvider(env)): Promise<string> {
  const key = encKey(env);
  if (!provider || !key) return "not_configured";
  const claimed = await env.DB.prepare(
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status IN ('queued','failed') AND next_attempt_at <= ? RETURNING attempts, max_attempts, payload_enc, kind`,
  )
    .bind(nowIso(), id, nowIso())
    .first<{ attempts: number; max_attempts: number; payload_enc: string | null; kind: string }>();
  if (!claimed) return "skipped";
  if (!claimed.payload_enc) {
    await env.DB.prepare("UPDATE email_outbox SET status = 'dead', last_error_code = 'payload_missing', updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
    return "dead";
  }
  let res: SendResult;
  if (provider.name !== "dev_mailbox" && (await monthlySent(env)) >= monthlyCap(env)) {
    // Never exceed the plan's included volume: refuse instead of incurring overage charges.
    res = { ok: false, code: "monthly_cap_reached", retryable: false };
  } else {
    try {
      const msg = await decryptJson<MailMessage>(key, claimed.payload_enc, id);
      res = await provider.send(msg);
    } catch {
      res = { ok: false, code: "decrypt_failed", retryable: false };
    }
  }
  if (res.ok) {
    // Purge the encrypted body: the single-use link no longer needs to exist at rest.
    await env.DB.prepare(
      "UPDATE email_outbox SET status = 'accepted', provider = ?, provider_message_id = ?, payload_enc = NULL, accepted_at = ?, updated_at = ?, last_error_code = NULL WHERE id = ?",
    )
      .bind(provider.name, res.messageId, nowIso(), nowIso(), id)
      .run();
    log("info", "mail.accepted", { kind: claimed.kind, provider: provider.name, attempt: claimed.attempts });
    return "accepted";
  }
  const dead = !res.retryable || claimed.attempts >= claimed.max_attempts;
  await env.DB.prepare(
    `UPDATE email_outbox SET status = ?, provider = ?, last_error_code = ?, next_attempt_at = ?, updated_at = ?${dead ? ", payload_enc = NULL" : ""} WHERE id = ?`,
  )
    .bind(dead ? "dead" : "failed", provider.name, res.code, addSeconds(backoff(claimed.attempts)), nowIso(), id)
    .run();
  log(dead ? "error" : "warn", dead ? "mail.dead" : "mail.retry_scheduled", { kind: claimed.kind, provider: provider.name, code: res.code, attempt: claimed.attempts });
  return dead ? "dead" : "failed";
}

/** Cron: retry due emails and recover rows stuck in 'sending' (worker died mid-send). */
export async function drainEmailOutbox(env: Env, limit = 25): Promise<number> {
  const provider = resolveProvider(env);
  if (!provider) return 0;
  await env.DB.prepare("UPDATE email_outbox SET status = 'failed', updated_at = ? WHERE status = 'sending' AND updated_at < ?")
    .bind(nowIso(), addSeconds(-300))
    .run();
  const { results } = await env.DB.prepare("SELECT id FROM email_outbox WHERE status IN ('queued','failed') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?")
    .bind(nowIso(), limit)
    .all<{ id: string }>();
  for (const r of results) await dispatchEmail(env, r.id, provider);
  return results.length;
}

/** Minimal, accessible HTML wrapper (text version is always sent too). */
export function emailHtml(title: string, paragraphs: string[], cta?: { label: string; url: string }, opts: { unsubscribeUrl?: string } = {}): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f4f4f2;font-family:Inter,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:16px;padding:32px" cellpadding="0" cellspacing="0"><tr><td>
<p style="margin:0 0 24px;font-weight:800;letter-spacing:.08em">DNI <span style="font-weight:400;font-style:italic">Growth</span></p>
<h1 style="font-size:22px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${esc(p)}</p>`).join("")}
${cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="display:inline-block;background:#b4ff4d;color:#0b0b0c;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px">${esc(cta.label)}</a></p><p style="font-size:12px;color:#666;word-break:break-all">${esc(cta.url)}</p>` : ""}
${opts.unsubscribeUrl ? `<p style="font-size:12px;color:#888;margin-top:24px">Te escribimos porque creaste una cuenta en DNI Growth. <a href="${esc(opts.unsubscribeUrl)}" style="color:#666">No quiero recibir más consejos de configuración</a>.</p>` : `<p style="font-size:12px;color:#888;margin-top:24px">Has recibido este correo por una acción en DNI Growth. Si no has sido tú, ignóralo.</p>`}
</td></tr></table></td></tr></table></body></html>`;
}
