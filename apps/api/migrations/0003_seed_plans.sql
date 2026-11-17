-- Reference data: commercial plans (PRD §9 hypothesis — editable here, never hard-coded in UI).
-- stripe_price_id stays NULL until Stripe is configured (see README → Stripe).
INSERT OR IGNORE INTO plans (code, name, price_eur_month, limits_json, position) VALUES
 ('free',   'Free Audit', 0,    '{"brands":1,"seats":1,"analysesPerMonth":3,"pagesPerCrawl":10,"monthlyCredits":50}', 0),
 ('starter','Starter',    39,   '{"brands":1,"seats":1,"analysesPerMonth":20,"pagesPerCrawl":25,"monthlyCredits":500}', 1),
 ('growth', 'Growth',     89,   '{"brands":3,"seats":3,"analysesPerMonth":60,"pagesPerCrawl":50,"monthlyCredits":1500}', 2),
 ('pro',    'Pro',        179,  '{"brands":10,"seats":10,"analysesPerMonth":200,"pagesPerCrawl":100,"monthlyCredits":4000}', 3),
 ('agency', 'Agency',     349,  '{"brands":50,"seats":25,"analysesPerMonth":600,"pagesPerCrawl":100,"monthlyCredits":10000}', 4);
