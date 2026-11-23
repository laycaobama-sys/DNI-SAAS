-- Billing v2 (plan comercial 2026-11-23). Additive: new columns and tables; plan prices/limits updated
-- in place (existing subscribers keep their Stripe price until they change plan, see lib/stripe.ts).

-- Annual prices (2 months free) and trial length per plan.
ALTER TABLE plans ADD COLUMN price_eur_year REAL;
ALTER TABLE plans ADD COLUMN stripe_price_id_year TEXT;
ALTER TABLE plans ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 0;

UPDATE plans SET name = 'Free', price_eur_year = 0,
  limits_json = json_set(limits_json, '$.articlesPerMonth', 1) WHERE code = 'free';
UPDATE plans SET price_eur_month = 49, price_eur_year = 492,
  limits_json = json_set(limits_json, '$.pagesPerCrawl', 100, '$.articlesPerMonth', 8) WHERE code = 'starter';
UPDATE plans SET price_eur_month = 129, price_eur_year = 1296, trial_days = 7,
  limits_json = json_set(limits_json, '$.brands', 1, '$.seats', 3, '$.pagesPerCrawl', 250, '$.articlesPerMonth', 30) WHERE code = 'growth';
UPDATE plans SET price_eur_month = 249, price_eur_year = 2496,
  limits_json = json_set(limits_json, '$.brands', 3, '$.seats', 10, '$.pagesPerCrawl', 500, '$.articlesPerMonth', 60) WHERE code = 'pro';
UPDATE plans SET price_eur_month = 449, price_eur_year = 4488,
  limits_json = json_set(limits_json, '$.brands', 15, '$.seats', 1000, '$.pagesPerCrawl', 500, '$.clientOrgs', 15, '$.articlesPerMonth', 450) WHERE code = 'agency';

-- Subscription lifecycle details mirrored from Stripe.
ALTER TABLE subscriptions ADD COLUMN billing_interval TEXT;
ALTER TABLE subscriptions ADD COLUMN trial_end TEXT;
ALTER TABLE subscriptions ADD COLUMN paused_until TEXT;
ALTER TABLE subscriptions ADD COLUMN payment_failed_at TEXT;
ALTER TABLE subscriptions ADD COLUMN grace_until TEXT;
ALTER TABLE subscriptions ADD COLUMN started_at TEXT;

-- One free trial per organisation; the retention discount can be used once.
ALTER TABLE organizations ADD COLUMN trial_used_at TEXT;
ALTER TABLE organizations ADD COLUMN retention_offer_used_at TEXT;

CREATE TABLE cancellation_feedback (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  comment TEXT,
  offer_shown TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('discount_applied','paused','cancel_scheduled')),
  plan_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX cancellation_feedback_org ON cancellation_feedback (organization_id, created_at DESC);

-- 90-day guarantee claims: one per organisation, refunds idempotent per invoice.
CREATE TABLE guarantee_claims (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('refunded','failed')),
  baseline_impressions INTEGER,
  current_impressions INTEGER,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  refund_ids_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
