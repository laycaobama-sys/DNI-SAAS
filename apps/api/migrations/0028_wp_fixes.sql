-- Technical fixes applied to the customer's WordPress through the «DNI Growth Connector» plugin.
-- One row per fix, claimed before the call (state 'applying'); the plugin keeps its own before/after log and
-- treats our id as an idempotency key, so a retry never applies a fix twice. Additive: a new table.
CREATE TABLE IF NOT EXISTS wp_fixes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('title', 'description', 'canonical', 'jsonld', 'alt', 'llms')),
  target_url TEXT,
  attachment_id INTEGER,
  post_id INTEGER,
  remote_fix_id TEXT,
  before_value TEXT,
  after_value TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applying', 'applied', 'failed', 'reverted')),
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reverted_by TEXT,
  reverted_at TEXT,
  UNIQUE (organization_id, id)
);
CREATE INDEX IF NOT EXISTS wp_fixes_org_created ON wp_fixes (organization_id, created_at DESC);
