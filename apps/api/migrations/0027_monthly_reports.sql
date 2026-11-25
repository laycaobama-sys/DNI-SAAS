-- Monthly report email: one row per organisation, month and recipient (claim before sending: never twice).
-- Additive: a new table and a nullable column.
CREATE TABLE IF NOT EXISTS monthly_report_sends (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('sent', 'skipped')),
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, period, user_id)
);

ALTER TABLE users ADD COLUMN monthly_report_opt_out_at TEXT;
