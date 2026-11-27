"""P24-2: start-up steps 6 and 7 (design 14.5, 2.3 session resume, section 1 restart sequence). Requirements: REQ-DB-006, REQ-REC-001, REQ-REC-007."""
import json
import pytest
from ppe_host import main as M
from ppe_host.clock import FakeClock
from test_startup import home, run, corrupt, good_backup, no_serve, NOW

MIN = 60_000
def start(h, mode='LIVE', dt=0, **kw):
    st = run(h, mode, **kw); M.begin_session(st, FakeClock(NOW + dt, 5000)); return st
def sysrows(st, sid=None):
    q = 'SELECT event_seq, kind, detail, session_id FROM system_events' + (' WHERE session_id = %d' % sid if sid else '') + ' ORDER BY event_seq'
    return st.conn.execute(q).fetchall()

def test_first_start_opens_one_session_and_logs_host_start_and_recovering_enter(tmp_path):
    h = home(tmp_path); st = start(h); c = st.conn
    s = c.execute('SELECT session_id, mode, monitoring_active, constants_hash, settings_hash, host_build, ended_ts FROM sessions').fetchall()
    assert len(s) == 1 and s[0][1:3] == ('LIVE', 0) and len(s[0][3]) == 64 and len(s[0][4]) == 64 and s[0][5].startswith('ppe-host') and s[0][6] is None
    rows = sysrows(st); assert [(r[0], r[1]) for r in rows] == [(1, 'HOST_START'), (2, 'RECOVERING_ENTER')] and st.event_seq == 3 and st.recovering and not st.resumed
    d = json.loads(rows[0][2]); assert d['host_boot_id'] == st.host_boot_id and len(d['host_boot_id']) == 32 and d['mono_base_ms'] == 5000 and d['wall_base_ms'] == NOW; st.close()

def test_restart_within_30_minutes_resumes_the_same_session_and_continues_event_seq(tmp_path):
    h = home(tmp_path); a = start(h); sid = a.session_id; a.close(); b = start(h, dt=29 * MIN)
    assert b.resumed and b.session_id == sid and b.conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1
    assert [r[0] for r in sysrows(b)] == [1, 2, 3, 4] and b.host_boot_id != a.host_boot_id; b.close()

def test_a_session_whose_last_row_is_30_minutes_old_is_closed_abandoned_and_a_new_one_opens(tmp_path):
    h = home(tmp_path); a = start(h); old = a.session_id; a.close(); b = start(h, dt=30 * MIN); c = b.conn
    assert not b.resumed and b.session_id != old
    assert c.execute('SELECT end_kind, ended_ts FROM sessions WHERE session_id = ?', (old,)).fetchone() == ('ABANDONED', NOW + 30 * MIN)
    assert [(r[1], r[2]) for r in sysrows(b, old)][-1] == ('SESSION_ABANDONED', 'stale_30min')
    assert c.execute('SELECT COUNT(*) FROM sessions WHERE ended_ts IS NULL').fetchone()[0] == 1 and c.execute('SELECT monitoring_active FROM sessions WHERE session_id = ?', (b.session_id,)).fetchone()[0] == 0; b.close()

def test_a_changed_mode_closes_the_session_with_mode_changed(tmp_path):
    h = home(tmp_path); a = start(h); a.conn.execute("UPDATE sessions SET mode = 'REPLAY'"); a.close(); b = start(h, dt=MIN)
    assert [(r[1], r[2]) for r in sysrows(b, a.session_id)][-1] == ('SESSION_ABANDONED', 'mode_changed') and b.session_id != a.session_id; b.close()

def test_a_changed_hash_closes_the_session_logs_config_changed_and_leaves_open_alerts_alone(tmp_path, monkeypatch):
    h = home(tmp_path); a = start(h); old = a.session_id
    a.conn.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (?, ?, 1, 'man_down', 'DANGER', ?)", (a.event_seq, old, NOW)); a.close()
    monkeypatch.setattr(M, 'constants_hash', lambda: 'f' * 64); b = start(h, dt=MIN)
    assert [(r[1], r[2]) for r in sysrows(b, old)][-1] == ('SESSION_ABANDONED', 'config_hash_changed') and b.session_id != old
    assert b.conn.execute('SELECT constants_hash FROM sessions WHERE session_id = ?', (b.session_id,)).fetchone()[0] == 'f' * 64
    assert 'CONFIG_CHANGED' in [r[1] for r in sysrows(b, b.session_id)] and 'CONFIG_CHANGED' not in [r[1] for r in sysrows(b, old)]
    assert b.conn.execute("SELECT session_id, cleared_ts FROM alerts WHERE type = 'man_down'").fetchone() == (old, None); b.close()

def test_a_resumed_session_with_the_same_hashes_logs_no_config_changed(tmp_path):
    h = home(tmp_path); start(h).close(); b = start(h, dt=MIN); assert 'CONFIG_CHANGED' not in [r[1] for r in sysrows(b)]; b.close()

# ---- P24b: the crash marker, read at the next start (ADR 0036) ----

def marker_body(**over):
    body = dict(v=1, kind='stall', ts=NOW, pid=1234, limit_ms=3000, stalled='tick', age_ms=3100, stale={'tick': 3100}, ages={'serial': 10, 'tick': 3100})
    body.update(over); return body

def test_no_marker_means_no_liveness_restart_row(tmp_path):
    h = home(tmp_path); st = start(h); assert 'LIVENESS_RESTART' not in [r[1] for r in sysrows(st)]; st.close()

def test_a_crash_marker_from_a_stalled_tick_logs_liveness_restart_and_tick_stall(tmp_path):
    from ppe_host.io.os_watchdog import write_marker, MARKER_NAME
    h = home(tmp_path); (h / 'logs').mkdir(parents=True, exist_ok=True)
    body = marker_body(); write_marker(h / 'logs' / MARKER_NAME, body)
    st = start(h); rows = [(r[1], r[2]) for r in sysrows(st)]
    kinds = [k for k, _ in rows]; assert kinds == ['HOST_START', 'RECOVERING_ENTER', 'LIVENESS_RESTART', 'TICK_STALL']
    restart_detail = json.loads(dict(rows)['LIVENESS_RESTART']); assert restart_detail == body
    stall_detail = json.loads(dict(rows)['TICK_STALL']); assert stall_detail == {'age_ms': 3100}
    assert not (h / 'logs' / MARKER_NAME).exists()
    assert json.loads((h / 'logs' / 'crash_marker.last.json').read_text()) == body
    st.close()

def test_a_marker_whose_stale_part_was_not_tick_logs_liveness_restart_but_not_tick_stall(tmp_path):
    from ppe_host.io.os_watchdog import write_marker, MARKER_NAME
    h = home(tmp_path); (h / 'logs').mkdir(parents=True, exist_ok=True)
    body = marker_body(stalled='serial', stale={'serial': 5000}, ages={'serial': 5000})
    write_marker(h / 'logs' / MARKER_NAME, body)
    st = start(h); kinds = [r[1] for r in sysrows(st)]
    assert kinds == ['HOST_START', 'RECOVERING_ENTER', 'LIVENESS_RESTART'] and 'TICK_STALL' not in kinds; st.close()

def test_an_unreadable_marker_still_logs_liveness_restart(tmp_path):
    h = home(tmp_path); (h / 'logs').mkdir(parents=True, exist_ok=True); (h / 'logs' / 'crash_marker.json').write_text('{bad')
    st = start(h); rows = [(r[1], r[2]) for r in sysrows(st)]
    assert [k for k, _ in rows] == ['HOST_START', 'RECOVERING_ENTER', 'LIVENESS_RESTART']
    assert json.loads(dict(rows)['LIVENESS_RESTART']) == {'kind': 'unreadable'}; st.close()

def test_the_marker_is_consumed_once_a_second_start_in_a_row_logs_no_more_liveness_restart(tmp_path):
    from ppe_host.io.os_watchdog import write_marker, MARKER_NAME
    h = home(tmp_path); (h / 'logs').mkdir(parents=True, exist_ok=True); write_marker(h / 'logs' / MARKER_NAME, marker_body())
    a = start(h); before = len(sysrows(a)); assert 'LIVENESS_RESTART' in [r[1] for r in sysrows(a)]; a.close()
    b = start(h, dt=MIN); new_rows = sysrows(b)[before:]                  # only the rows the second start itself added
    assert b.session_id == a.session_id and b.resumed                    # same session: the marker was moved to .last.json on the first read, so the second finds none
    assert 'LIVENESS_RESTART' not in [r[1] for r in new_rows]; b.close()

# ---- quick_check failure rows ----
def test_live_restore_writes_integrity_fail_and_db_restored_with_session_id_null(tmp_path):
    h = home(tmp_path, salt=True); good_backup(h, 'g.db', 100); corrupt(h / 'data' / 'ppe.db'); st = start(h)
    r = {x[1]: x for x in sysrows(st)}; assert 'quarantined ppe.db.corrupt-' in r['INTEGRITY_FAIL'][2] and 'g.db' in r['INTEGRITY_FAIL'][2] and r['INTEGRITY_FAIL'][3] == st.session_id
    a = st.conn.execute("SELECT session_id, event_seq, operator_id, reason FROM audit_events WHERE action = 'DB_RESTORED'").fetchall(); assert a == [(None, st.event_seq - 1, None, 'g.db')]
    assert st.host_gap_reason == 'db_restored'; st.close()

def test_live_with_no_good_backup_still_writes_db_restored_naming_the_fresh_database(tmp_path):
    h = home(tmp_path, salt=True); (h / 'data').mkdir(); corrupt(h / 'data' / 'ppe.db'); st = start(h)
    assert st.conn.execute("SELECT reason FROM audit_events WHERE action = 'DB_RESTORED'").fetchone() == ('fresh database',) and 'none (fresh database)' in {x[1]: x for x in sysrows(st)}['INTEGRITY_FAIL'][2]; st.close()

def test_simulator_logs_integrity_fail_but_no_db_restored_and_no_banner(tmp_path):
    h = home(tmp_path, salt=True); (h / 'data').mkdir(); corrupt(h / 'data' / 'ppe_test.db'); st = start(h, 'SIMULATOR')
    assert 'INTEGRITY_FAIL' in [r[1] for r in sysrows(st)] and st.conn.execute("SELECT COUNT(*) FROM audit_events WHERE action = 'DB_RESTORED'").fetchone()[0] == 0 and st.host_gap_reason is None; st.close()

def test_a_failure_inside_the_transaction_leaves_no_session_and_no_rows(tmp_path, monkeypatch):
    h = home(tmp_path); st = run(h); real = M._sys
    def boom(conn, s, sid, ts, kind, detail=None):
        if kind == 'RECOVERING_ENTER': raise RuntimeError('disk')
        real(conn, s, sid, ts, kind, detail)
    monkeypatch.setattr(M, '_sys', boom)
    with pytest.raises(RuntimeError): M.begin_session(st, FakeClock(NOW, 1))
    assert st.conn.execute('SELECT (SELECT COUNT(*) FROM sessions), (SELECT COUNT(*) FROM system_events)').fetchone() == (0, 0) and not st.recovering; st.close()

def test_main_runs_steps_1_to_7_and_releases_the_lock(tmp_path, capsys):
    h = home(tmp_path); assert M.main(['--home', str(h)], serve=no_serve) == 0 and not (h / M.LOCK_NAME).exists() and 'steps 1 to 9 done' in capsys.readouterr().out
    import sqlite3; assert sqlite3.connect(str(h / 'data' / 'ppe.db')).execute("SELECT COUNT(*) FROM system_events WHERE kind = 'HOST_START'").fetchone()[0] == 1
