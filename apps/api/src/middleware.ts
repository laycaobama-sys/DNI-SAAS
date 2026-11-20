import type { MiddlewareHandler } from "hono";
import { can, isPlanCode, isRole, moduleForApiPath, PLAN_LABEL, planIncludes, platformCan, requiredPlan, type PlatformScope, type Scope } from "@dni/core";
import type { AppEnv } from "./env";
import { ApiError, assertUuid, forbidden, notFound, unauthorized } from "./lib/http";
import { orgPlan } from "./lib/billing";
import { loadSession } from "./lib/session";
import { effectiveRole, platformAccess } from "./lib/platform";
import { scrubAi } from "./lib/scrub";

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
  // Public lead forms are posted from customers' own sites: no session is used there; each form checks
  // its own allowed origins, rate limits and anti-spam (routes/crm.ts).
  if (c.req.path.startsWith("/api/v1/public/")) return next();
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
  const [row, org] = await Promise.all([
    c.env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, user.id).first<{ role: string }>(),
    c.env.DB.prepare("SELECT status, status_reason, deleted_at, purge_after FROM organizations WHERE id = ?")
      .bind(orgId)
      .first<{ status: string; status_reason: string | null; deleted_at: string | null; purge_after: string | null }>(),
  ]);
  let role = row && isRole(row.role) ? row.role : null;
  let supportGrantId: string | undefined;
  if (!role) {
    // Temporary, audited support access (read-only) granted from the Platform Control Center.
    const g = await c.env.DB.prepare(
      "SELECT id FROM support_access_grants WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
    )
      .bind(orgId, user.id, new Date().toISOString())
      .first<{ id: string }>();
    if (g && effectiveRole(await platformAccess(c.env, user))) {
      role = "client_viewer";
      supportGrantId = g.id;
    }
  }
  if (!role || !org) throw notFound("Organización");
  const rel = c.req.path.replace(/^\/api\/v1\/orgs\/[^/]+/, "") || "/";
  if (org.deleted_at) {
    // Deleted organisations are recoverable for 30 days; only the restore endpoint stays reachable.
    if (!(rel === "/restore" && c.req.method === "POST") && !(rel === "/" && c.req.method === "GET"))
      throw new ApiError(410, "organization_deleted", "Esta organización está eliminada. Puede restaurarse hasta el " + (org.purge_after ?? "").slice(0, 10) + ".", { purgeAfter: org.purge_after });
  } else if (org.status === "suspended" && !(rel === "/" && c.req.method === "GET")) {
    throw new ApiError(423, "organization_suspended", "Esta organización está suspendida. Escribe a soporte para reactivarla.");
  }
  if (supportGrantId && c.req.method !== "GET" && c.req.method !== "HEAD") throw forbidden("El acceso de soporte es de solo lectura.");
  c.set("tenant", { orgId, userId: user.id, role, ...(supportGrantId ? { supportGrantId } : {}) });
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

/**
 * Platform staff with an effective role right now (see lib/platform.ts): an active platform member
 * whose session proved TOTP recently, or — only until the first owner is claimed — the legacy admin.
 */
export async function isPlatformAdmin(env: AppEnv["Bindings"], user: Parameters<typeof platformAccess>[1]): Promise<boolean> {
  return !!effectiveRole(await platformAccess(env, user));
}

/** Platform route guard: 404 for everyone outside the platform, 401 until the second factor is proved. */
export const requirePlatform =
  (scope: PlatformScope = "platform:overview"): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const u = c.get("user");
    if (!u) throw unauthorized();
    const a = await platformAccess(c.env, u);
    if (!a.legacy && !a.role) throw notFound("Recurso");
    if (a.role && a.status === "pending_mfa" && !a.legacy) throw new ApiError(401, "platform_enrolment_required", "Completa la activación del segundo factor para entrar.");
    const role = effectiveRole(a);
    if (!role) throw new ApiError(401, "platform_mfa_required", "Introduce el código de tu app de autenticación para entrar al Control Center.");
    if (!platformCan(role, scope)) throw forbidden("Tu rol de plataforma no permite esta acción.");
    return next();
  };
/** Back-compat alias used by existing admin routes. */
export const requirePlatformAdmin = requirePlatform("platform:overview");

/**
 * Step-up for critical actions (suspend, delete, plans, limits, kill switches, support access): the
 * session must have proved TOTP within the last 15 minutes. Not available in legacy mode.
 */
export const requireStepUp: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = await platformAccess(c.env, c.get("user") ?? null);
  if (!a.claimed) throw new ApiError(401, "platform_claim_required", "Vincula tu cuenta de propietario y activa el segundo factor para hacer esta acción.");
  if (!a.stepUpFresh) throw new ApiError(401, "step_up_required", "Por seguridad, vuelve a introducir el código de tu app de autenticación.");
  return next();
};

/**
 * Plan gate for whole modules (see MODULE_MIN_PLAN). Runs after requireMembership. Platform admins
 * keep full access so the owner can support any plan; everyone else gets 402 «plan_required».
 */
export const requirePlanModule: MiddlewareHandler<AppEnv> = async (c, next) => {
  const t = c.get("tenant");
  if (!t) throw unauthorized();
  const rel = c.req.path.replace(/^\/api\/v1\/orgs\/[^/]+/, "");
  const module = moduleForApiPath(rel, c.req.method);
  if (!module) return next();
  const plan = await orgPlan(c.env.DB, t.orgId);
  if (planIncludes(plan.code, module)) return next();
  if (await isPlatformAdmin(c.env, c.get("user") ?? null)) return next();
  const need = requiredPlan(module);
  throw new ApiError(402, "plan_required", `Este módulo está incluido desde el plan ${PLAN_LABEL[need]}. Tu plan actual es ${PLAN_LABEL[isPlanCode(plan.code) ? plan.code : "free"]}.`, {
    module,
    requiredPlan: need,
    currentPlan: plan.code,
  });
};

/**
 * «IA DNI Growth» privacy for customer workspaces: JSON answers are scrubbed of AI providers, models
 * and internal costs (lib/scrub.ts) unless the caller is platform staff with an unlocked session.
 */
export const aiPrivacy: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const type = c.res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return;
  if (await isPlatformAdmin(c.env, c.get("user") ?? null)) return;
  const body = await c.res.clone().json().catch(() => undefined);
  if (body === undefined) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  const keepEngineNames = /\/geo(\/|$)/.test(c.req.path);
  c.res = new Response(JSON.stringify(scrubAi(body, "", { keepEngineNames })), { status: c.res.status, headers });
};

/** Platform-only endpoints mounted inside a workspace (AI engine internals): 404 for customers. */
export const platformOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await isPlatformAdmin(c.env, c.get("user") ?? null))) throw notFound("Recurso");
  return next();
};
