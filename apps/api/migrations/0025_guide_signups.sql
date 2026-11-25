-- Downloadable guide in exchange for an email, with double opt-in (ADR 0026). Platform-level (no organisation):
-- the visitor has no account. The email is kept encrypted only while the confirmation is pending or when the
-- person also accepted the optional newsletter; otherwise it is erased on confirmation and only its hash remains
-- (to avoid duplicates and to prove the consent).
CREATE TABLE IF NOT EXISTS guide_signups (
  id TEXT PRIMARY KEY,
  guide TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  email_enc TEXT,
  newsletter INTEGER NOT NULL DEFAULT 0 CHECK (newsletter IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_hash TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  UNIQUE (guide, email_hash)
);
CREATE INDEX IF NOT EXISTS idx_guide_signups_pending ON guide_signups (status, created_at);
