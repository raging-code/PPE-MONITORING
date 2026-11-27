"""P11-1: connection factory, migration runner, schema and index tests (design 2.1, Section 8 Rev 3.20 and 3.38). Roster rows are inserted directly: seed-roster is P11-2. Requirements: REQ-DB-001, REQ-DB-005, REQ-DB-006, REQ-RUL-001."""
import json, pathlib, sqlite3, pytest
from ppe_host.io.db_writer import connect_db, run_migrations, init_event_seq, applied_versions, DatabaseTooNewError

MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
CATALOG = pathlib.Path(__file__).resolve().parents[2] / 'shared' / 'alert_catalog.json'
def master(c): return sorted(c.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall(), key=lambda r: (r[0], r[1]))
def new_db(tmp_path, name='t.db'):
    c = connect_db(tmp_path / name); run_migrations(c, str(MIG), 1000)
    c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03')]); return c
def session(c, sid=1, ended=None):
    c.execute('INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash, ended_ts, end_kind) VALUES (?, 1, \'LIVE\', \'b\', \'c\', \'s\', ?, ?)', (sid, ended, 'ENDED' if ended else None))
def frame(c, seq, node=1, verify='OK', **kw):
    f = dict(event_seq=seq, session_id=1, node_id=node, rx_ts=1, rx_mono=1, verify=verify, base_verify='OK', seq_class='fresh', raw_hex='00', backend_ms=0.1); f.update(kw)
    c.execute('INSERT INTO frames(%s) VALUES (%s)' % (','.join(f), ','.join('?' * len(f))), tuple(f.values()))
def alert(c, seq, typ='co_threshold', node=1, **kw):
    a = dict(event_seq=seq, session_id=1, node_id=node, type=typ, level='WARNING', raised_ts=1); a.update(kw)
    c.execute('INSERT INTO alerts(%s) VALUES (%s)' % (','.join(a), ','.join('?' * len(a))), tuple(a.values()))
def rejects(fn):
    with pytest.raises(sqlite3.IntegrityError): fn()

def test_schema_dump_equals_0001_sql(tmp_path):
    ref = sqlite3.connect(':memory:'); ref.executescript((MIG / '0001.sql').read_text(encoding='utf8'))
    c = new_db(tmp_path); assert master(c) == master(ref) and applied_versions(c) == [1]
    assert c.execute('SELECT description FROM schema_version').fetchone()[0].startswith('Migration 0001')

def test_roster_trigger_rejects_ok_frame_with_unknown_node_but_not_bad_mac(tmp_path):
    c = new_db(tmp_path); session(c); frame(c, 1, node=3)
    rejects(lambda: frame(c, 2, node=7)); frame(c, 3, node=7, verify='BAD_MAC')            # failing length, CRC or MAC frames are unaffected
    assert c.execute('PRAGMA foreign_key_check').fetchall() == []

def test_seed_counts_and_alert_types_equal_the_catalog(tmp_path):
    c = new_db(tmp_path); n = lambda t: c.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0]
    assert (n('alert_types'), n('audit_actions'), n('system_event_types')) == (25, 18, 29)
    assert {r[0] for r in c.execute('SELECT type FROM alert_types')} == {a['type'] for a in json.loads(CATALOG.read_text(encoding='utf8')) if a['owner'] == 'alerts'}   # banners (owner system_banner) are not alert rows

def test_fresh_and_upgraded_databases_have_the_same_schema_and_a_backup_hook_runs_once(tmp_path):
    d = tmp_path / 'm'; d.mkdir(); (d / '0001.sql').write_text((MIG / '0001.sql').read_text(encoding='utf8'), encoding='utf8')
    (d / '0002.sql').write_text('-- Migration 0002 test\nCREATE TABLE extra (x INTEGER);\n', encoding='utf8')
    a = connect_db(tmp_path / 'a.db'); calls = []; assert run_migrations(a, str(d), 1, lambda: calls.append(1)) == [1, 2] and calls == []   # fresh: nothing to back up
    b = connect_db(tmp_path / 'b.db'); (d / '0002.sql').rename(d / 'x'); run_migrations(b, str(d), 1); (d / 'x').rename(d / '0002.sql')
    assert run_migrations(b, str(d), 2, lambda: calls.append(1)) == [2] and calls == [1] and master(a) == master(b) and applied_versions(b) == [1, 2]
    assert run_migrations(b, str(d), 3, lambda: calls.append(1)) == [] and calls == [1]

def test_a_database_newer_than_the_code_is_refused_and_a_failed_migration_rolls_back(tmp_path):
    c = new_db(tmp_path); c.execute("INSERT INTO schema_version VALUES (9, 1, 'future')")
    with pytest.raises(DatabaseTooNewError): run_migrations(c, str(MIG), 1)
    d = tmp_path / 'm'; d.mkdir(); (d / '0001.sql').write_text('CREATE TABLE ok (x INTEGER);\nCREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_ts INTEGER NOT NULL, description TEXT NOT NULL);', encoding='utf8')
    (d / '0002.sql').write_text('CREATE TABLE half (x INTEGER);\nTHIS IS NOT SQL;', encoding='utf8')
    e = connect_db(tmp_path / 'e.db')
    (d / '0002.sql').rename(d / 'later'); run_migrations(e, str(d), 1); (d / 'later').rename(d / '0002.sql')
    with pytest.raises(sqlite3.Error): run_migrations(e, str(d), 2)
    assert applied_versions(e) == [1] and not e.execute("SELECT 1 FROM sqlite_master WHERE name='half'").fetchone() and not e.in_transaction

def test_open_session_index_second_open_rejected_close_plus_insert_in_one_transaction_accepted(tmp_path):
    c = new_db(tmp_path); session(c, 1); rejects(lambda: session(c, 2))
    c.execute('BEGIN'); c.execute("UPDATE sessions SET ended_ts=5, end_kind='ENDED' WHERE session_id=1"); session(c, 2); c.execute('COMMIT')
    assert c.execute('SELECT COUNT(*) FROM sessions WHERE ended_ts IS NULL').fetchone()[0] == 1

def test_open_alert_index_blocks_a_second_co_threshold_per_node_but_not_unauth_alert(tmp_path):
    c = new_db(tmp_path); session(c); alert(c, 1); rejects(lambda: alert(c, 2)); alert(c, 3, node=2)                  # other node is fine
    alert(c, 4, 'unauth_alert'); alert(c, 5, 'unauth_alert')                                                           # not in the unique index
    c.execute('UPDATE alerts SET cleared_ts=9 WHERE event_seq=1'); alert(c, 6)                                         # cleared: a new one may open
    assert 'idx_alerts_session_cleared' in {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}

def test_check_constraints_reject_bad_values(tmp_path):
    c = new_db(tmp_path); session(c)
    rejects(lambda: frame(c, 1, node_level='BANANA')); rejects(lambda: frame(c, 2, base_verify='XYZ')); rejects(lambda: frame(c, 3, node=None))
    rejects(lambda: frame(c, 4, co_over_range=2)); rejects(lambda: c.execute("UPDATE sessions SET monitoring_active=2"))
    rejects(lambda: c.execute("UPDATE sessions SET ended_ts=5")); rejects(lambda: c.execute("UPDATE sessions SET end_kind='ENDED'"))
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'a', 'h', 1, 1)")
    c.execute("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state) VALUES (1, 1, 'MAN_DOWN', 1, 'OPEN')")
    rejects(lambda: c.execute("UPDATE episodes SET state='RESOLVED'"))                                                  # no resolved_ts, reason or resolver

def test_init_event_seq_is_one_plus_the_maximum_over_all_six_columns(tmp_path):
    c = new_db(tmp_path); session(c); assert init_event_seq(c) == 1
    frame(c, 5); alert(c, 7, cleared_event_seq=40, cleared_ts=2); assert init_event_seq(c) == 41                      # cleared_event_seq counts
    c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind) VALUES (1, 90, 1, 'HOST_START')"); assert init_event_seq(c) == 91
    c.execute("INSERT INTO advisory_summaries(session_id, event_seq, ts, node_id, window_s, risk, reasons, action, source, quality) VALUES (1, 120, 1, 1, 60, 'NOMINAL', 'r', 'a', 'table', 'high')"); assert init_event_seq(c) == 121

def test_connect_db_pragmas_on_every_connection(tmp_path):
    c = new_db(tmp_path); g = lambda k: c.execute('PRAGMA ' + k).fetchone()[0]
    assert (g('foreign_keys'), g('busy_timeout'), g('journal_mode'), g('synchronous')) == (1, 5000, 'wal', 2)
    r = connect_db(tmp_path / 't.db', readonly=True); assert r.execute('PRAGMA foreign_keys').fetchone()[0] == 1 and r.execute('PRAGMA busy_timeout').fetchone()[0] == 5000
    with pytest.raises(sqlite3.OperationalError): r.execute('DELETE FROM roster')
    n = connect_db(tmp_path / 'n.db', synchronous='NORMAL'); assert n.execute('PRAGMA synchronous').fetchone()[0] == 1
