-- 0006: Stripe billing hardening (additive only).
--  * subscriptions.provider_customer_id: Stripe customer, needed for the customer portal and to avoid duplicate customers.
--  * subscriptions.provider_event_at: Stripe event timestamp of the last applied event (out-of-order protection).
--  * platform_settings: non-secret platform identifiers (e.g. Stripe portal configuration id). Never secrets.
ALTER TABLE subscriptions ADD COLUMN provider_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN provider_event_at INTEGER;
CREATE INDEX idx_subscriptions_customer ON subscriptions(provider_customer_id);

CREATE TABLE platform_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
