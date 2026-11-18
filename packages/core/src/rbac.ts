/**
 * Role-based access control. Roles come from CLAUDE.md "Product roles".
 * Permissions are action scopes; every API route declares the scope it needs.
 * Platform SuperAdmin is NOT an organization role and is never granted through memberships.
 */
export const ROLES = [
  "owner",
  "admin",
  "marketing_manager",
  "editor",
  "analyst",
  "ads_approver",
  "ads_publisher",
  "billing_admin",
  "client_viewer",
] as const;
export type Role = (typeof ROLES)[number];

export const SCOPES = [
  "org:read",
  "org:update",
  "org:delete",
  "members:read",
  "members:invite",
  "members:manage",
  "audit:read",
  "brand:read",
  "brand:write",
  "brand:confirm",
  "site:analyze",
  "audit_results:read",
  "jobs:read",
  "jobs:control",
  "plan:read",
  "plan:write",
  "content:read",
  "content:write",
  "content:approve",
  "content:publish",
  "ads:draft",
  "ads:approve",
  "ads:publish",
  "ads:emergency_stop",
  "billing:read",
  "billing:manage",
  "integrations:read",
  "integrations:manage",
  "ai:use",
  "creative:generate",
  "ai:configure",
  "crm:read",
  "crm:write",
  "crm:delete",
  "forms:manage",
  "landings:write",
  "landings:publish",
] as const;
export type Scope = (typeof SCOPES)[number];

const READ_BASE: Scope[] = [
  "org:read",
  "brand:read",
  "audit_results:read",
  "jobs:read",
  "plan:read",
  "content:read",
];

const MATRIX: Record<Role, readonly Scope[]> = {
  owner: SCOPES,
  admin: SCOPES.filter((s) => s !== "org:delete" && s !== "billing:manage"),
  marketing_manager: [
    ...READ_BASE,
    "members:read",
    "brand:write",
    "brand:confirm",
    "site:analyze",
    "jobs:control",
    "plan:write",
    "content:write",
    "content:approve",
    "ads:draft",
    "integrations:read",
    "ai:use",
    "creative:generate",
    "ai:configure",
    "crm:read",
    "crm:write",
    "forms:manage",
    "landings:write",
    "landings:publish",
  ],
  editor: [...READ_BASE, "members:read", "brand:write", "site:analyze", "jobs:control", "plan:write", "content:write", "ads:draft", "ai:use", "creative:generate", "landings:write"],
  analyst: [...READ_BASE, "members:read", "integrations:read", "ai:use"],
  ads_approver: [...READ_BASE, "ads:draft", "ads:approve", "ads:emergency_stop"],
  ads_publisher: [...READ_BASE, "ads:publish"],
  billing_admin: ["org:read", "billing:read", "billing:manage", "members:read"],
  client_viewer: READ_BASE,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, scope: Scope): boolean {
  return MATRIX[role].includes(scope);
}

export function scopesFor(role: Role): Scope[] {
  return [...MATRIX[role]];
}

/** Hierarchy used only to decide who may assign which role. */
const RANK: Record<Role, number> = {
  owner: 100,
  admin: 80,
  marketing_manager: 60,
  billing_admin: 50,
  ads_approver: 50,
  ads_publisher: 40,
  editor: 40,
  analyst: 30,
  client_viewer: 10,
};

/** An actor may grant a role only if it is strictly below their own rank (owners may grant owner). */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (actor === "owner") return true;
  if (!can(actor, "members:manage") && !can(actor, "members:invite")) return false;
  return RANK[target] < RANK[actor];
}

export const ROLE_LABELS_ES: Record<Role, string> = {
  owner: "Propietario",
  admin: "Administrador",
  marketing_manager: "Marketing Manager",
  editor: "Editor",
  analyst: "Analista",
  ads_approver: "Aprobador de Ads",
  ads_publisher: "Publicador de Ads",
  billing_admin: "Admin. facturación",
  client_viewer: "Cliente (lectura)",
};
