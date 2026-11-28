-- Migration 0009: the proof kept when consent is withdrawn (S8-8, ADR 0077)
ALTER TABLE firefighters ADD COLUMN consent_withdrawal_form TEXT;
ALTER TABLE firefighters ADD COLUMN consent_withdrawal_witness TEXT;
