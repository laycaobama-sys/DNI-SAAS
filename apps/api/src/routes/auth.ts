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
import { emailHtml, mailMode, sendMail } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { createSession, destroySession } from "../lib/session";
import { addSeconds, hashIp, nowIso, uuid } from "../lib/util";
import { effectiveRole, platformAccess } from "../lib/platform";

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

async function sendVerification(env: Env, user: { id: string; email: string; name: string }) {
  const token = await issueEmailToken(env, user.id, "verify_email", 24 * 3600);
  const url = `${env.APP_ORIGIN}/app/verify?token=${token}`;
  return sendMail(
    env,
    {
      to: user.email,
      subject: "Verifica tu correo en DNI Growth",
      text: `Hola ${user.name},\n\nConfirma tu correo abriendo este enlace (caduca en 24 h):\n${url}\n\nSi no has creado una cuenta, ignora este mensaje.`,
      html: emailHtml("Confirma tu correo", [`Hola ${user.name},`, "Confirma tu dirección para activar tu cuenta de DNI Growth. El enlace caduca en 24 horas."], { label: "Confirmar correo", url }),
    },
    { kind: "verify_email", idempotencyKey: `verify_email:${await sha256Hex(token)}` },
  );
}

export const auth = new Hono<AppEnv>();

auth.post("/register", async (c) => {
  await rateLimit(c.env.DB, `register:${await hashIp(c.env, c.req.header("cf-connecting-ip"))}`, 10, 3600);
  const input = await parseBody(c, RegisterInput);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(input.email).first();
  if (!existing) {
    const id = uuid();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").bind(id, input.email, input.name, await hashPassword(input.password)),
      auditStmt(c.env.DB, { organizationId: null, actorUserId: id, action: "user.register", entityType: "user", entityId: id, requestId: c.get("requestId") }),
    ]);
    await sendVerification(c.env, { id, email: input.email, name: input.name });
  } else {
    await (dummyHash ??= hashPassword("dummy-password-0"));
  }
  // Identical response whether or not the email exists (anti-enumeration): the delivery mode is a
  // platform property, never a per-user outcome.
  return c.json({ ok: true, delivery: mailMode(c.env) === "not_configured" ? "not_configured" : "sent" }, 202);
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
    const url = `${c.env.APP_ORIGIN}/app/reset?token=${token}`;
    await sendMail(
      c.env,
      {
        to: email,
        subject: "Restablece tu contraseña de DNI Growth",
        text: `Hola ${u.name},\n\nPara elegir una nueva contraseña abre este enlace (caduca en 1 h):\n${url}\n\nSi no lo has pedido tú, ignora este mensaje.`,
        html: emailHtml("Restablece tu contraseña", [`Hola ${u.name},`, "Has pedido cambiar tu contraseña. El enlace caduca en 1 hora y solo se puede usar una vez."], { label: "Elegir nueva contraseña", url }),
      },
      { kind: "reset_password", idempotencyKey: `reset_password:${await sha256Hex(token)}` },
    );
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
  const now = new Date().toISOString();
  const [{ results }, { results: deleted }, { results: support }, platformRole] = await Promise.all([
    c.env.DB.prepare(
      // effective_plan: a client organisation on «free» uses its agency's plan (same rule as orgPlan()).
      `SELECT o.id, o.name, o.slug, o.plan_code, o.status, m.role,
              CASE WHEN o.plan_code = 'free' AND a.plan_code IS NOT NULL THEN a.plan_code ELSE o.plan_code END AS effective_plan
       FROM memberships m JOIN organizations o ON o.id = m.organization_id LEFT JOIN organizations a ON a.id = o.agency_org_id
       WHERE m.user_id = ? AND m.status = 'active' AND o.deleted_at IS NULL ORDER BY o.created_at`,
    )
      .bind(u.id)
      .all<{ id: string; name: string; slug: string; plan_code: string; status: string; role: string; effective_plan: string }>(),
    // Organisations this user deleted as owner and can still restore (30 days).
    c.env.DB.prepare(
      `SELECT o.id, o.name, o.deleted_at, o.purge_after FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = ? AND m.role = 'owner' AND m.status = 'active' AND o.deleted_at IS NOT NULL AND o.purge_after > ? ORDER BY o.deleted_at DESC`,
    )
      .bind(u.id, now)
      .all(),
    c.env.DB.prepare(
      `SELECT g.organization_id AS id, o.name, g.expires_at, g.id AS grant_id FROM support_access_grants g JOIN organizations o ON o.id = g.organization_id
       WHERE g.user_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND o.deleted_at IS NULL ORDER BY g.expires_at DESC`,
    )
      .bind(u.id, now)
      .all(),
    platformAccess(c.env, u),
  ]);
  const role = effectiveRole(platformRole);
  const staff = platformRole.legacy || !!platformRole.role;
  return c.json({
    user: { id: u.id, email: u.email, name: u.name, emailVerified: u.emailVerified, isPlatformAdmin: !!role },
    memberships: results,
    deletedOrganizations: deleted,
    // Only platform staff ever see these keys.
    ...(staff ? { platform: { member: true, unlocked: !!role, role: platformRole.role, claimed: platformRole.claimed, legacy: platformRole.legacy }, supportAccess: role ? support : [] } : {}),
  });
});
