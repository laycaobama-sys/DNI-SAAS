-- 0017 Platform Control Center (ADR 0019). Additive only.
--
-- Two authorisation domains: platform_* (DNI Growth staff) and organization memberships (customers).
-- Owning an organisation never grants anything here. The first platform_owner is bound to an already
-- verified account through a one-time claim code whose HASH is inserted by the titular with her own
-- Cloudflare login (scripts/platform-claim.mjs); the account must then enrol TOTP before it is active.

CREATE TABLE platform_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('platform_owner','platform_admin','platform_support','platform_finance','platform_security','platform_analyst','platform_ai_ops','platform_billing_ops','platform_readonly')),
  status TEXT NOT NULL DEFAULT 'pending_mfa' CHECK (status IN ('pending_mfa','active','disabled')),
  mfa_secret_enc TEXT,          -- AES-256-GCM envelope (DATA_ENC_KEY), never returned after enrolment
  mfa_enabled_at TEXT,
  mfa_last_step INTEGER,        -- last accepted TOTP time step (replay protection)
  recovery_hashes TEXT NOT NULL DEFAULT '[]', -- sha256 of single-use recovery codes
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at TEXT,
  created_by TEXT
);

CREATE TABLE platform_claim_codes (
  code_hash TEXT PRIMARY KEY,   -- sha256 of the one-time code; the code itself never touches the DB
  role TEXT NOT NULL DEFAULT 'platform_owner',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Step-up: when this session last proved the platform second factor.
ALTER TABLE sessions ADD COLUMN platform_mfa_at TEXT;

-- Organisation lifecycle: suspension and recoverable deletion (30 days).
ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organizations ADD COLUMN status_reason TEXT;
ALTER TABLE organizations ADD COLUMN status_changed_at TEXT;
ALTER TABLE organizations ADD COLUMN deleted_at TEXT;
ALTER TABLE organizations ADD COLUMN purge_after TEXT;

-- Per-organisation limit overrides decided by the platform (audited, optional expiry).
CREATE TABLE organization_limit_overrides (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  limit_key TEXT NOT NULL CHECK (limit_key IN ('ai_daily','ai_user_daily','ai_images_daily')),
  value INTEGER NOT NULL CHECK (value >= 0),
  reason TEXT NOT NULL,
  expires_at TEXT,
  set_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  PRIMARY KEY (organization_id, limit_key)
);

-- Temporary, audited support access to ONE organisation (read-only), never silent.
CREATE TABLE support_access_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  ticket TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_support_grants_org ON support_access_grants(organization_id, expires_at);
CREATE INDEX idx_support_grants_user ON support_access_grants(user_id, expires_at);
CREATE INDEX idx_orgs_status ON organizations(status, deleted_at);
CREATE INDEX idx_ai_invocations_user_day ON ai_invocations(user_id, created_at);
