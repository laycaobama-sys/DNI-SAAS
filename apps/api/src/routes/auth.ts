import { Hono } from "hono";
import {
  hashPassword,
  LoginInput,
  RegisterInput,
  ResendInput,
  ResetConfirmInput,
  randomToken,
  sha256Hex,
  TokenInput,
  verifyPassword,
} from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, parseBody } from "../lib/http";
import { sendMail, type MailDelivery } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { createSession, destroySession } from "../lib/session";
import { addSeconds, hashIp, nowIso, uuid } from "../lib/util";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Pre-computed dummy hash so unknown emails cost the same time as known ones (no user enumeration).
let dummyHash: Promise<string> | null = null;

async function issueEmailToken(env: Env, userId: string, purpose: "verify_email" | "reset_password", ttlSeconds: number) {
  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL").bind(nowIso(), userId, purpose),
    env.DB.prepare("INSERT INTO email_tokens (id, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), userId, purpose, addSeconds(ttlSeconds)),
  ]);
  return token;
}

async function consumeEmailToken(env: Env, token: string, purpose: "verify_email" | "reset_password"): Promise<string> {
  const row = await env.DB.prepare(
    "UPDATE email_tokens SET used_at = ? WHERE id = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id",
  )
    .bind(nowIso(), await sha256Hex(token), purpose, nowIso())
    .first<{ user_id: string }>();
  if (!row) throw new ApiError(400, "invalid_or_expired_token", "El enlace no es válido o ha caducado.");
  return row.user_id;
}

async function sendVerification(env: Env, user: { id: string; email: string; name: string }): Promise<MailDelivery> {
  const token = await issueEmailToken(env, user.id, "verify_email", 24 * 3600);
  return sendMail(env, {
    to: user.email,
    subject: "Verifica tu correo en DNI Growth",
    text: `Hola ${user.name},\n\nConfirma tu correo abriendo este enlace (caduca en 24 h):\n${env.APP_ORIGIN}/app/verify?token=${token}\n\nSi no has creado una cuenta, ignora este mensaje.`,
  });
}

export const auth = new Hono<AppEnv>();

auth.post("/register", async (c) => {
  await rateLimit(c.env.DB, `register:${await hashIp(c.env, c.req.header("cf-connecting-ip"))}`, 10, 3600);
  const input = await parseBody(c, RegisterInput);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(input.email).first();
  let delivery: MailDelivery = "sent";
  if (!existing) {
    const id = uuid();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").bind(id, input.email, input.name, await hashPassword(input.password)),
      auditStmt(c.env.DB, { organizationId: null, actorUserId: id, action: "user.register", entityType: "user", entityId: id, requestId: c.get("requestId") }),
    ]);
    delivery = await sendVerification(c.env, { id, email: input.email, name: input.name });
  } else {
    await (dummyHash ??= hashPassword("dummy-password-0"));
  }
  // Identical response whether or not the email exists (anti-enumeration).
  return c.json({ ok: true, delivery: delivery === "not_configured" ? "not_configured" : "sent" }, 202);
});

auth.post("/verify-email", async (c) => {
  const { token } = await parseBody(c, TokenInput);
  const userId = await consumeEmailToken(c.env, token, "verify_email");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), userId),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: userId, action: "user.verify_email", entityType: "user", entityId: userId, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

auth.post("/resend-verification", async (c) => {
  const { email } = await parseBody(c, ResendInput);
  await rateLimit(c.env.DB, `resend:${email}`, 3, 3600);
  const u = await c.env.DB.prepare("SELECT id, email, name, email_verified_at FROM users WHERE email = ?").bind(email).first<{ id: string; email: string; name: string; email_verified_at: string | null }>();
  if (u && !u.email_verified_at) await sendVerification(c.env, u);
  return c.json({ ok: true }, 202);
});

auth.post("/login", async (c) => {
  const ipHash = await hashIp(c.env, c.req.header("cf-connecting-ip"));
  await rateLimit(c.env.DB, `login-ip:${ipHash}`, 30, 900);
  const input = await parseBody(c, LoginInput);
  const u = await c.env.DB.prepare("SELECT id, password_hash, email_verified_at, failed_login_count, locked_until FROM users WHERE email = ?")
    .bind(input.email)
    .first<{ id: string; password_hash: string; email_verified_at: string | null; failed_login_count: number; locked_until: string | null }>();
  const invalid = new ApiError(401, "invalid_credentials", "Email o contraseña incorrectos.");
  if (!u) {
    await (dummyHash ??= hashPassword("dummy-password-0")).then((h) => verifyPassword(input.password, h));
    throw invalid;
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw new ApiError(423, "account_locked", "Cuenta bloqueada temporalmente por intentos fallidos. Inténtalo en 15 minutos.");
  }
  if (!(await verifyPassword(input.password, u.password_hash))) {
    const failed = u.failed_login_count + 1;
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?").bind(
        failed >= MAX_FAILED ? 0 : failed,
        failed >= MAX_FAILED ? addSeconds(LOCK_MINUTES * 60) : null,
        u.id,
      ),
      auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: "user.login_failed", entityType: "user", entityId: u.id, ipHash, requestId: c.get("requestId") }),
    ]);
    throw invalid;
  }
  if (!u.email_verified_at) throw new ApiError(403, "email_not_verified", "Verifica tu correo antes de iniciar sesión.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?").bind(u.id),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: "user.login", entityType: "user", entityId: u.id, ipHash, requestId: c.get("requestId") }),
  ]);
  await createSession(c, u.id);
  return c.json({ ok: true });
});

auth.post("/logout", async (c) => {
  await destroySession(c, c.get("user")?.sessionId ?? null);
  return c.json({ ok: true });
});

auth.post("/password-reset/request", async (c) => {
  const { email } = await parseBody(c, ResendInput);
  await rateLimit(c.env.DB, `reset:${email}`, 3, 3600);
  const u = await c.env.DB.prepare("SELECT id, name FROM users WHERE email = ?").bind(email).first<{ id: string; name: string }>();
  if (u) {
    const token = await issueEmailToken(c.env, u.id, "reset_password", 3600);
    await sendMail(c.env, {
      to: email,
      subject: "Restablece tu contraseña de DNI Growth",
      text: `Hola ${u.name},\n\nPara elegir una nueva contraseña abre este enlace (caduca en 1 h):\n${c.env.APP_ORIGIN}/app/reset?token=${token}\n\nSi no lo has pedido tú, ignora este mensaje.`,
    });
  }
  return c.json({ ok: true }, 202);
});

auth.post("/password-reset/confirm", async (c) => {
  const { token, password } = await parseBody(c, ResetConfirmInput);
  const userId = await consumeEmailToken(c.env, token, "reset_password");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?").bind(await hashPassword(password), nowIso(), userId),
    // Revoke every existing session after a password change.
    c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").bind(nowIso(), userId),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: userId, action: "user.password_reset", entityType: "user", entityId: userId, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const u = c.get("user");
  if (!u) return c.json({ user: null, memberships: [] });
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.plan_code, m.role FROM memberships m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.created_at`,
  )
    .bind(u.id)
    .all<{ id: string; name: string; slug: string; plan_code: string; role: string }>();
  return c.json({ user: { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified }, memberships: results });
});
