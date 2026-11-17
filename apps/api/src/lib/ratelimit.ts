import { ApiError } from "./http";

/** Atomic fixed-window rate limit stored in D1. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<void> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if (row && row.count > limit) {
    throw new ApiError(429, "rate_limited", "Demasiadas solicitudes. Inténtalo de nuevo en unos minutos.", {
      retryAfterSeconds: windowStart + windowSeconds - Math.floor(Date.now() / 1000),
    });
  }
}
