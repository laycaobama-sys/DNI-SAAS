-- F5 landing pages (blocks, versions, publish), F7 A/B test on landings, F5 follow-up automations.
-- Additive only.
CREATE TABLE landing_pages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished', 'archived')),
  form_id TEXT REFERENCES lead_forms(id) ON DELETE SET NULL,
  noindex INTEGER NOT NULL DEFAULT 0,
  draft_version_id TEXT,
  published_version_id TEXT,
  -- A/B: variant B is another saved version; split = % of visitors that see B.
  experiment_status TEXT NOT NULL DEFAULT 'none' CHECK (experiment_status IN ('none', 'running', 'stopped')),
  variant_b_version_id TEXT,
  split_b INTEGER NOT NULL DEFAULT 50 CHECK (split_b BETWEEN 5 AND 95),
  experiment_started_at TEXT,
  experiment_hypothesis TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (organization_id, slug)
);
CREATE INDEX idx_landing_pages_org ON landing_pages(organization_id, status);

CREATE TABLE landing_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  landing_id TEXT NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (landing_id, version)
);
CREATE INDEX idx_landing_versions ON landing_versions(organization_id, landing_id, version);

-- Aggregated counts only (no cookies, no per-visitor rows). variant = 'A' or 'B'.
CREATE TABLE landing_stats_daily (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  landing_id TEXT NOT NULL REFERENCES landing_pages(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('A', 'B')),
  version_id TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (landing_id, day, variant, version_id)
);
CREATE INDEX idx_landing_stats_org ON landing_stats_daily(organization_id, landing_id);

-- Follow-up automations per lead form (configured and activated by owner/admin/marketing).
CREATE TABLE crm_automations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL REFERENCES lead_forms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('auto_reply', 'follow_up_task')),
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, form_id, kind)
);

CREATE TABLE crm_automation_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES crm_automations(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('done', 'scheduled', 'skipped', 'failed')),
  detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (automation_id, lead_id)
);
CREATE INDEX idx_crm_runs_org ON crm_automation_runs(organization_id, created_at);

ALTER TABLE leads ADD COLUMN landing_id TEXT;
ALTER TABLE leads ADD COLUMN landing_variant TEXT;

UPDATE plans SET limits_json = json_set(limits_json, '$.landingPages', 1)   WHERE code = 'free'    AND json_extract(limits_json, '$.landingPages') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.landingPages', 5)   WHERE code = 'starter' AND json_extract(limits_json, '$.landingPages') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.landingPages', 20)  WHERE code = 'growth'  AND json_extract(limits_json, '$.landingPages') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.landingPages', 50)  WHERE code = 'pro'     AND json_extract(limits_json, '$.landingPages') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.landingPages', 200) WHERE code = 'agency'  AND json_extract(limits_json, '$.landingPages') IS NULL;
