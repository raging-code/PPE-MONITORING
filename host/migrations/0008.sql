-- Migration 0008: withdrawing consent and editing a profile (S8-5, ADR 0074)
ALTER TABLE firefighters ADD COLUMN consent_withdrawn_ts INTEGER;
INSERT INTO audit_actions(action) VALUES ('FIREFIGHTER_EDITED'),('CONSENT_WITHDRAWN');
