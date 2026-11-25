-- /estado: results of the synthetic checks run by the cron (every 5 minutes), kept 90 days.
CREATE TABLE IF NOT EXISTS status_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_key TEXT NOT NULL CHECK (length(check_key) <= 40),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  latency_ms INTEGER,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_checks_key_time ON status_checks (check_key, checked_at);
CREATE INDEX IF NOT EXISTS idx_status_checks_time ON status_checks (checked_at);

-- Daily database backups written to R2 (EU): one row per backup, for /estado and the restore runbook.
CREATE TABLE IF NOT EXISTS db_backups (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  tables INTEGER NOT NULL,
  rows_total INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
