-- Migration 0001 (rewritten in Rev 3.27 for the Rev 3.26 design: lookup tables, global open-alert index, no session carry-over columns, no token_expires_ts; run and tested in SQLite)
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_ts INTEGER NOT NULL, description TEXT NOT NULL);
-- Rev 3.27: lookup tables replace CHECK lists (a catalog change is an INSERT, not a table rebuild); seeded from alert_catalog.json
CREATE TABLE alert_types (type TEXT PRIMARY KEY);
CREATE TABLE audit_actions (action TEXT PRIMARY KEY);
CREATE TABLE system_event_types (kind TEXT PRIMARY KEY);
INSERT INTO alert_types(type) VALUES ('mayday'),('man_down'),('co_threshold'),('link_lost'),('signal_lost'),('checkin'),('scba_expired'),('sensor_fault'),('wrist_open'),('wrist_close'),('battery_low'),('heat'),('unauth_alert'),('node_reboot'),('button_stuck'),('missed_event'),('suspect_frame'),('estimate'),('shadow_notice'),('weak_signal'),('co_warmup'),('co_rising'),('latch_restored'),('watchdog_recovery'),('node_danger');
INSERT INTO audit_actions(action) VALUES ('LOGIN_OK'),('LOGIN_REJECTED'),('ORIGIN_REJECTED'),('CSV_EXPORT'),('START_MONITORING'),('END_SHIFT'),('ACK_ALERT'),('ACK_EPISODE'),('EPISODE_ESCALATED'),('RESOLVE_EPISODE'),('BANNER_ACK'),('SCBA_CORRECTION'),('DASHBOARD_OUTAGE'),('OPERATOR_ADDED'),('TOKEN_ROTATED'),('OPERATOR_DISABLED'),('SESSION_PURGED'),('DB_RESTORED');
INSERT INTO system_event_types(kind) VALUES ('HOST_START'),('RECOVERING_ENTER'),('RECOVERING_EXIT'),('SERIAL_LOST'),('SERIAL_BACK'),('BASE_OFFLINE'),('BASE_BACK'),('QUEUE_OVERFLOW'),('LIVENESS_RESTART'),('TICK_STALL'),('MAC_DISAGREE'),('CONFIG_CHANGED'),('COUNTERS'),('INTEGRITY_OK'),('INTEGRITY_FAIL'),('BACKUP_OK'),('BACKUP_FAIL'),('RESTORE'),('TIER2_TIMEOUT'),('HOST_GAP'),('LOGGING_FAULT'),('DISK_LOW'),('HOST_BATTERY'),('SESSION_ABANDONED'),('CLIENT_DROPPED'),('LIVE_FRAME_IN_TEST_MODE'),('AUDIO_FAULT'),('AUDIO_OK'),('CLEAN_SHUTDOWN');
CREATE TABLE operators (operator_id INTEGER PRIMARY KEY, display_name TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_ts INTEGER NOT NULL, token_issued_ts INTEGER NOT NULL);
CREATE TABLE roster (node_id INTEGER PRIMARY KEY CHECK (node_id BETWEEN 1 AND 3), alias TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)));
CREATE TABLE sessions (session_id INTEGER PRIMARY KEY, started_ts INTEGER NOT NULL, ended_ts INTEGER, mode TEXT NOT NULL CHECK (mode IN ('LIVE','SIMULATOR','REPLAY')), host_build TEXT NOT NULL, fw_version TEXT, constants_hash TEXT NOT NULL, settings_hash TEXT NOT NULL, session_label TEXT, operator_id INTEGER REFERENCES operators(operator_id), monitoring_active INTEGER NOT NULL DEFAULT 0 CHECK (monitoring_active IN (0,1)), end_kind TEXT CHECK (end_kind IN ('ENDED','CLEAN_SHUTDOWN','ABANDONED')), CHECK ((ended_ts IS NULL) = (end_kind IS NULL)));
CREATE TABLE frames (frame_id INTEGER PRIMARY KEY, event_seq INTEGER NOT NULL, session_id INTEGER NOT NULL REFERENCES sessions(session_id), node_id INTEGER, rx_ts INTEGER NOT NULL, rx_mono INTEGER NOT NULL, seq INTEGER, boot_ctr INTEGER, uptime_s INTEGER, co_x10 INTEGER, co_over_range INTEGER NOT NULL DEFAULT 0 CHECK (co_over_range IN (0,1)), temp_x100 INTEGER, hum INTEGER, hr INTEGER, motion_x100 INTEGER, bat INTEGER, status2 INTEGER, flags INTEGER, id_mode INTEGER, status3 INTEGER, status4 INTEGER, node_level TEXT CHECK (node_level IN ('NORMAL','WARNING','DANGER')), backend_level TEXT CHECK (backend_level IN ('NORMAL','WARNING','DANGER')), final_level TEXT CHECK (final_level IN ('NORMAL','WARNING','DANGER')), reasons TEXT, rssi REAL, snr REAL, verify TEXT NOT NULL CHECK (verify IN ('OK','BAD_MAC','BAD_CRC','BAD_LEN')), base_verify TEXT NOT NULL CHECK (base_verify IN ('OK','BAD_LEN','BAD_CRC','BAD_MAC')), seq_class TEXT NOT NULL CHECK (seq_class IN ('fresh','duplicate','reboot','suspect')), frames_lost INTEGER NOT NULL DEFAULT 0, raw_hex TEXT NOT NULL, backend_ms REAL NOT NULL, CHECK (verify <> 'OK' OR node_id IS NOT NULL));
CREATE TABLE episodes (episode_id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(session_id), node_id INTEGER NOT NULL REFERENCES roster(node_id), kind TEXT NOT NULL CHECK (kind IN ('MAN_DOWN','MAYDAY')), opened_ts INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('OPEN','ACKNOWLEDGED','RESOLVED')), acknowledged_ts INTEGER, acknowledged_by INTEGER REFERENCES operators(operator_id), resolved_ts INTEGER, resolve_reason TEXT CHECK ((state != 'RESOLVED' AND resolve_reason IS NULL) OR (state = 'RESOLVED' AND resolve_reason IN ('rescued','false_alarm','device_removed'))), resolved_by INTEGER REFERENCES operators(operator_id) CHECK ((state != 'RESOLVED' AND resolved_by IS NULL) OR (state = 'RESOLVED' AND resolved_by IS NOT NULL)), CHECK ((state = 'RESOLVED') = (resolved_ts IS NOT NULL)));
CREATE TABLE alerts (alert_id INTEGER PRIMARY KEY, event_seq INTEGER NOT NULL, cleared_event_seq INTEGER, session_id INTEGER NOT NULL REFERENCES sessions(session_id), frame_id INTEGER REFERENCES frames(frame_id), episode_id INTEGER REFERENCES episodes(episode_id), node_id INTEGER, type TEXT NOT NULL REFERENCES alert_types(type), level TEXT NOT NULL CHECK (level IN ('NONE','WARNING','DANGER')), authenticated INTEGER NOT NULL DEFAULT 1 CHECK (authenticated IN (0,1)), reasons TEXT, raised_ts INTEGER NOT NULL, cleared_ts INTEGER, acknowledged_ts INTEGER, acknowledged_by INTEGER REFERENCES operators(operator_id));
CREATE TABLE audit_events (audit_id INTEGER PRIMARY KEY, session_id INTEGER REFERENCES sessions(session_id), event_seq INTEGER NOT NULL, ts INTEGER NOT NULL, operator_id INTEGER REFERENCES operators(operator_id), action TEXT NOT NULL REFERENCES audit_actions(action), node_id INTEGER, episode_id INTEGER, reason TEXT);
CREATE TABLE base_health (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(session_id), ts INTEGER NOT NULL, uptime_ms INTEGER NOT NULL, bat_pct INTEGER NOT NULL, rx_ok INTEGER NOT NULL, rx_bad_len INTEGER NOT NULL, rx_bad_crc INTEGER NOT NULL, rx_bad_mac INTEGER NOT NULL);
CREATE TABLE system_events (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(session_id), event_seq INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL REFERENCES system_event_types(kind), detail TEXT);
CREATE TABLE advisory_summaries (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(session_id), event_seq INTEGER NOT NULL, ts INTEGER NOT NULL, node_id INTEGER NOT NULL, window_s INTEGER NOT NULL, risk TEXT NOT NULL, reasons TEXT NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL, passage_ids TEXT, quality TEXT NOT NULL CHECK (quality IN ('high','medium','low')), CHECK (source <> 'table' OR risk IN ('CRITICAL_LIFE_SAFETY','TOXIC_ATMOSPHERE','COMMS_LOSS_ADVERSE','ELEVATED_EXPOSURE','DEGRADED_TELEMETRY','NOMINAL')));
-- dormant in Tier 1 (not written; see 2.10)
CREATE TABLE checkpoints (checkpoint_id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(session_id), created_ts INTEGER NOT NULL, last_event_seq INTEGER NOT NULL, constants_hash TEXT NOT NULL, state_json TEXT NOT NULL CHECK (length(CAST(state_json AS BLOB)) <= 16384), state_sha256 TEXT NOT NULL);
CREATE INDEX idx_frames_node_ts ON frames(node_id, rx_ts);
CREATE INDEX idx_frames_session_ts ON frames(session_id, rx_ts);
CREATE INDEX idx_base_health_session_ts ON base_health(session_id, ts);
CREATE UNIQUE INDEX idx_frames_session_seq ON frames(session_id, event_seq);
-- Rev 3.35: database backstop for the roster rule (Section 2): a frame with verify = 'OK' whose node_id is not in roster is never stored. Frames failing length, CRC or MAC are unaffected. Run this migration with executescript, not by splitting on ';' (the trigger body contains one).
CREATE TRIGGER trg_frames_roster BEFORE INSERT ON frames WHEN NEW.verify = 'OK' AND NOT EXISTS (SELECT 1 FROM roster WHERE node_id = NEW.node_id) BEGIN SELECT RAISE(ABORT, 'frame node_id not in roster'); END;
CREATE UNIQUE INDEX idx_alerts_session_seq ON alerts(session_id, event_seq);
CREATE UNIQUE INDEX idx_alerts_one_open_per_node_type ON alerts(COALESCE(node_id,0), type) WHERE cleared_ts IS NULL AND type IN ('mayday','man_down','co_threshold','link_lost','signal_lost','checkin','scba_expired','sensor_fault','battery_low','heat','shadow_notice','node_danger','wrist_open','button_stuck','missed_event','co_warmup');
CREATE INDEX idx_alerts_session_cleared ON alerts(session_id, cleared_ts);
CREATE INDEX idx_alerts_open ON alerts(node_id, type) WHERE cleared_ts IS NULL;
CREATE UNIQUE INDEX idx_audit_session_seq ON audit_events(session_id, event_seq) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX idx_sysevents_session_seq ON system_events(session_id, event_seq);
CREATE UNIQUE INDEX idx_advisory_session_seq ON advisory_summaries(session_id, event_seq);
CREATE INDEX idx_checkpoints_session_seq ON checkpoints(session_id, last_event_seq DESC);
CREATE UNIQUE INDEX idx_episodes_one_active ON episodes(node_id) WHERE state IN ('OPEN', 'ACKNOWLEDGED');
CREATE UNIQUE INDEX idx_sessions_one_open ON sessions((1)) WHERE ended_ts IS NULL;
CREATE VIEW v_readings AS SELECT * FROM frames WHERE verify = 'OK' AND seq_class != 'duplicate';
CREATE VIEW v_full_log AS
  SELECT session_id, event_seq, rx_ts AS log_ts, 'frame' AS record_type, node_id, final_level AS level, seq_class AS code, reasons AS detail, NULL AS operator_id, ROUND(co_x10 / 10.0, 1) AS co_ppm, ROUND(temp_x100 / 100.0, 2) AS temp_c, hum AS hum_pct, ROUND(motion_x100 / 100.0, 2) AS motion_g, bat AS bat_pct, (id_mode >> 3) & 1 AS scba_on, (flags >> 2) & 1 AS mandown, verify, rssi, snr, raw_hex FROM frames
  UNION ALL
  SELECT session_id, event_seq, raised_ts AS log_ts, 'alert_raised' AS record_type, node_id, level, type AS code, reasons AS detail, acknowledged_by AS operator_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM alerts
  UNION ALL
  SELECT session_id, COALESCE(cleared_event_seq, event_seq) AS event_seq, cleared_ts AS log_ts, 'alert_cleared' AS record_type, node_id, level, type AS code, reasons AS detail, acknowledged_by AS operator_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM alerts WHERE cleared_ts IS NOT NULL
  UNION ALL
  SELECT session_id, event_seq, ts AS log_ts, 'audit' AS record_type, node_id, NULL AS level, action AS code, reason AS detail, operator_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM audit_events WHERE session_id IS NOT NULL
  UNION ALL
  SELECT session_id, event_seq, ts AS log_ts, 'system' AS record_type, NULL AS node_id, NULL AS level, kind AS code, detail, NULL AS operator_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM system_events
  UNION ALL
  SELECT session_id, event_seq, ts AS log_ts, 'advisory' AS record_type, node_id, NULL AS level, risk AS code, (reasons || ' -> ' || action) AS detail, NULL AS operator_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM advisory_summaries
  ORDER BY event_seq ASC, log_ts ASC;
-- Rev 3.41: v_events feeds GET /api/events: v_full_log without the frame branch and without ORDER BY (the query adds it), so a page never scans the frames table
CREATE VIEW v_events AS
  SELECT session_id, event_seq, raised_ts AS log_ts, 'alert_raised' AS record_type, node_id, level, type AS code, reasons AS detail, acknowledged_by AS operator_id FROM alerts
  UNION ALL
  SELECT session_id, COALESCE(cleared_event_seq, event_seq), cleared_ts, 'alert_cleared', node_id, level, type, reasons, acknowledged_by FROM alerts WHERE cleared_ts IS NOT NULL
  UNION ALL
  SELECT session_id, event_seq, ts, 'audit', node_id, NULL, action, reason, operator_id FROM audit_events WHERE session_id IS NOT NULL
  UNION ALL
  SELECT session_id, event_seq, ts, 'system', NULL, NULL, kind, detail, NULL FROM system_events
  UNION ALL
  SELECT session_id, event_seq, ts, 'advisory', node_id, NULL, risk, (reasons || ' -> ' || action), NULL FROM advisory_summaries;
