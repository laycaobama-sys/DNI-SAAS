import type { Role } from "@dni/core";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  JOBS_QUEUE?: Queue<JobMessage>;
  ENVIRONMENT: "development" | "staging" | "production" | "test";
  APP_ORIGIN: string;
  /** Cloudflare Email Service `send_email` binding (requires an onboarded sending domain). */
  EMAIL?: SendEmail;
  /** Workers AI binding. */
  AI?: Ai;
  /** R2 bucket for generated media (media/<organization_id>/<id>.png). */
  MEDIA?: R2Bucket;
  /** Vars (wrangler.jsonc). */
  MAIL_FROM?: string;
  MAIL_REPLY_TO?: string;
  /** "true" only once the sending domain is onboarded in Email Service. */
  EMAIL_SENDING_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Stripe stays off until the owner decides: "true" enables checkout/webhook. */
  BILLING_ENABLED?: string;
  /** Platform daily ceiling (USD, estimated) for paid AI usage. Default 0.10 ≈ Workers AI free allocation. */
  AI_DAILY_BUDGET_USD?: string;
  /** Secrets (wrangler secret put …). Never logged, never stored in D1. */
  IP_HASH_SALT?: string;
  DATA_ENC_KEY?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export interface JobMessage {
  jobId: string;
  organizationId: string;
  outboxId: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  sessionId: string;
}

export interface Tenant {
  orgId: string;
  userId: string;
  role: Role;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    user: SessionUser | null;
    tenant: Tenant;
    deps: Deps;
  };
};

/** Injected side-effect dependencies (real in the Worker, fakes in tests). */
export interface Deps {
  fetchImpl: typeof fetch;
  resolve: (hostname: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
}
