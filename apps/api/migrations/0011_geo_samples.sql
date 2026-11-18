-- F3 GEO monitor: REAL answers sampled from AI engines through their official APIs. Additive only.
-- Each row is one dated sample (engine, model, language, region) of one tracked prompt. Nothing here
-- is simulated: failed or blocked calls are stored as such, never replaced by invented text.
CREATE TABLE ai_response_samples (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  job_id TEXT,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT,
  grounded INTEGER NOT NULL DEFAULT 0 CHECK (grounded IN (0,1)),
  method TEXT NOT NULL,
  question TEXT NOT NULL,
  locale TEXT NOT NULL,
  region_country TEXT NOT NULL,
  region_detail TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','blocked','empty','error')),
  error_code TEXT,
  answer_text TEXT,
  answer_truncated INTEGER NOT NULL DEFAULT 0 CHECK (answer_truncated IN (0,1)),
  citations_json TEXT NOT NULL DEFAULT '[]',
  search_queries_json TEXT NOT NULL DEFAULT '[]',
  brand_mentioned INTEGER CHECK (brand_mentioned IN (0,1)),
  brand_mention_count INTEGER,
  brand_cited INTEGER CHECK (brand_cited IN (0,1)),
  competitors_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  sampled_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, brand_id) REFERENCES brands(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, prompt_id) REFERENCES tracked_prompts(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_ai_samples_brand ON ai_response_samples(organization_id, brand_id, sampled_at DESC);
CREATE INDEX idx_ai_samples_prompt ON ai_response_samples(organization_id, prompt_id, sampled_at DESC);
