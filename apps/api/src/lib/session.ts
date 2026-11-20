import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomToken, sha256Hex } from "@dni/core";
import type { AppEnv, SessionUser } from "../env";
import { addSeconds, hashIp, nowIso } from "./util";

export const SESSION_COOKIE = "dni_session";
const IDLE_TTL = 7 * 24 * 3600; // sliding window
const ABSOLUTE_TTL = 30 * 24 * 3600; // hard cap
const TOUCH_EVERY = 3600;

const secureCookies = (c: Context<AppEnv>) => c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test";

export async function createSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const now = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, absolute_expires_at, last_seen_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, now, addSeconds(IDLE_TTL), addSeconds(ABSOLUTE_TTL), now, await hashIp(c.env, c.req.header("cf-connecting-ip")))
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(c),
    sameSite: "Lax",
    path: "/",
    maxAge: ABSOLUTE_TTL,
  });
}

/** Resolves the session; renews the sliding expiry at most once per hour. */
export async function loadSession(c: Context<AppEnv>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const id = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.expires_at, s.absolute_expires_at, s.last_seen_at, s.revoked_at, s.platform_mfa_at,
            u.id AS user_id, u.email, u.name, u.email_verified_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<{
      id: string;
      expires_at: string;
      absolute_expires_at: string;
      last_seen_at: string;
      revoked_at: string | null;
      platform_mfa_at: string | null;
      user_id: string;
      email: string;
      name: string;
      email_verified_at: string | null;
    }>();
  const now = new Date();
  if (!row || row.revoked_at || new Date(row.expires_at) <= now || new Date(row.absolute_expires_at) <= now) return null;
  if (now.getTime() - new Date(row.last_seen_at).getTime() > TOUCH_EVERY * 1000) {
    const idle = addSeconds(IDLE_TTL, now);
    const next = idle < row.absolute_expires_at ? idle : row.absolute_expires_at;
    await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").bind(nowIso(now), next, row.id).run();
  }
  return { id: row.user_id, email: row.email, name: row.name, emailVerified: !!row.email_verified_at, sessionId: row.id, platformMfaAt: row.platform_mfa_at };
}

export async function destroySession(c: Context<AppEnv>, sessionId: string | null) {
  if (sessionId) await c.env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").bind(nowIso(), sessionId).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: secureCookies(c) });
}
