import type { Env } from "../env";
import { log, uuid } from "./util";

export type MailDelivery = "sent" | "dev_mailbox" | "not_configured";

/**
 * Transactional mail adapter.
 *  - RESEND_API_KEY set  → real delivery via Resend API.
 *  - development        → stored in dev_mailbox (local only; endpoint disabled elsewhere).
 *  - otherwise          → not_configured (caller must tell the user honestly).
 */
export async function sendMail(env: Env, msg: { to: string; subject: string; text: string }): Promise<MailDelivery> {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      log("error", "mail.send_failed", { status: res.status });
      throw new Error("mail_send_failed");
    }
    return "sent";
  }
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") {
    await env.DB.prepare("INSERT INTO dev_mailbox (id, to_email, subject, body) VALUES (?, ?, ?, ?)").bind(uuid(), msg.to, msg.subject, msg.text).run();
    return "dev_mailbox";
  }
  log("warn", "mail.not_configured", { subject: msg.subject });
  return "not_configured";
}
