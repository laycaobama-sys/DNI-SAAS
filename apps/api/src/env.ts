import type { Role } from "@dni/core";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  JOBS_QUEUE?: Queue<QueueMessage>;
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
  /** Max real emails per month (default 2500, under the 3,000 included in Workers Paid). */
  EMAIL_MONTHLY_CAP?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Meta app (Facebook Login for Business) for Facebook Pages + Instagram publishing. Public id. */
  META_APP_ID?: string;
  /** Optional Facebook Login for Business configuration id (public); without it the scope list is sent. */
  META_LOGIN_CONFIG_ID?: string;
  /** Organisation whose approved articles can be published at APP_ORIGIN/blog (the site owner's own org). */
  SITE_BLOG_ORG_ID?: string;
  /** Stripe stays off until the owner decides: "true" enables checkout/webhook. */
  BILLING_ENABLED?: string;
  /** OpenRouter FREE-only policy (fail-closed: any other value disables OpenRouter). */
  OPENROUTER_FREE_ONLY?: string;
  ALLOW_PAID_MODELS?: string;
  OPENROUTER_MAX_SPEND_USD?: string;
  /** Shared free-model request budget of the single OpenRouter key (all tenants together). */
  OPENROUTER_DAILY_REQUESTS?: string;
  OPENROUTER_RPM?: string;
  OPENROUTER_ORG_DAILY?: string;
  OPENROUTER_USER_DAILY?: string;
  /** Secret: comma-separated platform admin emails (verified accounts only). */
  PLATFORM_ADMIN_EMAILS?: string;
  /** Platform daily ceiling (USD, estimated) for paid AI usage. Default 0.10 ≈ Workers AI free allocation. */
  AI_DAILY_BUDGET_USD?: string;
  /** Secrets (wrangler secret put …). Never logged, never stored in D1. */
  IP_HASH_SALT?: string;
  DATA_ENC_KEY?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Meta app secret (wrangler secret put META_APP_SECRET). Never logged, never sent to the browser. */
  META_APP_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** Optional free Groq key (secret). If present, Groq is the first free fallback after Workers AI. */
  GROQ_API_KEY?: string;
  /** Own daily cap for Groq requests (default 1000, below the free plan limits). */
  GROQ_DAILY_REQUESTS?: string;
  /** Override of the Groq chat model (default openai/gpt-oss-20b, free plan). */
  GROQ_TEXT_MODEL?: string;
  /** Id of the lead form (DNI Growth organisation) behind the contact form on dnigrowth.com. */
  SITE_CONTACT_FORM_ID?: string;
  /** Gemini model for text fallback (free tier) and its own daily cap (default 100, leaves room for the GEO monitor). */
  GEMINI_TEXT_MODEL?: string;
  GEMINI_TEXT_DAILY?: string;
  /** Optional: put this catalogued Workers AI text model first. */
  WORKERS_AI_TEXT_MODEL?: string;
  /** GEO monitor caps (Gemini free tier). Defaults: 150/day platform, 40/day per organization, 20 per run, 4.5 s between calls. */
  GEO_SAMPLES_DAILY_GLOBAL?: string;
  GEO_SAMPLES_DAILY_ORG?: string;
  GEO_RUN_MAX?: string;
  GEO_SPACING_MS?: string;
  /** Gemini model for the GEO monitor (free tier). Plain var, not a secret. */
  GEMINI_MODEL?: string;
  /** Optional free model used when the main one is overloaded (5xx). */
  GEMINI_FALLBACK_MODEL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export interface JobMessage {
  jobId: string;
  organizationId: string;
  outboxId: string;
}

/** Everything the jobs queue carries: organisation jobs, and free audits without an account (jobs/public-audit.ts). */
export type QueueMessage = JobMessage | { kind: "public_audit"; auditId: string };

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  sessionId: string;
  /** When this session last proved the platform second factor (platform staff only). */
  platformMfaAt?: string | null;
}

export interface Tenant {
  orgId: string;
  userId: string;
  role: Role;
  /** Set when the access comes from a temporary, audited support grant (read-only), not a membership. */
  supportGrantId?: string;
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
