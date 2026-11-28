-- Migration 0005: the REPLAY speed control, one audit action (S7-7a, ADR 0064)
INSERT INTO audit_actions(action) VALUES ('REPLAY_SPEED');
