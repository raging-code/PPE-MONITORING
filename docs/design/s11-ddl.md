Canonical Migration 0001 Starter DDL (Tier 1 Core — SQLite WAL):

The Migration 0001 DDL is no longer kept here. Per the Rev 3.28 repository rule, `host/migrations/0001.sql` is the only copy (it was extracted verbatim from this block, including its comments). Read that file.

Canonical Migration 0002 Starter DDL (Tier 2 ML, COHb & Extended Episodes):

CREATE TABLE ml_outputs (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(session_id), frame_id INTEGER NOT NULL UNIQUE REFERENCES frames(frame_id), node_id INTEGER NOT NULL REFERENCES roster(node_id), ts INTEGER NOT NULL, model_version TEXT NOT NULL, forecast_5min_ppm REAL, early_warning INTEGER NOT NULL DEFAULT 0 CHECK (early_warning IN (0,1)), anomaly_score REAL, anomaly_unusual INTEGER NOT NULL DEFAULT 0 CHECK (anomaly_unusual IN (0,1)), cohb_low REAL, cohb_high REAL, worker_ms REAL NOT NULL);  
CREATE INDEX idx_ml_session_node_ts ON ml_outputs(session_id, node_id, ts);
