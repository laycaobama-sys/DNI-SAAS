-- DNI Growth — F0 core schema (Cloudflare D1 / SQLite)
-- Tenant isolation model (see docs/adr/0003-tenant-isolation-d1.md):
--  * every tenant-scoped table has organization_id NOT NULL
--  * parents expose UNIQUE(organization_id, id); children reference (organization_id, x_id)
--    with composite foreign keys, so the DATABASE rejects cross-tenant links even if a UUID is guessed
--  * append-only tables (audit_logs, credit_ledger) are protected by triggers

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified_at TEXT,
  locale TEXT NOT NULL DEFAULT 'es-ES',
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid',
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Session tokens are stored only as SHA-256 hashes.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE email_tokens (
  id TEXT PRIMARY KEY, -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose);

-- Development-only mailbox (written ONLY when ENVIRONMENT=development and no mail provider is set).
CREATE TABLE dev_mailbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_eur_month REAL,
  limits_json TEXT NOT NULL,
  stripe_price_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  billing_customer_id TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  region TEXT NOT NULL DEFAULT 'EU',
  plan_code TEXT NOT NULL DEFAULT 'free' REFERENCES plans(code),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','marketing_manager','editor','analyst','ads_approver','ads_publisher','billing_admin','client_viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  invited_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_invitations_org ON invitations(organization_id, created_at DESC);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT,
  vertical TEXT,
  description TEXT,
  default_locale TEXT NOT NULL DEFAULT 'es-ES',
  default_currency TEXT NOT NULL DEFAULT 'EUR',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_brands_org ON brands(organization_id, created_at DESC);

CREATE TABLE brand_profiles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  missing_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  prohibited_claims_json TEXT NOT NULL DEFAULT '[]',
  competitors_json TEXT NOT NULL DEFAULT '[]',
  source_crawl_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  confirmed_at TEXT,
  confirmed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, brand_id),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  url TEXT NOT NULL,
  origin TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified')),
  verification_method TEXT,
  verified_at TEXT,
  crawl_policy_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, origin),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_configured',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  secret_ref TEXT, -- reference to a secret store entry; NEVER the secret itself
  account_ref TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','validating','running','awaiting_approval','completed','failed','cancelled')),
  idempotency_key TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  failure_code TEXT,
  retry_after TEXT,
  cost_estimate REAL NOT NULL DEFAULT 0,
  cost_actual REAL,
  actor_user_id TEXT REFERENCES users(id),
  cancel_requested_at TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id)
);
CREATE INDEX idx_jobs_org ON jobs(organization_id, created_at DESC);
CREATE INDEX idx_jobs_state ON jobs(state);

CREATE TABLE job_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data_redacted_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_job_events_job ON job_events(organization_id, job_id, created_at);

-- Transactional outbox: written in the same batch as business state; drained to the queue.
CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_outbox_pending ON outbox_events(status, available_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_redacted TEXT,
  after_redacted TEXT,
  ip_hash TEXT,
  request_id TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_org ON audit_logs(organization_id, created_at DESC);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
  WHEN (SELECT COUNT(*) FROM organizations WHERE id = OLD.organization_id) > 0
  BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES plans(code),
  provider TEXT NOT NULL DEFAULT 'internal',
  provider_sub_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','incomplete')),
  current_period_end TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Immutable credit ledger: reserve -> settle | release. Balance = SUM(amount).
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id TEXT,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT 'credit',
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('grant','reserve','settle','release','adjustment')),
  provider TEXT NOT NULL DEFAULT 'internal',
  source_event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs(organization_id, id)
);
CREATE INDEX idx_ledger_org ON credit_ledger(organization_id, created_at DESC);
CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger
  WHEN (SELECT COUNT(*) FROM organizations WHERE id = OLD.organization_id) > 0
  BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;

-- Webhook idempotency: provider event IDs are unique.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT,
  UNIQUE (provider, provider_event_id)
);
