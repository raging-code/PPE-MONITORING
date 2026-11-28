"""P28-2 (ADR 0056): Migration 0003, PIN columns on operators, the login_sessions table and the three audit actions. Real runner, real 0001 to 0003 files. Requirements: REQ-SEC-004, REQ-SEC-005."""
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
    c = fresh(tmp_path); assert applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]          # S7-5a added 0004, S7-7a 0005, S8-1 0006, S8-3a 0007, S8-5 0008, S8-8 0009
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
    assert run_migrations(c, str(MIG), 2) == [3, 4, 5, 6, 7, 8, 9] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]
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
    assert len(a) == 30 and {'PIN_SET', 'LOGOUT', 'LOGIN_LOCKED', 'LOGIN_OK', 'LOGIN_REJECTED', 'TOKEN_ROTATED', 'OPERATOR_DISABLED'} <= a
    operator(c)
    for i, act in enumerate(('PIN_SET', 'LOGOUT', 'LOGIN_LOCKED')): c.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action) VALUES (NULL, 0, ?, 1, ?)', (i + 1, act))
    rejects(lambda: c.execute("INSERT INTO audit_events(session_id, event_seq, ts, action) VALUES (NULL, 0, 9, 'PIN_RESET')"))   # not a frozen action
