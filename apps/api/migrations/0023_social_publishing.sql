-- Facebook Pages + Instagram publishing (Meta Graph API). Additive only.
-- One Meta connection per organization (integrations.provider = 'meta'); its long-lived user token is an
-- AES-256-GCM envelope in integration_secrets. Each Page / Instagram account keeps its own Page token as an
-- envelope bound to organization + account (a row copied to another tenant cannot be decrypted).
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_meta_one_per_org ON integrations(organization_id, provider) WHERE provider = 'meta';

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('facebook', 'instagram')),
  external_id TEXT NOT NULL CHECK (length(external_id) <= 40),
  page_id TEXT NOT NULL CHECK (length(page_id) <= 40),
  name TEXT NOT NULL CHECK (length(name) <= 200),
  username TEXT CHECK (username IS NULL OR length(username) <= 100),
  token_enc TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'reauth_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, network, external_id),
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_social_accounts_org ON social_accounts(organization_id, status);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '' CHECK (length(caption) <= 5000),
  link TEXT CHECK (link IS NULL OR length(link) <= 2000),
  media_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'publishing', 'published', 'failed', 'cancelled')),
  scheduled_at TEXT,
  created_by TEXT,
  submitted_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  review_note TEXT CHECK (review_note IS NULL OR length(review_note) <= 500),
  container_id TEXT,
  external_id TEXT,
  external_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 300),
  publishing_started_at TEXT,
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, account_id) REFERENCES social_accounts(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_social_posts_org ON social_posts(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts(status, scheduled_at);
