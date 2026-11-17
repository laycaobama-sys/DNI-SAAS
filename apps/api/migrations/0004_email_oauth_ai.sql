-- 0004: transactional email outbox (Cloudflare Email Service), Google sign-in identities,
-- AI advisor conversations, generated images and AI usage accounting.
-- Additive only: no existing table or row is modified.

-- Durable email outbox. Recipient is stored hashed + masked; the full message (which can
-- contain single-use links) is AES-GCM encrypted and purged once the provider accepts it.
CREATE TABLE email_outbox (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password','invitation','notification')),
  to_hash TEXT NOT NULL,
  to_masked TEXT NOT NULL,
  payload_enc TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  provider TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  accepted_at TEXT
);
CREATE INDEX email_outbox_due ON email_outbox (status, next_attempt_at);

-- External identities (Google). One Google account maps to exactly one user.
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

-- One-time OAuth state (PKCE verifier + nonce), keyed by SHA-256 of the state value.
CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  next_path TEXT NOT NULL DEFAULT '/app/',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- AI advisor conversations (tenant scoped).
CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id TEXT, -- validated against brands(organization_id, id) in code
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id)
);
CREATE INDEX ai_conversations_org ON ai_conversations (organization_id, updated_at);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, conversation_id) REFERENCES ai_conversations(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_messages_conv ON ai_messages (organization_id, conversation_id, created_at);

-- Generated images stored in R2 under media/<organization_id>/<id>.png
CREATE TABLE ai_images (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  format TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  cost_usd REAL,
  credits INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id, id)
);
CREATE INDEX ai_images_org ON ai_images (organization_id, created_at);

-- Platform-level daily AI spend estimate, used to stay inside the Workers AI free allocation.
CREATE TABLE ai_usage_daily (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);
