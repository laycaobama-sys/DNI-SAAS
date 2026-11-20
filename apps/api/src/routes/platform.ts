import { Hono } from "hono";
import { z } from "zod";
import { newTotpSecret, otpauthUri, PLATFORM_MFA_TTL_SECONDS, PLATFORM_ROLE_LABEL, PLATFORM_ROLE_SCOPES, sha256Hex, verifyTotp } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, parseBody } from "../lib/http";
import { effectiveRole, newRecoveryCodes, normaliseRecovery, openMfaSecret, platformAccess, sealMfaSecret } from "../lib/platform";
import { rateLimit } from "../lib/ratelimit";
import { hashIp, nowIso } from "../lib/util";
import { requireUser } from "../middleware";

/**
 * Platform identity: claim, TOTP enrolment and per-session verification. Requires a signed-in user
 * with a verified e-mail; everything else (what the account can do) is decided by platform_members.
 */
export const platform = new Hono<AppEnv>();
platform.use("*", requireUser);

const Code = z.object({ code: z.string().trim().min(6).max(32) });

/** Platform state of THIS session. Non-staff get { member: false } and nothing else. */
platform.get("/session", async (c) => {
  const u = c.get("user")!;
  const a = await platformAccess(c.env, u);
  const role = effectiveRole(a);
  if (!a.legacy && !a.role) return c.json({ member: false, claimed: a.claimed });
  return c.json({
    member: true,
    claimed: a.claimed,
    legacy: a.legacy,
    role: a.role,
    roleLabel: a.role ? PLATFORM_ROLE_LABEL[a.role] : null,
    status: a.legacy ? "legacy" : a.status,
    unlocked: !!role,
    scopes: role ? PLATFORM_ROLE_SCOPES[role] : [],
    mfaVerifiedAt: a.mfaAt,
    mfaExpiresAt: a.mfaAt ? new Date(Date.parse(a.mfaAt) + PLATFORM_MFA_TTL_SECONDS * 1000).toISOString() : null,
    stepUpFresh: a.stepUpFresh,
  });
});

/**
 * Binds the signed-in, verified account to a platform role with a ONE-TIME code created by the
 * titular from her own terminal (scripts/platform-claim.mjs, with her Cloudflare login). Only the code's
 * hash exists in the database. The code is burnt atomically on first use, even by a wrong account.
 */
platform.post("/claim", async (c) => {
  const u = c.get("user")!;
  await rateLimit(c.env.DB, `platform-claim:${u.id}`, 5, 3600);
  const { code } = await parseBody(c, Code);
  if (!c.env.DATA_ENC_KEY) throw new ApiError(503, "encryption_unavailable", "El cifrado de la plataforma no está configurado.");
  const hash = await sha256Hex(code.trim());
  const now = nowIso();
  const claim = await c.env.DB.prepare(
    "UPDATE platform_claim_codes SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING role",
  )
    .bind(now, u.id, hash, now)
    .first<{ role: string }>();
  if (!claim) {
    await auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: "platform.claim_failed", entityType: "platform", requestId: c.get("requestId"), ipHash: await hashIp(c.env, c.req.header("cf-connecting-ip")) }).run();
    throw new ApiError(400, "invalid_claim_code", "Código no válido, caducado o ya usado.");
  }
  if (claim.role === "platform_owner") {
    const owner = await c.env.DB.prepare("SELECT user_id FROM platform_members WHERE role = 'platform_owner' AND status = 'active' LIMIT 1").first<{ user_id: string }>();
    if (owner && owner.user_id !== u.id) throw new ApiError(409, "owner_exists", "La plataforma ya tiene propietario.");
  }
  const secret = newTotpSecret();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO platform_members (user_id, role, status, mfa_secret_enc, created_by) VALUES (?, ?, 'pending_mfa', ?, 'claim_code')
       ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, status = 'pending_mfa', mfa_secret_enc = excluded.mfa_secret_enc, mfa_last_step = NULL, mfa_enabled_at = NULL`,
    ).bind(u.id, claim.role, await sealMfaSecret(c.env, u.id, secret)),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: "platform.claimed", entityType: "platform_member", entityId: u.id, after: { role: claim.role }, requestId: c.get("requestId") }),
  ]);
  return c.json({ role: claim.role, otpauthUri: otpauthUri(secret), secret });
});

/** First TOTP code: activates the member, returns the recovery codes ONCE and unlocks this session. */
platform.post("/mfa/confirm", async (c) => {
  const u = c.get("user")!;
  await rateLimit(c.env.DB, `platform-mfa:${u.id}`, 10, 900);
  const { code } = await parseBody(c, Code);
  const m = await c.env.DB.prepare("SELECT status, mfa_secret_enc FROM platform_members WHERE user_id = ?").bind(u.id).first<{ status: string; mfa_secret_enc: string | null }>();
  if (!m || m.status !== "pending_mfa" || !m.mfa_secret_enc) throw new ApiError(409, "nothing_to_confirm", "No hay ninguna activación pendiente.");
  const step = await verifyTotp(await openMfaSecret(c.env, u.id, m.mfa_secret_enc), code, Date.now());
  if (step === null) throw new ApiError(400, "invalid_mfa_code", "Código incorrecto. Comprueba la hora del móvil y vuelve a intentarlo.");
  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map((x) => sha256Hex(normaliseRecovery(x))));
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE platform_members SET status = 'active', mfa_enabled_at = ?, activated_at = ?, mfa_last_step = ?, recovery_hashes = ? WHERE user_id = ? AND status = 'pending_mfa'").bind(
      now,
      now,
      step,
      JSON.stringify(hashes),
      u.id,
    ),
    c.env.DB.prepare("UPDATE sessions SET platform_mfa_at = ? WHERE id = ?").bind(now, u.sessionId),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: "platform.mfa_enabled", entityType: "platform_member", entityId: u.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, recoveryCodes: codes });
});

/** Unlocks the Control Center for this session (12 h) and refreshes the 15-minute step-up window. */
platform.post("/mfa/verify", async (c) => {
  const u = c.get("user")!;
  await rateLimit(c.env.DB, `platform-mfa:${u.id}`, 10, 900);
  const { code } = await parseBody(c, Code);
  const m = await c.env.DB.prepare("SELECT status, mfa_secret_enc, mfa_last_step, recovery_hashes FROM platform_members WHERE user_id = ?")
    .bind(u.id)
    .first<{ status: string; mfa_secret_enc: string | null; mfa_last_step: number | null; recovery_hashes: string }>();
  if (!m || m.status !== "active" || !m.mfa_secret_enc) throw new ApiError(404, "not_found", "Recurso no encontrado.");
  const ip = await hashIp(c.env, c.req.header("cf-connecting-ip"));
  const now = nowIso();
  let viaRecovery = false;
  let step: number | null = null;
  if (/^\d{6}$/.test(code)) step = await verifyTotp(await openMfaSecret(c.env, u.id, m.mfa_secret_enc), code, Date.now(), m.mfa_last_step);
  else {
    const h = await sha256Hex(normaliseRecovery(code));
    const list = JSON.parse(m.recovery_hashes || "[]") as string[];
    if (list.includes(h)) {
      // Single use: removed in the same conditional write that accepts it.
      const left = JSON.stringify(list.filter((x) => x !== h));
      const r = await c.env.DB.prepare("UPDATE platform_members SET recovery_hashes = ? WHERE user_id = ? AND recovery_hashes = ? RETURNING user_id").bind(left, u.id, m.recovery_hashes).first();
      viaRecovery = !!r;
    }
  }
  if (step !== null) {
    // Replay guard under concurrency: only one request can advance the last accepted step.
    const adv = await c.env.DB.prepare("UPDATE platform_members SET mfa_last_step = ? WHERE user_id = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?) RETURNING user_id").bind(step, u.id, step).first();
    if (!adv) step = null;
  }
  if (step === null && !viaRecovery) {
    await auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: "platform.mfa_failed", entityType: "platform_member", entityId: u.id, ipHash: ip, requestId: c.get("requestId") }).run();
    throw new ApiError(400, "invalid_mfa_code", "Código incorrecto o ya usado.");
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sessions SET platform_mfa_at = ? WHERE id = ?").bind(now, u.sessionId),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: u.id, action: viaRecovery ? "platform.mfa_recovery_used" : "platform.mfa_verified", entityType: "platform_member", entityId: u.id, ipHash: ip, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, viaRecovery });
});

/** Leaves platform mode in this session (the user stays signed in to the app). */
platform.post("/lock", async (c) => {
  const u = c.get("user")!;
  await c.env.DB.prepare("UPDATE sessions SET platform_mfa_at = NULL WHERE id = ?").bind(u.sessionId).run();
  return c.json({ ok: true });
});
