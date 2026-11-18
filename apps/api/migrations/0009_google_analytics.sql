-- 0009: Google Analytics 4 read-only ingest (F3). Additive only.

-- One GA4 connection per organization (race-safe connect).
CREATE UNIQUE INDEX idx_integrations_ga4_one_per_org ON integrations(organization_id, provider) WHERE provider = 'ga4';

-- GA4 properties the connected Google account can read (Admin API accountSummaries.list).
-- accessible = 0 when the account no longer lists the property; only one is selected for sync.
CREATE TABLE ga4_properties (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  property TEXT NOT NULL,            -- "properties/<numeric id>"
  display_name TEXT NOT NULL,
  account_name TEXT,
  accessible INTEGER NOT NULL DEFAULT 1,
  selected INTEGER NOT NULL DEFAULT 0,
  time_zone TEXT,                    -- reported by the Data API with each report
  currency_code TEXT,
  last_thresholded INTEGER NOT NULL DEFAULT 0,  -- last report subject to GA4 thresholding
  last_sampled INTEGER NOT NULL DEFAULT 0,      -- last report sampled by GA4
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property),
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations(organization_id, id) ON DELETE CASCADE
);

-- Observed daily metrics as returned by the Data API (date in the property's time zone).
CREATE TABLE ga4_daily_metrics (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  date TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  total_users INTEGER NOT NULL,
  screen_page_views INTEGER NOT NULL,
  engaged_sessions INTEGER NOT NULL,
  key_events REAL NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, property_id, date),
  FOREIGN KEY (organization_id, property_id) REFERENCES ga4_properties(organization_id, id) ON DELETE CASCADE
);

-- Observed totals for whole periods (users are de-duplicated by GA4, so they cannot be summed per day).
CREATE TABLE ga4_period_totals (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('current','previous')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  total_users INTEGER NOT NULL,
  screen_page_views INTEGER NOT NULL,
  engaged_sessions INTEGER NOT NULL,
  key_events REAL NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, property_id, period),
  FOREIGN KEY (organization_id, property_id) REFERENCES ga4_properties(organization_id, id) ON DELETE CASCADE
);

-- Top channels / landing pages for the current period (replaced on every sync).
CREATE TABLE ga4_top_rows (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('channel','landing_page')),
  key TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  total_users INTEGER NOT NULL,
  engaged_sessions INTEGER NOT NULL,
  key_events REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, property_id, dimension, key),
  FOREIGN KEY (organization_id, property_id) REFERENCES ga4_properties(organization_id, id) ON DELETE CASCADE
);
