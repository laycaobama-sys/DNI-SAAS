-- 0021 Phase 2, activation (ADR 0023). Additive only: new tables and one nullable column.
--
-- public_audits: free audit without an account (≤5 public pages, same deterministic rules as the full
-- analysis). It is not tenant data until someone claims it: an anonymous row keeps only the URL, the host,
-- the result and a salted hash of the IP (never the IP), and is deleted 30 days after creation by the cron.
-- When a signed-up user claims it, it is linked to their organisation and the IP hash is cleared.
CREATE TABLE public_audits (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL CHECK (length(url) <= 600),
  host TEXT NOT NULL CHECK (length(host) <= 253),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  ip_hash TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 32),
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) <= 100000),
  error_code TEXT,
  -- A competitor audit points at the audit it is compared with (/auditoria/{compare_of}?vs={id}); the
  -- compared audit itself is never modified, so a shared link cannot be changed by whoever receives it.
  compare_of TEXT REFERENCES public_audits(id) ON DELETE CASCADE,
  is_competitor INTEGER NOT NULL DEFAULT 0 CHECK (is_competitor IN (0, 1)),
  claimed_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_public_audits_host ON public_audits (host, created_at);
CREATE INDEX idx_public_audits_status ON public_audits (status, created_at);
CREATE INDEX idx_public_audits_expires ON public_audits (expires_at);
CREATE INDEX idx_public_audits_org ON public_audits (claimed_org_id);

-- Onboarding choices of each organisation (guided set-up). One row per organisation.
-- publishing_mode is the preference the user chose; autopilot is not active yet: everything stays a draft
-- that a person approves (see docs/BLOQUEOS.md and the onboarding screen).
CREATE TABLE organization_onboarding (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  publishing_mode TEXT CHECK (publishing_mode IS NULL OR publishing_mode IN ('approval', 'autopilot')),
  articles_per_week INTEGER CHECK (articles_per_week IS NULL OR articles_per_week BETWEEN 1 AND 7),
  skipped_json TEXT NOT NULL DEFAULT '[]' CHECK (length(skipped_json) <= 500),
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- Help emails after signup (24 h and 72 h). One row per user and kind: each is sent at most once.
CREATE TABLE lifecycle_emails (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('onboarding_24h', 'onboarding_72h')),
  status TEXT NOT NULL CHECK (status IN ('sent', 'skipped')),
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- One-click opt-out of the help emails (account emails such as password resets are not affected).
ALTER TABLE users ADD COLUMN lifecycle_emails_opt_out_at TEXT;
