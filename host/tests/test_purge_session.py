"""P26-2 (ADR 0039): purge-session (services/purge.py and the cli command). Real migrated database in a temporary PPE_HOME; session 1 and 2 closed, session 3 open.
The rows of session 1 go from every table in foreign-key order with secure_delete (a marker in the file bytes is gone, also from the -wal file), the audit row has session_id NULL and the id as reason;
the refusals (live lockfile, a monitoring session, an open session: exit 1 and no row; an open alert, an unresolved episode, a foreign-key violation: exit 2, an audit row and nothing deleted);
backup copies (local and USB) are purged with their read-only attribute put back, exports/session_<id>_*.csv are deleted, and a purge that stopped half way can be run again. Requirements: REQ-SES-003."""
import json, os, sqlite3, stat
import pytest
from ppe_host import cli
from ppe_host.io.backup import online_backup, verify_backup
from ppe_host.io.db_writer import connect_db
from ppe_host.main import LOCK_NAME, process_start
from ppe_host.services import purge as P
from test_db_schema import alert, frame, new_db, session

MARK = 'PURGE-MARKER-7f3a'

def build(tmp_path):
    home = tmp_path / 'home'; home.mkdir(); c = new_db(tmp_path, 'live.db')
    c.execute("INSERT INTO operators(display_name, token_hash, created_ts, token_issued_ts) VALUES ('Ana', 'x', 1, 1)")
    session(c, 1, ended=500); session(c, 2, ended=900); session(c, 3)
    for sid, base in ((1, 100), (2, 200)):
        frame(c, base + 1, 1, session_id=sid, raw_hex=(MARK if sid == 1 else 'keep')); frame(c, base + 2, 2, session_id=sid)
        c.execute("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state, resolved_ts, resolve_reason, resolved_by) VALUES (?, 1, 'MAN_DOWN', 10, 'RESOLVED', 20, 'rescued', 1)", (sid,))
        eid = c.execute('SELECT MAX(episode_id) FROM episodes').fetchone()[0]; fid = c.execute('SELECT MAX(frame_id) FROM frames WHERE session_id = ?', (sid,)).fetchone()[0]
        alert(c, base + 3, 'man_down', 1, session_id=sid, cleared_ts=30, cleared_event_seq=base + 4, frame_id=fid, episode_id=eid, level='DANGER')
        c.execute("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action) VALUES (?, ?, 5, 1, 'ACK_ALERT')", (sid, base + 5))
        c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (?, ?, 5, 'COUNTERS', ?)", (sid, base + 6, MARK if sid == 1 else 'keep'))
        c.execute('INSERT INTO base_health(session_id, ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac) VALUES (?, 5, 1, 90, 1, 0, 0, 0)', (sid,))
        c.execute("INSERT INTO advisory_summaries(session_id, event_seq, ts, node_id, window_s, risk, reasons, action, source, quality) VALUES (?, ?, 5, 1, 60, 'NOMINAL', 'r', 'a', 'table', 'high')", (sid, base + 7))
        c.execute("INSERT INTO checkpoints(session_id, created_ts, last_event_seq, constants_hash, state_json, state_sha256) VALUES (?, 5, ?, 'c', '{}', 's')", (sid, base + 8))
    c.execute("INSERT INTO audit_events(session_id, event_seq, ts, action, reason) VALUES (NULL, 0, 1, 'OPERATOR_ADDED', 'operator_id 1')")
    c.close(); return home, tmp_path / 'live.db'

def run(home, db, *args): return cli.main(['purge-session', '--home', str(home), '--db', str(db)] + [str(x) for x in args])
def q(db, sql, *p): c = connect_db(db, readonly=True); r = c.execute(sql, p).fetchall(); c.close(); return r
def per_session(db, sid):
    c = connect_db(db, readonly=True); tabs = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
    out = {t: c.execute('SELECT COUNT(*) FROM %s WHERE session_id = ?' % t, (sid,)).fetchone()[0] for t in tabs if any(col[1] == 'session_id' for col in c.execute('PRAGMA table_info(%s)' % t))}
    c.close(); return out
def audits(db): return q(db, "SELECT session_id, event_seq, operator_id, action, reason FROM audit_events WHERE action = 'SESSION_PURGED'")
def snapshot(db): return {sid: per_session(db, sid) for sid in (1, 2, 3)}

def test_a_closed_session_is_deleted_from_every_table_and_the_others_and_the_roster_stay(tmp_path, capsys):
    home, db = build(tmp_path); before = snapshot(db); assert all(n > 0 for t, n in before[1].items() if t != 'sessions') and before[1]['sessions'] == 1
    assert run(home, db, '--session-id', 1) == 0
    assert set(per_session(db, 1).values()) == {0} and snapshot(db)[2] == before[2] and snapshot(db)[3] == before[3]
    assert q(db, 'PRAGMA foreign_key_check') == [] and q(db, 'SELECT COUNT(*) FROM roster') == [(3,)] and q(db, 'SELECT COUNT(*) FROM operators') == [(1,)]
    assert audits(db) == [(None, 0, None, 'SESSION_PURGED', '1')] and q(db, "SELECT COUNT(*) FROM audit_events WHERE action = 'OPERATOR_ADDED'") == [(1,)]      # the offline rows without a session stay
    assert 'session 1 purged' in capsys.readouterr().out

def test_nothing_of_the_deleted_rows_stays_in_the_file_or_the_wal(tmp_path):
    home, db = build(tmp_path); data = db.read_bytes() + (db.parent / 'live.db-wal').read_bytes() if (db.parent / 'live.db-wal').exists() else db.read_bytes(); assert MARK.encode() in data
    assert run(home, db, '--session-id', 1) == 0
    after = b''.join(f.read_bytes() for f in (db, db.parent / 'live.db-wal', db.parent / 'live.db-shm') if f.exists()); assert MARK.encode() not in after
    assert not (db.parent / 'live.db-wal').exists() or (db.parent / 'live.db-wal').stat().st_size == 0                                                          # wal_checkpoint(TRUNCATE)
    assert b'keep' in after                                                                                                                                  # the other session is still there

def test_a_live_host_lockfile_refuses_the_purge_and_a_stale_one_does_not(tmp_path, capsys):
    home, db = build(tmp_path); tok = process_start(os.getpid())
    if tok is None: pytest.skip('no process table on this platform')
    (home / LOCK_NAME).write_text(json.dumps({'pid': os.getpid(), 'start': tok}))                                                              # this very process is the "host"
    before = snapshot(db); assert run(home, db, '--session-id', 1) == 1 and 'host is running' in capsys.readouterr().err
    assert snapshot(db) == before and audits(db) == []                                                                                        # exit 1 records nothing
    (home / LOCK_NAME).write_text(json.dumps({'pid': os.getpid(), 'start': -1})); assert run(home, db, '--session-id', 1) == 0                  # PID reuse: the start time differs, so the lock is stale

def test_a_monitoring_session_an_open_session_and_an_unknown_id_refuse_with_exit_1_and_no_row(tmp_path, capsys):
    home, db = build(tmp_path); before = snapshot(db)
    assert run(home, db, '--session-id', 3) == 1 and 'still open' in capsys.readouterr().err
    c = connect_db(db); c.execute('UPDATE sessions SET monitoring_active = 1 WHERE session_id = 3'); c.close()
    assert run(home, db, '--session-id', 1) == 1 and 'monitoring' in capsys.readouterr().err
    c = connect_db(db); c.execute('UPDATE sessions SET monitoring_active = 0 WHERE session_id = 3'); c.close()
    assert run(home, db, '--session-id', 99) == 1 and 'found in no database' in capsys.readouterr().err
    assert snapshot(db) == before and audits(db) == []

def test_an_open_alert_refuses_with_exit_2_and_an_audit_row_and_a_purge_after_it_is_cleared_works(tmp_path, capsys):
    home, db = build(tmp_path); c = connect_db(db); alert(c, 150, 'co_threshold', 2, session_id=1); c.close(); before = snapshot(db)
    assert run(home, db, '--session-id', 1) == 2 and '1 open alert' in capsys.readouterr().err
    assert snapshot(db) == before and audits(db) == [(None, 0, None, 'SESSION_PURGED', 'refused 1: session 1 still has 1 open alert(s) and 0 unresolved episode(s): clear and Resolve them first')]
    c = connect_db(db); c.execute('UPDATE alerts SET cleared_ts = 40, cleared_event_seq = 151 WHERE event_seq = 150'); c.close()
    assert run(home, db, '--session-id', 1) == 0 and set(per_session(db, 1).values()) == {0} and q(db, 'PRAGMA foreign_key_check') == []
    assert [a[4] for a in audits(db)][-1] == '1' and len(audits(db)) == 2

def test_an_unresolved_episode_refuses_with_exit_2_until_it_is_resolved(tmp_path, capsys):
    home, db = build(tmp_path); c = connect_db(db)
    c.execute("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state) VALUES (1, 2, 'MAYDAY', 10, 'ACKNOWLEDGED')"); c.close(); before = snapshot(db)
    assert run(home, db, '--session-id', 1) == 2 and '1 unresolved episode' in capsys.readouterr().err and snapshot(db) == before and 'refused 1' in audits(db)[0][4]
    c = connect_db(db); c.execute("UPDATE episodes SET state = 'RESOLVED', resolved_ts = 50, resolve_reason = 'rescued', resolved_by = 1 WHERE state = 'ACKNOWLEDGED'"); c.close()
    assert run(home, db, '--session-id', 1) == 0 and q(db, 'PRAGMA foreign_key_check') == []

def test_a_foreign_key_violation_from_a_later_session_rolls_back_everything_exit_2(tmp_path, capsys):
    home, db = build(tmp_path); c = connect_db(db); fid = c.execute('SELECT MIN(frame_id) FROM frames WHERE session_id = 1').fetchone()[0]
    c.execute("INSERT INTO alerts(event_seq, session_id, frame_id, node_id, type, level, raised_ts, cleared_ts, cleared_event_seq) VALUES (777, 2, ?, 2, 'battery_low', 'WARNING', 5, 6, 778)", (fid,)); c.close(); before = snapshot(db)
    assert run(home, db, '--session-id', 1) == 2 and 'rolled back' in capsys.readouterr().err
    assert snapshot(db) == before and q(db, 'PRAGMA foreign_key_check') == [] and 'refused 1: rolled back' in audits(db)[0][4]

def make_copies(tmp_path, db, home):
    local = online_backup(db, home / 'backups' / 'end-shift-1.db'); usb = online_backup(db, tmp_path / 'usb' / 'end-shift-1.db')
    old = tmp_path / 'ancient.db'; c = new_db(tmp_path, 'ancient.db'); session(c, 2, ended=900); c.close(); online_backup(old, home / 'backups' / 'before-session-1.db')
    return local, usb

def test_local_and_usb_copies_are_purged_keep_the_read_only_attribute_and_still_verify(tmp_path, capsys):
    home, db = build(tmp_path); local, usb = make_copies(tmp_path, db, home); untouched = (home / 'backups' / 'before-session-1.db'); stamp = untouched.stat().st_mtime_ns
    assert run(home, db, '--session-id', 1, '--usb-dir', tmp_path / 'usb') == 0
    for f in (local, usb):
        assert verify_backup(f) == (True, 'ok') and not (os.stat(f).st_mode & stat.S_IWRITE) and set(per_session(f, 1).values()) == {0} and per_session(f, 2)['frames'] == 2
        assert MARK.encode() not in f.read_bytes()
    assert untouched.stat().st_mtime_ns == stamp                                                          # a copy without the session is not opened for writing
    out = capsys.readouterr().out; assert out.count('purged (') == 2

def test_a_file_that_is_not_a_ppe_database_is_skipped_and_never_changed(tmp_path, capsys):
    home, db = build(tmp_path); (home / 'backups').mkdir(); junk = home / 'backups' / 'notes.db'; junk.write_bytes(b'not a database at all'); other = home / 'backups' / 'other.db'
    c = sqlite3.connect(other); c.execute('CREATE TABLE t(x)'); c.commit(); c.close()
    assert run(home, db, '--session-id', 1) == 0 and junk.read_bytes() == b'not a database at all' and 'skipped' in capsys.readouterr().out

def test_a_missing_usb_drive_gives_exit_2_after_the_live_purge_and_a_second_run_finishes_the_job(tmp_path, capsys):
    home, db = build(tmp_path); local, usb = make_copies(tmp_path, db, home); gone = tmp_path / 'usb'; moved = tmp_path / 'usb_unplugged'; gone.rename(moved)
    assert run(home, db, '--session-id', 1, '--usb-dir', gone) == 2 and 'does not exist' in capsys.readouterr().err
    assert set(per_session(db, 1).values()) == {0} and set(per_session(local, 1).values()) == {0} and per_session(moved / 'end-shift-1.db', 1)['frames'] == 2    # the drive was not there: its copy still holds the session
    moved.rename(gone); assert run(home, db, '--session-id', 1, '--usb-dir', gone) == 0 and set(per_session(gone / 'end-shift-1.db', 1).values()) == {0}
    assert [a[4] for a in audits(db)] == ['1', '1']                                                                                                         # the second run is recorded too
    assert run(home, db, '--session-id', 1, '--usb-dir', gone) == 1                                                                                        # nothing left anywhere

def test_exports_of_the_session_are_deleted_others_stay_and_a_whole_database_export_is_warned_about(tmp_path, capsys):
    home, db = build(tmp_path); ex = home / 'exports'; ex.mkdir()
    for n in ('session_1_20231114.csv', 'session_1_second.csv', 'session_2_20231114.csv', 'session_10_x.csv', 'export_all_20231114.csv'): (ex / n).write_text('x')
    os.chmod(ex / 'session_1_second.csv', stat.S_IREAD)
    assert run(home, db, '--session-id', 1) == 0
    assert sorted(f.name for f in ex.iterdir()) == ['export_all_20231114.csv', 'session_10_x.csv', 'session_2_20231114.csv']                                  # session_1_* only, not session_10_*
    cap = capsys.readouterr(); assert 'export_all_20231114.csv' in cap.err and 'deleted session_1_20231114.csv, session_1_second.csv' in cap.out

def test_the_functions_are_usable_without_the_cli(tmp_path):
    home, db = build(tmp_path); c = connect_db(db)
    P.check_purgeable(c, 1)
    with pytest.raises(P.Refused) as e: P.check_purgeable(c, 3)
    assert (e.value.code, e.value.audit) == (1, False); c.close()
    counts = P.purge_live(db, 1, now_ms=123); assert counts['sessions'] == 1 and counts['frames'] == 2 and audits(db)[0][3] == 'SESSION_PURGED' and q(db, "SELECT ts FROM audit_events WHERE action = 'SESSION_PURGED'") == [(123,)]
