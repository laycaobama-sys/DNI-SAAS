-- Plan modules (ADR 0018): client organisations and white label belong to Agency only.
-- Additive data update; the plan matrix itself lives in packages/core/src/plan-access.ts.
UPDATE plans SET limits_json = json_set(limits_json, '$.clientOrgs', 0) WHERE code = 'pro';
