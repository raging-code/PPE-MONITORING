// patches/part28_2_migration_0003.mjs  (run from repo root: node patches/part28_2_migration_0003.mjs [--dry] [--force])
// P28 Part 2 (ADR 0056): Migration 0003 for the PIN login. Needs part28_1 applied first (it edits docs/adr/0056.md). No application code reads or writes the new columns yet.
// New: host/migrations/0003.sql, host/tests/test_migration_0003.py.
// Edited (single-line anchors): host/tests/test_db_schema.py (the schema test compares the dump with every migration file, expects versions [1, 2, 3] and the audit_actions seed of 21; that test is renamed),
//   docs/adr/0056.md (Progress line), docs/PROGRESS.md (one bullet appended).
// Safe to run twice. CRLF files keep their CRLF. --dry writes nothing.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), FORCE = process.argv.includes('--force');
const abs = (p) => path.join(ROOT, p), plan = [];
const put = (p, content) => plan.push({ op: 'put', p, content });
const replace = (p, o, n) => plan.push({ op: 'replace', p, o, n });
const append = (p, text) => plan.push({ op: 'append', p, text });
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toEol = (t, e) => t.replace(/\r\n/g, '\n').replace(/\n/g, e);
const lf = (s) => s.replace(/\r\n/g, '\n');
function apply() {
  const state = new Map(), log = [];
  const get = (p) => (state.has(p) ? state.get(p) : fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && lf(cur) !== lf(s.content) && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : lf(cur) === lf(s.content) ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) throw new Error(`MISSING file: ${s.p} (run the earlier parts first, and run from the repo root)`);
    else if (s.op === 'replace') {
      const e = eolOf(cur), o = toEol(s.o, e), n = toEol(s.n, e), c = cur.split(o).length - 1;
      if (cur.includes(n)) log.push(`skip      ${s.p} (already applied)`);
      else if (c === 1) { state.set(s.p, cur.replace(o, () => n)); log.push(`edit      ${s.p}`); }
      else throw new Error(`ANCHOR found ${c} times in ${s.p}: ${s.o.slice(0, 70)}`);
    } else if (s.op === 'append') {
      const e = eolOf(cur), t = toEol(s.text, e);
      if (cur.includes(t.trim())) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : e) + t); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\ndone'));
}

// ---- 1. Migration 0003 (new file). The first line is the schema_version description. Run by executescript, one transaction with its schema_version row.
put('host/migrations/0003.sql', `-- Migration 0003: PIN login and login sessions (P28-2, ADR 0056)
ALTER TABLE operators ADD COLUMN pin_hash TEXT;
ALTER TABLE operators ADD COLUMN pin_salt TEXT;
ALTER TABLE operators ADD COLUMN pin_fails INTEGER NOT NULL DEFAULT 0 CHECK (pin_fails >= 0);
ALTER TABLE operators ADD COLUMN pin_locked_until INTEGER;
ALTER TABLE operators ADD COLUMN pin_set_ts INTEGER;
CREATE TABLE login_sessions (login_session_id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES operators(operator_id), token_hash TEXT NOT NULL UNIQUE, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL, remember INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0,1)), revoked_ts INTEGER, CHECK (expires_ts > created_ts));
CREATE INDEX idx_login_sessions_operator ON login_sessions(operator_id, revoked_ts);
INSERT INTO audit_actions(action) VALUES ('PIN_SET'),('LOGOUT'),('LOGIN_LOCKED');
`);

// ---- 2. Tests of the migration (new file)
put('host/tests/test_migration_0003.py', `"""P28-2 (ADR 0056): Migration 0003, PIN columns on operators, the login_sessions table and the three audit actions. Real runner, real 0001 to 0003 files. Requirements: REQ-SEC-004, REQ-SEC-005."""
import pathlib, shutil, sqlite3
import pytest
from ppe_host.io.db_writer import connect_db, run_migrations, applied_versions

MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
NEW_COLS = {'pin_hash', 'pin_salt', 'pin_fails', 'pin_locked_until', 'pin_set_ts'}

def cols(c, table): return {r[1]: r for r in c.execute('PRAGMA table_info(%s)' % table).fetchall()}
def fresh(tmp_path, name='t.db'):
    c = connect_db(tmp_path / name); run_migrations(c, str(MIG), 1000); return c
def operator(c, oid=1, name='Ana'):
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (?, ?, 'h', 1, 1)", (oid, name))
def login_session(c, token_hash='s1', operator_id=1, created=10, expires=20, **kw):
    c.execute('INSERT INTO login_sessions(operator_id, token_hash, created_ts, expires_ts%s) VALUES (?, ?, ?, ?%s)' % (''.join(', ' + k for k in kw), ', ?' * len(kw)), (operator_id, token_hash, created, expires) + tuple(kw.values()))
def rejects(fn):
    with pytest.raises(sqlite3.IntegrityError): fn()

def test_fresh_database_gets_0001_0002_0003_and_the_description_names_0003(tmp_path):
    c = fresh(tmp_path); assert applied_versions(c) == [1, 2, 3]
    assert c.execute('SELECT description FROM schema_version WHERE version = 3').fetchone()[0].startswith('Migration 0003')
    assert run_migrations(c, str(MIG), 2000) == []                       # a second run applies nothing

def test_operators_gain_the_pin_columns_with_safe_defaults(tmp_path):
    c = fresh(tmp_path); k = cols(c, 'operators'); assert NEW_COLS <= set(k)
    operator(c); assert c.execute('SELECT pin_hash, pin_salt, pin_fails, pin_locked_until, pin_set_ts FROM operators').fetchone() == (None, None, 0, None, None)
    rejects(lambda: c.execute('UPDATE operators SET pin_fails = -1'))

def test_an_existing_version_2_database_is_upgraded_and_keeps_its_operator_and_token(tmp_path):
    d = tmp_path / 'm2'; d.mkdir(); shutil.copy(MIG / '0001.sql', d / '0001.sql'); shutil.copy(MIG / '0002.sql', d / '0002.sql')
    c = connect_db(tmp_path / 'old.db'); assert run_migrations(c, str(d), 1) == [1, 2] and 'pin_hash' not in cols(c, 'operators')
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (7, 'Old', 'tokhash', 5, 6)")
    assert run_migrations(c, str(MIG), 2) == [3] and applied_versions(c) == [1, 2, 3]
    assert c.execute('SELECT display_name, token_hash, active, created_ts, token_issued_ts, pin_hash, pin_fails FROM operators').fetchall() == [('Old', 'tokhash', 1, 5, 6, None, 0)]

def test_login_sessions_table_shape_and_keys(tmp_path):
    c = fresh(tmp_path); assert set(cols(c, 'login_sessions')) == {'login_session_id', 'operator_id', 'token_hash', 'created_ts', 'expires_ts', 'remember', 'revoked_ts'}
    rejects(lambda: login_session(c, operator_id=9))                     # no such operator (foreign key)
    operator(c); login_session(c); assert c.execute('SELECT remember, revoked_ts FROM login_sessions').fetchone() == (0, None)
    rejects(lambda: login_session(c))                                    # token_hash is unique
    rejects(lambda: login_session(c, token_hash='s2', created=20, expires=20))   # must expire after it was made
    rejects(lambda: login_session(c, token_hash='s3', remember=2))
    login_session(c, token_hash='s4', remember=1, revoked_ts=15); assert c.execute('SELECT COUNT(*) FROM login_sessions').fetchone()[0] == 2
    assert c.execute('PRAGMA foreign_key_check').fetchall() == []

def test_three_new_audit_actions_and_the_old_eighteen_are_all_accepted(tmp_path):
    c = fresh(tmp_path); a = {r[0] for r in c.execute('SELECT action FROM audit_actions')}
    assert len(a) == 21 and {'PIN_SET', 'LOGOUT', 'LOGIN_LOCKED', 'LOGIN_OK', 'LOGIN_REJECTED', 'TOKEN_ROTATED', 'OPERATOR_DISABLED'} <= a
    operator(c)
    for i, act in enumerate(('PIN_SET', 'LOGOUT', 'LOGIN_LOCKED')): c.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action) VALUES (NULL, 0, ?, 1, ?)', (i + 1, act))
    rejects(lambda: c.execute("INSERT INTO audit_events(session_id, event_seq, ts, action) VALUES (NULL, 0, 9, 'PIN_RESET')"))   # not a frozen action
`);

// ---- 3. The schema test compares the dump with the migration files, not only 0001 (four single-line edits)
replace('host/tests/test_db_schema.py', "def test_schema_dump_equals_0001_sql(tmp_path):", "def test_schema_dump_equals_the_migration_files(tmp_path):");
replace('host/tests/test_db_schema.py', "ref = sqlite3.connect(':memory:'); ref.executescript((MIG / '0001.sql').read_text(encoding='utf8'))",
  "ref = sqlite3.connect(':memory:'); [ref.executescript(f.read_text(encoding='utf8')) for f in sorted(MIG.glob('0*.sql'))]");
replace('host/tests/test_db_schema.py', "master(c) == master(ref) and applied_versions(c) == [1, 2]", "master(c) == master(ref) and applied_versions(c) == [1, 2, 3]");

replace('host/tests/test_db_schema.py', "n('system_event_types')) == (25, 18, 32)", "n('system_event_types')) == (25, 21, 32)");   // audit_actions 18 to 21

// ---- 4. ADR progress line and PROGRESS
replace('docs/adr/0056.md', '- **Progress.** P28-1 done. P28-2 to P28-6 not done.', '- **Progress.** P28-1 and P28-2 done (Migration 0003 and its tests). P28-3 to P28-6 not done.');
append('docs/PROGRESS.md', '- Part 28-2 done (ADR 0056): host/migrations/0003.sql (operators gains pin_hash, pin_salt, pin_fails, pin_locked_until, pin_set_ts, all NULL or 0 for an existing operator; new table login_sessions with a unique token_hash, an expiry check and a revoked_ts; audit_actions 18 to 21 with PIN_SET, LOGOUT, LOGIN_LOCKED). host/tests/test_migration_0003.py (5 tests: fresh and upgraded databases, defaults, keys and checks, the audit actions). test_db_schema.py now compares the dump with every migration file and expects versions [1, 2, 3]. No code reads or writes the new columns yet, so behavior is unchanged. P28-3 to P28-6 not done.\n');

apply();
