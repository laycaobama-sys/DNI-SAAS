-- F5 · Lead capture + CRM (additive only).
-- lead_forms: public capture forms of an organisation (embeddable on its own site).
-- leads: one row per person and organisation (dedup by normalised email), consent per purpose,
--        UTM attribution, pipeline stage, owner and value. Personal data: only what the form asks.
-- lead_events: immutable history (submissions, stage/assignee/value changes, notes, tasks).
-- crm_tasks: follow-up tasks with due date and assignee.
CREATE TABLE lead_forms (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  -- Text shown next to the mandatory checkbox; a snapshot is stored with each consent.
  consent_text TEXT NOT NULL,
  -- Optional second, unticked checkbox (commercial communications).
  marketing_text TEXT,
  privacy_url TEXT,
  success_message TEXT NOT NULL,
  redirect_url TEXT,
  allowed_origins_json TEXT NOT NULL DEFAULT '[]',
  ask_phone INTEGER NOT NULL DEFAULT 1,
  ask_company INTEGER NOT NULL DEFAULT 1,
  notify INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  submissions INTEGER NOT NULL DEFAULT 0,
  spam_blocked INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_lead_forms_org ON lead_forms(organization_id, status);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  form_id TEXT REFERENCES lead_forms(id) ON DELETE SET NULL,
  brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  message TEXT,
  source TEXT NOT NULL DEFAULT 'form' CHECK (source IN ('form', 'manual')),
  source_url TEXT,
  referrer_host TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  lost_reason TEXT,
  value_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'EUR',
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  consent_contact INTEGER NOT NULL DEFAULT 0,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  consent_text TEXT,
  marketing_text TEXT,
  consent_at TEXT,
  submissions INTEGER NOT NULL DEFAULT 1,
  is_test INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_submitted_at TEXT,
  stage_changed_at TEXT
);
CREATE UNIQUE INDEX uq_leads_org_email ON leads(organization_id, email_norm);
CREATE INDEX idx_leads_org_stage ON leads(organization_id, stage, updated_at);

CREATE TABLE lead_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor_user_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_lead_events_lead ON lead_events(organization_id, lead_id, created_at);

CREATE TABLE crm_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_at TEXT,
  assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX idx_crm_tasks_org ON crm_tasks(organization_id, status, due_at);
CREATE INDEX idx_crm_tasks_lead ON crm_tasks(organization_id, lead_id);

-- Plan limits for forms (contacts are not limited: they are the customer's own data).
UPDATE plans SET limits_json = json_set(limits_json, '$.leadForms', 1)  WHERE code = 'free'    AND json_extract(limits_json, '$.leadForms') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.leadForms', 3)  WHERE code = 'starter' AND json_extract(limits_json, '$.leadForms') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.leadForms', 10) WHERE code = 'growth'  AND json_extract(limits_json, '$.leadForms') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.leadForms', 25) WHERE code = 'pro'     AND json_extract(limits_json, '$.leadForms') IS NULL;
UPDATE plans SET limits_json = json_set(limits_json, '$.leadForms', 100) WHERE code = 'agency' AND json_extract(limits_json, '$.leadForms') IS NULL;
