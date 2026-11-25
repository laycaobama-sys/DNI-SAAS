-- Search Console page rows for the 28 days BEFORE the current period (replaced on every sync).
-- Used only to show the customer which of their pages lose clicks (deterministic, never sent to an AI model).
-- Additive: a new table; nothing existing changes.
CREATE TABLE gsc_page_prev (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  key TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, property_id, key),
  FOREIGN KEY (organization_id, property_id) REFERENCES gsc_properties(organization_id, id) ON DELETE CASCADE
);
