-- Migration 0003: PIN login and login sessions (P28-2, ADR 0056)
ALTER TABLE operators ADD COLUMN pin_hash TEXT;
ALTER TABLE operators ADD COLUMN pin_salt TEXT;
ALTER TABLE operators ADD COLUMN pin_fails INTEGER NOT NULL DEFAULT 0 CHECK (pin_fails >= 0);
ALTER TABLE operators ADD COLUMN pin_locked_until INTEGER;
ALTER TABLE operators ADD COLUMN pin_set_ts INTEGER;
CREATE TABLE login_sessions (login_session_id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES operators(operator_id), token_hash TEXT NOT NULL UNIQUE, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, remember INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0,1)), revoked_ts INTEGER, CHECK (expires_ts > created_ts));
CREATE INDEX idx_login_sessions_operator ON login_sessions(operator_id, revoked_ts);
INSERT INTO audit_actions(action) VALUES ('PIN_SET'),('LOGOUT'),('LOGIN_LOCKED');
