-- 0008: Google Search Console (F3). Additive only.

-- OAuth state rows for integration connects are bound to the org and user that started them.
ALTER TABLE oauth_states ADD COLUMN organization_id TEXT;
ALTER TABLE oauth_states ADD COLUMN user_id TEXT;

-- One Search Console connection per organization (race-safe connect).
CREATE UNIQUE INDEX idx_integrations_gsc_one_per_org ON integrations(organization_id, provider) WHERE provider = 'google_search_console';

-- Encrypted credentials. integrations.secret_ref = 'integration_secrets:<id>'. The ciphertext is an
-- AES-256-GCM envelope (DATA_ENC_KEY) whose AAD binds organization + integration, so a row copied
-- to another tenant cannot be decrypted. Plain tokens never touch the database or the logs.
CREATE TABLE integration_secrets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, integration_id),
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations(organization_id, id) ON DELETE CASCADE
);

-- Properties the connected Google account can read (sites.list). Only one is selected for sync.
CREATE TABLE gsc_properties (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  site_url TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, site_url),
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations(organization_id, id) ON DELETE CASCADE
);

-- Observed daily totals as returned by the Search Analytics API (dataState=final).
CREATE TABLE gsc_daily_metrics (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, property_id, date),
  FOREIGN KEY (organization_id, property_id) REFERENCES gsc_properties(organization_id, id) ON DELETE CASCADE
);

-- Top queries/pages for the last synced period (replaced on every sync).
CREATE TABLE gsc_top_rows (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('query','page')),
  key TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, property_id, dimension, key),
  FOREIGN KEY (organization_id, property_id) REFERENCES gsc_properties(organization_id, id) ON DELETE CASCADE
);
