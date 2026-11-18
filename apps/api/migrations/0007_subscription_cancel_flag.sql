-- 0007: show scheduled cancellations (additive only).
-- Set from Stripe's cancel_at_period_end / cancel_at on customer.subscription.* events.
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
