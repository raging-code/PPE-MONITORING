-- Migration 0007: set a firefighter inactive or active again, one audit action (S8-3a, ADR 0072)
INSERT INTO audit_actions(action) VALUES ('FIREFIGHTER_ACTIVE_SET');
