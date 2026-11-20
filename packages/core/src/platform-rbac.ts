/**
 * Platform (DNI Growth staff) authorisation. A SEPARATE domain from organisation roles: no organisation
 * role maps to any of these, and these grant nothing inside a customer's workspace (content access goes
 * through a temporary, audited support grant).
 */
export const PLATFORM_ROLES = [
  "platform_owner",
  "platform_admin",
  "platform_support",
  "platform_finance",
  "platform_security",
  "platform_analyst",
  "platform_ai_ops",
  "platform_billing_ops",
  "platform_readonly",
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  platform_owner: "Propietario de la plataforma",
  platform_admin: "Administrador de plataforma",
  platform_support: "Soporte",
  platform_finance: "Finanzas",
  platform_security: "Seguridad",
  platform_analyst: "Analista",
  platform_ai_ops: "Operaciones de IA",
  platform_billing_ops: "Operaciones de facturación",
  platform_readonly: "Solo lectura",
};

export const PLATFORM_SCOPES = [
  "platform:overview",
  "platform:orgs:read",
  "platform:orgs:manage", // rename, suspend, delete/restore, plan, limits
  "platform:users:read",
  "platform:users:manage",
  "platform:ai:read",
  "platform:ai:control", // kill switches, model sync, provider tests
  "platform:billing:read",
  "platform:billing:manage",
  "platform:support", // temporary read-only access to one organisation
  "platform:ops:read",
  "platform:ops:control", // retry / cancel jobs
  "platform:audit:read",
  "platform:members:manage",
] as const;
export type PlatformScope = (typeof PLATFORM_SCOPES)[number];

const ALL = [...PLATFORM_SCOPES];
const READ = ["platform:overview", "platform:orgs:read", "platform:users:read", "platform:ai:read", "platform:billing:read", "platform:ops:read", "platform:audit:read"] as const;

export const PLATFORM_ROLE_SCOPES: Record<PlatformRole, readonly PlatformScope[]> = {
  platform_owner: ALL,
  platform_admin: ALL.filter((s) => s !== "platform:members:manage"),
  platform_support: ["platform:overview", "platform:orgs:read", "platform:users:read", "platform:support", "platform:ops:read"],
  platform_finance: ["platform:overview", "platform:orgs:read", "platform:billing:read", "platform:billing:manage"],
  platform_security: ["platform:overview", "platform:orgs:read", "platform:users:read", "platform:users:manage", "platform:audit:read", "platform:ops:read"],
  platform_analyst: ["platform:overview", "platform:orgs:read", "platform:ai:read", "platform:billing:read"],
  platform_ai_ops: ["platform:overview", "platform:ai:read", "platform:ai:control", "platform:ops:read"],
  platform_billing_ops: ["platform:overview", "platform:orgs:read", "platform:billing:read", "platform:billing:manage"],
  platform_readonly: READ,
};

export function isPlatformRole(v: string): v is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(v);
}

export function platformCan(role: string | null | undefined, scope: PlatformScope): boolean {
  return !!role && isPlatformRole(role) && PLATFORM_ROLE_SCOPES[role].includes(scope);
}

/** A platform session must have proved the second factor within this window… */
export const PLATFORM_MFA_TTL_SECONDS = 12 * 3600;
/** …and critical actions (suspend, delete, plan, limits, kill switch, support access) within this one. */
export const PLATFORM_STEP_UP_SECONDS = 15 * 60;
