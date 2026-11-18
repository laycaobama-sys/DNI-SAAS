-- F3 GEO: prompt library (what to ask AI engines, per brand). Additive only.
-- No answers are stored here: sampling (ai_response_samples) comes in a later migration and only
-- through each provider's permitted mechanism.
CREATE TABLE tracked_prompts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  question TEXT NOT NULL,
  question_norm TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('educational','comparative','transactional')),
  category TEXT NOT NULL CHECK (category IN ('brand','product','sector','geography')),
  engine TEXT NOT NULL,
  locale TEXT NOT NULL,
  region_country TEXT NOT NULL,
  region_detail TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','suggestion','import')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_tracked_prompts_brand ON tracked_prompts(organization_id, brand_id, archived_at, created_at DESC);
-- One active row per question × engine × language × country for a brand (archived rows do not count).
CREATE UNIQUE INDEX idx_tracked_prompts_unique_active
  ON tracked_prompts(organization_id, brand_id, question_norm, engine, locale, region_country)
  WHERE archived_at IS NULL;

-- Plan limit: active tracked prompt rows (question × engine) per organization.
UPDATE plans SET limits_json = json_set(limits_json, '$.trackedPrompts', 10)   WHERE code = 'free'    AND json_extract(limits_json, '$.trackedPrompts') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.trackedPrompts', 50)   WHERE code = 'starter' AND json_extract(limits_json, '$.trackedPrompts') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.trackedPrompts', 150)  WHERE code = 'growth'  AND json_extract(limits_json, '$.trackedPrompts') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.trackedPrompts', 400)  WHERE code = 'pro'     AND json_extract(limits_json, '$.trackedPrompts') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.trackedPrompts', 1500) WHERE code = 'agency'  AND json_extract(limits_json, '$.trackedPrompts') IS NULL;
