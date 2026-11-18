-- Central AI service: 24 h response cache per organisation (saves the free daily quota when the
-- same request repeats). Additive only. Prompts are never stored: only a SHA-256 key of the request.
-- Requests with sensitive data are never cached. Expired rows are deleted by the cron.
CREATE TABLE ai_response_cache (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  response_text TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, cache_key)
);
CREATE INDEX idx_ai_cache_expiry ON ai_response_cache(expires_at);
