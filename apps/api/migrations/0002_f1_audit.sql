-- DNI Growth — F1 URL → audit → brand → growth plan

CREATE TABLE web_crawls (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
  pages_count INTEGER NOT NULL DEFAULT 0,
  pages_limit INTEGER NOT NULL,
  robots_found INTEGER NOT NULL DEFAULT 0,
  robots_txt TEXT,
  sitemap_found INTEGER NOT NULL DEFAULT 0,
  sitemap_url_count INTEGER NOT NULL DEFAULT 0,
  llms_txt_found INTEGER NOT NULL DEFAULT 0,
  served_over_https INTEGER NOT NULL DEFAULT 1,
  health_score INTEGER,
  health_method TEXT,
  opportunities_json TEXT NOT NULL DEFAULT '[]',
  skipped_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, job_id),
  FOREIGN KEY (organization_id, site_id) REFERENCES sites(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_crawls_org ON web_crawls(organization_id, started_at DESC);

CREATE TABLE crawl_pages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  crawl_id TEXT NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  content_type TEXT,
  duration_ms INTEGER,
  title TEXT,
  description TEXT,
  h1 TEXT,
  canonical TEXT,
  lang TEXT,
  word_count INTEGER,
  content_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, crawl_id, final_url),
  FOREIGN KEY (organization_id, crawl_id) REFERENCES web_crawls(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE seo_issues (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  crawl_id TEXT NOT NULL,
  url TEXT,
  rule_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  category TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  priority_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','ignored')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, crawl_id) REFERENCES web_crawls(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_issues_crawl ON seo_issues(organization_id, crawl_id, priority_score DESC);

CREATE TABLE growth_plans (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  crawl_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, crawl_id),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, crawl_id) REFERENCES web_crawls(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE growth_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  channel TEXT NOT NULL,
  week INTEGER NOT NULL CHECK (week BETWEEN 1 AND 4),
  estimate_hours REAL NOT NULL DEFAULT 0,
  source_rule TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','dismissed','blocked')),
  blocked_reason TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, plan_id) REFERENCES growth_plans(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_tasks_plan ON growth_tasks(organization_id, plan_id, position);
