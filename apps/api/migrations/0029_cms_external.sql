-- Publishing approved content to Ghost (Admin API key) and to a generic signed webhook. Additive only.
-- One connection per organization and provider (integrations.provider = 'ghost' | 'cms_webhook'); the key or
-- the webhook secret is an AES-256-GCM envelope in integration_secrets bound to organization + integration.
-- cms_publications keeps WordPress only (its CHECK cannot change without rebuilding it), so these go here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_cms_external_one_per_org ON integrations(organization_id, provider) WHERE provider IN ('ghost', 'cms_webhook');

CREATE TABLE IF NOT EXISTS cms_external_publications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  content_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('ghost', 'webhook')),
  state TEXT NOT NULL CHECK (state IN ('publishing', 'published', 'draft', 'unpublished', 'failed')),
  external_id TEXT CHECK (external_id IS NULL OR length(external_id) <= 40),
  external_url TEXT CHECK (external_url IS NULL OR length(external_url) <= 600),
  content_version INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 400),
  published_by TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, content_id, provider),
  FOREIGN KEY (organization_id, content_id) REFERENCES content_items(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, integration_id) REFERENCES integrations(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cms_external_publications_org ON cms_external_publications(organization_id, updated_at);
