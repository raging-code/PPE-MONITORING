-- Migration 0004: the REPLAY pause control, two audit actions (S7-5a, ADR 0061)
INSERT INTO audit_actions(action) VALUES ('REPLAY_PAUSE'),('REPLAY_RESUME');
