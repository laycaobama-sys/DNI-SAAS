import type { Role } from "@dni/core";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  JOBS_QUEUE?: Queue<JobMessage>;
  ENVIRONMENT: "development" | "staging" | "production" | "test";
  APP_ORIGIN: string;
  /** Secrets (wrangler secret put …). Never logged, never stored in D1. */
  IP_HASH_SALT?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
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
