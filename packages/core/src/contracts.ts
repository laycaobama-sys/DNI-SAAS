import { z } from "zod";
import { ROLES } from "./rbac";

/** Zod schemas shared by API (validation at the boundary) and web (typed client). */
export const EmailSchema = z.email().max(254).transform((e) => e.toLowerCase().trim());
export const PasswordSchema = z
  .string()
  .min(12, "Mínimo 12 caracteres")
  .max(128)
  .refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), "Incluye letras y números");

export const RegisterInput = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().trim().min(1).max(120),
});
export const LoginInput = z.object({ email: EmailSchema, password: z.string().min(1).max(128) });
export const TokenInput = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });
export const ResendInput = z.object({ email: EmailSchema });
export const ResetConfirmInput = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/), password: PasswordSchema });

export const CreateOrgInput = z.object({ name: z.string().trim().min(2).max(120) });
export const InviteInput = z.object({ email: EmailSchema, role: z.enum(ROLES) });
export const UpdateMemberInput = z.object({ role: z.enum(ROLES) });

export const CreateBrandInput = z.object({
  name: z.string().trim().min(1).max(120),
  domain: z.string().trim().max(253).optional(),
});

export const AnalyzeInput = z.object({
  url: z.string().trim().min(4).max(2048),
  brandId: z.uuid().optional(),
  brandName: z.string().trim().min(1).max(120).optional(),
});

const FactSchema = z.object({
  id: z.string().max(40),
  key: z.string().max(40),
  label: z.string().max(80),
  value: z.string().trim().min(1).max(500),
  sourceUrl: z.string().max(2048).nullable(),
  method: z.string().max(20),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["extracted", "edited", "rejected", "added"]),
});

export const UpdateBrandProfileInput = z.object({
  facts: z.array(FactSchema).max(200),
  audience: z.string().trim().max(2000).default(""),
  tone: z.string().trim().max(1000).default(""),
  objective: z.enum(["traffic", "leads", "sales", "reputation", ""]).default(""),
  prohibitedClaims: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  competitors: z.array(z.string().trim().min(3).max(253)).max(20).default([]),
});

export const UpdateTaskInput = z.object({
  status: z.enum(["todo", "doing", "done", "dismissed"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  week: z.number().int().min(1).max(4).optional(),
  estimateHours: z.number().min(0).max(200).optional(),
});

export const CheckoutInput = z.object({ planCode: z.enum(["starter", "growth", "pro", "agency"]) });

// Strict: the client can never inject a model id, provider, price, endpoint or credit amount.
export const AdvisorInput = z.strictObject({
  question: z.string().trim().min(2, "Escribe tu pregunta.").max(2000),
  conversationId: z.uuid().optional(),
  brandId: z.uuid().optional(),
  /** Explicit consent to use automatic fallback after a manually selected free model failed. */
  allowFallback: z.boolean().optional(),
});

export const ImageInput = z.strictObject({
  prompt: z.string().trim().min(5, "Describe la imagen (mínimo 5 caracteres).").max(1000),
  format: z.enum(["square", "landscape", "portrait"]).default("square"),
});

/** Organization AI preferences. Model ids are re-validated server-side against the allowlist. */
export const AiPreferencesInput = z.strictObject({
  strategy: z.enum(["automatic_free", "manual_free", "openrouter_free_router", "cloudflare_only"]),
  manualModelId: z.string().trim().max(120).regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i, "Modelo no válido.").nullable().optional(),
  fallbackPolicy: z.enum(["auto", "ask"]).default("auto"),
  privacyFirst: z.boolean().default(false),
  openrouterEnabled: z.boolean().default(true),
});

export const CONTENT_KINDS = ["blog_article", "landing_copy", "faq_aeo", "meta_tags", "social_post", "entity_summary"] as const;
export const ContentCreateInput = z.strictObject({
  kind: z.enum(CONTENT_KINDS),
  title: z.string().trim().min(3, "Escribe un título o tema.").max(160),
  keyword: z.string().trim().max(120).default(""),
  audience: z.string().trim().max(300).default(""),
  angle: z.string().trim().max(600).default(""),
  sources: z.string().trim().max(3000).default(""),
  brandId: z.uuid().optional(),
});
export const ContentUpdateInput = z.strictObject({
  title: z.string().trim().min(3).max(160).optional(),
  bodyMd: z.string().max(60_000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export const ContentReviewInput = z.strictObject({ note: z.string().trim().max(1000).default("") });

/** Measurement types required by CLAUDE.md for every metric. */
export type Measurement = "observed" | "derived" | "estimated" | "demo";
export interface Metric<T = number> {
  metric: string;
  value: T;
  unit: string;
  measurement: Measurement;
  source: string;
  observedAt: string;
  period?: { start: string; end: string } | null;
  limitations: string[];
}

/** Commercial plans (hypothesis from PRD §9 — configurable, not hard-coded in UI). */
export interface PlanDef {
  code: string;
  name: string;
  priceEurMonth: number | null;
  limits: { brands: number; seats: number; analysesPerMonth: number; pagesPerCrawl: number; monthlyCredits: number; trackedPrompts?: number; leadForms?: number; landingPages?: number; clientOrgs?: number; automationRules?: number; videoProjects?: number; backlinks?: number };
}

export type ProviderStatus = "not_configured" | "available" | "connected" | "reauth_required" | "disconnected" | "error" | "demo" | "blocked_external_approval" | "planned";
export interface ProviderManifestEntry {
  key: string;
  name: string;
  category: string;
  phase: string;
  status: ProviderStatus;
  note: string;
}
