-- 0020 Own product analytics, cookieless and GDPR-minded (ADR 0021). Additive only.
--
-- One row per product event: no IP, no user id, no email, no query strings. visitor_hash is a DAILY hash
-- of IP + user agent + day with the IP_HASH_SALT secret (NULL when the browser sends a privacy signal or
-- the secret is missing), so a visitor cannot be followed from one day to the next. organization_id is set
-- only for server events inside the app. source tells events recorded by the server ('server', verified)
-- from events declared by a browser ('client'). Rows are deleted after 13 months by the cron.
-- The event vocabulary is validated in code (apps/api/src/lib/product-events.ts), not with a CHECK, so new
-- events never need a table rebuild.

CREATE TABLE product_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  event TEXT NOT NULL CHECK (length(event) BETWEEN 3 AND 40),
  source TEXT NOT NULL CHECK (source IN ('server', 'client')),
  props_json TEXT NOT NULL DEFAULT '{}' CHECK (length(props_json) <= 512),
  path TEXT CHECK (path IS NULL OR length(path) <= 200),
  visitor_hash TEXT CHECK (visitor_hash IS NULL OR length(visitor_hash) = 32),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_product_events_time ON product_events (created_at);
CREATE INDEX idx_product_events_event ON product_events (event, created_at);
