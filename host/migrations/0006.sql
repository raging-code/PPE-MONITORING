-- Migration 0006: firefighter profiles, who wears which jacket, three audit actions (S8-1, ADR 0070)
CREATE TABLE firefighters (
  firefighter_id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 80),
  sex TEXT CHECK (sex IN ('F','M','X')),
  age_years INTEGER NOT NULL CHECK (age_years BETWEEN 16 AND 80),
  height_cm INTEGER NOT NULL CHECK (height_cm BETWEEN 120 AND 230),
  weight_kg REAL NOT NULL CHECK (weight_kg BETWEEN 30 AND 250),
  resting_hr INTEGER NOT NULL CHECK (resting_hr BETWEEN 30 AND 120),
  max_hr INTEGER CHECK (max_hr BETWEEN 100 AND 230),
  smoker INTEGER NOT NULL CHECK (smoker IN (0,1)),
  years_service REAL CHECK (years_service BETWEEN 0 AND 60),
  consent_ts INTEGER NOT NULL,
  consent_form_version TEXT NOT NULL CHECK (length(consent_form_version) BETWEEN 1 AND 40),
  consent_witness TEXT NOT NULL CHECK (length(consent_witness) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_ts INTEGER NOT NULL
);
CREATE TABLE firefighter_assignments (
  assignment_id INTEGER PRIMARY KEY,
  node_id INTEGER NOT NULL REFERENCES roster(node_id),
  firefighter_id INTEGER NOT NULL REFERENCES firefighters(firefighter_id),
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  CHECK (end_ts IS NULL OR end_ts >= start_ts)
);
CREATE UNIQUE INDEX uq_assignment_open_node ON firefighter_assignments(node_id) WHERE end_ts IS NULL;
CREATE UNIQUE INDEX uq_assignment_open_firefighter ON firefighter_assignments(firefighter_id) WHERE end_ts IS NULL;
CREATE INDEX idx_assignment_firefighter ON firefighter_assignments(firefighter_id, start_ts);
INSERT INTO audit_actions(action) VALUES ('FIREFIGHTER_ADDED'),('FIREFIGHTER_ASSIGNED'),('ROSTER_ACTIVE_SET');
