-- 0005: AI Model Hub (OpenRouter FREE-only catalogue, router, quotas, invocation audit) and
-- Content Studio (briefs → drafts → review → approval → export). Additive only.

-- Server-built allowlist of OpenRouter models. Only ":free" ids and the official "openrouter/free"
-- router are stored; every row keeps the full pricing snapshot used to decide eligibility.
CREATE TABLE ai_models (
  model_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider IN ('openrouter')),
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  context_length INTEGER NOT NULL DEFAULT 0,
  max_output INTEGER,
  input_modalities TEXT NOT NULL DEFAULT '[]',
  output_modalities TEXT NOT NULL DEFAULT '[]',
  endpoints TEXT NOT NULL DEFAULT '[]',
  supported_parameters TEXT NOT NULL DEFAULT '[]',
  pricing_json TEXT NOT NULL DEFAULT '{}',
  price_hash TEXT NOT NULL DEFAULT '',
  free_class TEXT NOT NULL CHECK (free_class IN ('verified','restricted','unknown','paid','incompatible','unavailable')),
  reasons TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  eligible INTEGER NOT NULL DEFAULT 0,
  expiration_date TEXT,
  source TEXT NOT NULL DEFAULT 'https://openrouter.ai/api/v1/models',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  removed_at TEXT,
  cooldown_until TEXT,
  health_status TEXT NOT NULL DEFAULT 'untested' CHECK (health_status IN ('untested','ok','failed')),
  health_checked_at TEXT,
  health_error TEXT
);
CREATE INDEX ai_models_eligible ON ai_models (eligible, free_class);

-- Catalogue change log (added / removed / price changed / blocked).
CREATE TABLE ai_model_changes (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added','removed','price_changed','blocked','restored')),
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ai_model_changes_time ON ai_model_changes (created_at);

-- Platform key/value state: sync metadata, kill switch, halt reason, key tier snapshot.
CREATE TABLE ai_platform_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Atomic quota counters (global OpenRouter key, per organization, per user) by window.
CREATE TABLE ai_quota_counters (
  scope TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (scope, window_key)
);

-- One row per model attempt (tenant scoped; organization_id NULL only for platform health checks).
-- No prompt or answer text is stored here.
CREATE TABLE ai_invocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT,
  request_ref TEXT NOT NULL,
  task TEXT NOT NULL,
  strategy TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  served_model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','failed','skipped','blocked')),
  error_code TEXT,
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  reported_cost_usd REAL,
  cost_state TEXT NOT NULL CHECK (cost_state IN ('zero_confirmed','zero_expected','estimated','billed','unknown')),
  is_fallback INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ai_invocations_org ON ai_invocations (organization_id, created_at);
CREATE INDEX ai_invocations_model ON ai_invocations (model, task, created_at);

-- Organization AI preferences (validated server-side against the allowlist).
CREATE TABLE organization_ai_preferences (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL DEFAULT 'automatic_free' CHECK (strategy IN ('automatic_free','manual_free','openrouter_free_router','cloudflare_only')),
  manual_model_id TEXT,
  fallback_policy TEXT NOT NULL DEFAULT 'auto' CHECK (fallback_policy IN ('auto','ask')),
  privacy_first INTEGER NOT NULL DEFAULT 0,
  openrouter_enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Content Studio.
CREATE TABLE content_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT, -- validated against brands(organization_id, id) in code
  kind TEXT NOT NULL CHECK (kind IN ('blog_article','landing_copy','faq_aeo','meta_tags','social_post','entity_summary')),
  title TEXT NOT NULL,
  keyword TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  brief_json TEXT NOT NULL DEFAULT '{}',
  body_md TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  provider TEXT,
  model TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  review_note TEXT,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id)
);
CREATE INDEX content_items_org ON content_items (organization_id, updated_at);

CREATE TABLE content_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  content_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai','human')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, content_id, version),
  FOREIGN KEY (organization_id, content_id) REFERENCES content_items(organization_id, id) ON DELETE CASCADE
);
