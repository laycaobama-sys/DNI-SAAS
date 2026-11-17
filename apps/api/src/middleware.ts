import type { MiddlewareHandler } from "hono";
import { can, isRole, type Scope } from "@dni/core";
import type { AppEnv } from "./env";
import { ApiError, assertUuid, forbidden, notFound, unauthorized } from "./lib/http";
import { loadSession } from "./lib/session";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("cf-ray") ?? "";
  c.set("requestId", `${crypto.randomUUID().slice(0, 8)}${incoming ? `-${incoming.slice(0, 16)}` : ""}`);
  await next();
  c.header("x-request-id", c.get("requestId"));
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("x-frame-options", "DENY");
  c.header("cache-control", c.res.headers.get("cache-control") ?? "no-store");
  if (c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test") {
    c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
};

/**
 * CSRF defence for cookie-authenticated, state-changing requests:
 *  - require a custom header (cannot be set cross-site without a CORS preflight, which we never allow)
 *  - if an Origin header is present it must be our own origin
 * Webhooks are exempt (authenticated by signature instead).
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || c.req.path.startsWith("/api/v1/webhooks/")) return next();
  if (c.req.header("x-dni-csrf") !== "1") throw new ApiError(403, "csrf", "Petición rechazada (CSRF).");
  const origin = c.req.header("origin");
  if (origin) {
    const allowed = new Set([new URL(c.req.url).origin, c.env.APP_ORIGIN]);
    if (!allowed.has(origin)) throw new ApiError(403, "csrf", "Origen no permitido.");
  }
  return next();
};

export const session: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", await loadSession(c));
  return next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = c.get("user");
  if (!u) throw unauthorized();
  if (!u.emailVerified) throw new ApiError(403, "email_not_verified", "Verifica tu correo electrónico para continuar.");
  return next();
};

/**
 * Resolves the tenant from the :orgId path segment and the AUTHENTICATED membership.
 * organization_id is never taken from the body. Non-members get 404 (no org enumeration).
 */
export const requireMembership: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) throw unauthorized();
  const orgId = assertUuid(c.req.param("orgId"), "Organización");
  const row = await c.env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'")
    .bind(orgId, user.id)
    .first<{ role: string }>();
  if (!row || !isRole(row.role)) throw notFound("Organización");
  c.set("tenant", { orgId, userId: user.id, role: row.role });
  return next();
};

export const requireScope =
  (scope: Scope): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const t = c.get("tenant");
    if (!t) throw unauthorized();
    if (!can(t.role, scope)) throw forbidden();
    return next();
  };
