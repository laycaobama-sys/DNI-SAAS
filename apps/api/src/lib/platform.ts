import { decryptJson, encryptJson, isPlatformRole, PLATFORM_MFA_TTL_SECONDS, PLATFORM_STEP_UP_SECONDS, type PlatformRole } from "@dni/core";
import type { Env, SessionUser } from "../env";

/**
 * Platform access state of the current user.
 *
 * - `claimed`: an ACTIVE platform_owner exists. From then on only platform_members rows count; the
 *   legacy PLATFORM_ADMIN_EMAILS allowlist and users.is_platform_admin are ignored (no privilege by
 *   e-mail coincidence) and every platform request needs a session that proved TOTP recently.
 * - Before the first claim (transition only) the legacy admin keeps working so the titular is never
 *   locked out, but critical actions already require the claimed + MFA path.
 */
export interface PlatformAccess {
  claimed: boolean;
  role: PlatformRole | null;
  status: "pending_mfa" | "active" | "disabled" | null;
  legacy: boolean;
  mfaFresh: boolean;
  stepUpFresh: boolean;
  mfaAt: string | null;
}

export const NO_ACCESS: PlatformAccess = { claimed: false, role: null, status: null, legacy: false, mfaFresh: false, stepUpFresh: false, mfaAt: null };

export async function ownerClaimed(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM platform_members WHERE role = 'platform_owner' AND status = 'active' LIMIT 1").first();
  return !!r;
}

function legacyEmail(env: Env, email: string) {
  return (env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

const fresh = (at: string | null | undefined, seconds: number) => !!at && Date.now() - Date.parse(at) <= seconds * 1000;

export async function platformAccess(env: Env, user: SessionUser | null): Promise<PlatformAccess> {
  if (!user || !user.emailVerified) return NO_ACCESS;
  const [claimed, row, legacyRow] = await Promise.all([
    ownerClaimed(env.DB),
    env.DB.prepare("SELECT role, status FROM platform_members WHERE user_id = ?").bind(user.id).first<{ role: string; status: "pending_mfa" | "active" | "disabled" }>(),
    env.DB.prepare("SELECT is_platform_admin FROM users WHERE id = ?").bind(user.id).first<{ is_platform_admin: number }>(),
  ]);
  const mfaAt = user.platformMfaAt ?? null;
  const role = row && isPlatformRole(row.role) ? row.role : null;
  if (claimed) {
    const active = row?.status === "active" && !!role;
    return {
      claimed,
      role,
      status: row?.status ?? null,
      legacy: false,
      mfaFresh: active && fresh(mfaAt, PLATFORM_MFA_TTL_SECONDS),
      stepUpFresh: active && fresh(mfaAt, PLATFORM_STEP_UP_SECONDS),
      mfaAt,
    };
  }
  const legacy = legacyEmail(env, user.email) || legacyRow?.is_platform_admin === 1;
  return { claimed, role: legacy ? "platform_owner" : role, status: row?.status ?? null, legacy, mfaFresh: legacy, stepUpFresh: false, mfaAt };
}

/** Effective platform role usable RIGHT NOW (active + MFA-fresh, or legacy before the first claim). */
export function effectiveRole(a: PlatformAccess): PlatformRole | null {
  if (a.claimed) return a.status === "active" && a.mfaFresh ? a.role : null;
  return a.legacy ? "platform_owner" : null;
}

const aad = (userId: string) => `platform-mfa:${userId}`;
export const sealMfaSecret = (env: Env, userId: string, secret: string) => encryptJson(env.DATA_ENC_KEY!, { s: secret }, aad(userId));
export async function openMfaSecret(env: Env, userId: string, envelope: string) {
  return (await decryptJson<{ s: string }>(env.DATA_ENC_KEY!, envelope, aad(userId))).s;
}

/** Ten single-use recovery codes, shown once (format XXXX-XXXX-XXXX). */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: n }, () => {
    const b = crypto.getRandomValues(new Uint8Array(12));
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  });
}
export const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
