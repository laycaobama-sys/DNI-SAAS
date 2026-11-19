-- F2 keywords/competition/backlinks, F5 automation engine + signed webhooks, F4 video projects,
-- F6 ads drafts with Spend Guardian, F8 agency clients + white label. Additive only.

-- ── F2 Keywords (own data, never invented volumes) ──────────────────────────────────────────────
CREATE TABLE keyword_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  keyword_norm TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'unclear' CHECK (intent IN ('informational','commercial','transactional','navigational','unclear')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gsc','competitor','site')),
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea','planned','covered','discarded')),
  target_url TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, keyword_norm)
);
CREATE INDEX idx_keyword_items_org ON keyword_items(organization_id, status);

CREATE TABLE competitor_pages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  status_code INTEGER,
  title TEXT,
  description TEXT,
  headings_json TEXT NOT NULL DEFAULT '[]',
  terms_json TEXT NOT NULL DEFAULT '[]',
  word_count INTEGER,
  json_ld_types TEXT,
  fetched_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE (organization_id, url)
);

CREATE TABLE backlinks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_host TEXT NOT NULL,
  target_url TEXT NOT NULL,
  anchor_expected TEXT,
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','live','lost','error','blocked')),
  rel TEXT,
  anchor_found TEXT,
  http_status INTEGER,
  last_checked_at TEXT,
  first_live_at TEXT,
  notes TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','csv')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, source_url, target_url)
);
CREATE INDEX idx_backlinks_org ON backlinks(organization_id, status);

-- ── F5 Automation engine (rules → actions, dry-run, logs, retries) ─────────────────────────────
CREATE TABLE automation_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('lead_created','stage_changed','task_overdue')),
  conditions_json TEXT NOT NULL DEFAULT '[]',
  actions_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  webhook_secret_enc TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_automation_rules_org ON automation_rules(organization_id, trigger, enabled);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('done','skipped','failed','dry_run','partial')),
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (rule_id, trigger_ref)
);
CREATE INDEX idx_automation_runs_org ON automation_runs(organization_id, created_at);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES automation_rules(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, event_id, url)
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

ALTER TABLE crm_tasks ADD COLUMN overdue_notified_at TEXT;

-- ── F4 Video Studio (projects edited and rendered in the browser) ─────────────────────────────
CREATE TABLE video_projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT,
  name TEXT NOT NULL,
  aspect TEXT NOT NULL DEFAULT '9:16' CHECK (aspect IN ('9:16','1:1','4:5','16:9')),
  project_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','exported','archived')),
  last_export_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_video_projects_org ON video_projects(organization_id, updated_at);

CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','audio')),
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  name TEXT NOT NULL,
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_media_uploads_org ON media_uploads(organization_id, created_at);

-- ── F6 Ads Manager: drafts only, approval, Spend Guardian (proposed budgets, never spent) ───────
CREATE TABLE ad_campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('meta','google','tiktok','linkedin')),
  objective TEXT NOT NULL CHECK (objective IN ('leads','traffic','awareness','sales')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','approved','changes_requested','archived')),
  daily_budget_cents INTEGER NOT NULL,
  start_date TEXT,
  end_date TEXT,
  audience_json TEXT NOT NULL DEFAULT '{}',
  landing_id TEXT,
  destination_url TEXT,
  utm_campaign TEXT,
  notes TEXT,
  review_note TEXT,
  submitted_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_ad_campaigns_org ON ad_campaigns(organization_id, status);

CREATE TABLE ad_creatives (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('1:1','4:5','9:16','16:9')),
  headline TEXT NOT NULL,
  primary_text TEXT NOT NULL,
  description TEXT,
  cta TEXT NOT NULL,
  media_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE spend_guardian (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  max_daily_cents INTEGER NOT NULL DEFAULT 0,
  max_campaign_daily_cents INTEGER NOT NULL DEFAULT 0,
  kill_switch INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- ── F8 Agency: client organisations + white label ─────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN agency_org_id TEXT;
CREATE INDEX idx_org_agency ON organizations(agency_org_id);

CREATE TABLE org_branding (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  display_name TEXT,
  logo_url TEXT,
  accent TEXT,
  report_footer TEXT,
  support_email TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

UPDATE plans SET limits_json = json_set(limits_json, '$.clientOrgs', 0)  WHERE code IN ('free','starter','growth') AND json_extract(limits_json, '$.clientOrgs') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.clientOrgs', 5)  WHERE code = 'pro'    AND json_extract(limits_json, '$.clientOrgs') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.clientOrgs', 50) WHERE code = 'agency' AND json_extract(limits_json, '$.clientOrgs') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.automationRules', 2)   WHERE code = 'free'    AND json_extract(limits_json, '$.automationRules') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.automationRules', 10)  WHERE code = 'starter' AND json_extract(limits_json, '$.automationRules') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.automationRules', 30)  WHERE code = 'growth'  AND json_extract(limits_json, '$.automationRules') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.automationRules', 100) WHERE code = 'pro'     AND json_extract(limits_json, '$.automationRules') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.automationRules', 300) WHERE code = 'agency'  AND json_extract(limits_json, '$.automationRules') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.videoProjects', 2)   WHERE code = 'free'    AND json_extract(limits_json, '$.videoProjects') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.videoProjects', 20)  WHERE code = 'starter' AND json_extract(limits_json, '$.videoProjects') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.videoProjects', 60)  WHERE code = 'growth'  AND json_extract(limits_json, '$.videoProjects') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.videoProjects', 200) WHERE code = 'pro'     AND json_extract(limits_json, '$.videoProjects') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.videoProjects', 600) WHERE code = 'agency'  AND json_extract(limits_json, '$.videoProjects') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.backlinks', 50)    WHERE code = 'free'    AND json_extract(limits_json, '$.backlinks') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.backlinks', 500)   WHERE code = 'starter' AND json_extract(limits_json, '$.backlinks') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.backlinks', 2000)  WHERE code = 'growth'  AND json_extract(limits_json, '$.backlinks') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.backlinks', 10000) WHERE code = 'pro'     AND json_extract(limits_json, '$.backlinks') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.backlinks', 50000) WHERE code = 'agency'  AND json_extract(limits_json, '$.backlinks') IS NULL;
