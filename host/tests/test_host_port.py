"""P24-3b-1: HostPort (host_port.py) and Ingest.audit / Ingest.write. Real DBWriter, database, Authenticator and FakeClock; the REST routes themselves are P19 and are not run here.
Covers design 3.8 (session start, Acknowledge, Resolve, SCBA correction, banner acknowledge), 8 (durable operator rows), 14.1 (an unauth_alert closes with its Acknowledge, GV-10). Requirements: REQ-API-005, REQ-API-008, REQ-RUL-002, REQ-RUL-004."""
import pytest
from ppe_host.api import security as sec
from ppe_host.host_port import HostPort
from test_effect_rows import by_type, op, wait
from test_gv_bytes import WRONG_KEY, pack
from test_ingest import rig, rows, send

SALT = '00' * 32
S = {'recovering_target_s': 3, 'login_backoff_cap_s': 5}
def port(tmp_path, **kw):
    c, w, clock, ing = rig(tmp_path); op(c, 1); op(c, 2)
    c.execute('UPDATE operators SET display_name = ?, token_hash = ? WHERE operator_id = 1', ('Ana', sec.hash_token(SALT, 'tok-ana')))
    p = HostPort(ing, tmp_path / 't.db', S, sec.Authenticator(tmp_path / 't.db', SALT, 5), **kw)
    return c, w, clock, ing, p
def settle(w, ing): wait(w, ing.write([]))           # an empty unit queues behind everything before it

def test_audit_takes_the_next_event_seq_the_current_session_and_the_operator_and_commits_in_order(tmp_path):
    c, w, clock, ing, p = port(tmp_path); r = send(ing, clock, pack(seq=1))
    p.audit('LOGIN_OK', operator_id=1); p.audit('ORIGIN_REJECTED'); settle(w, ing)
    a = rows(c, 'SELECT * FROM audit_events ORDER BY event_seq')
    assert [(x['action'], x['operator_id'], x['session_id']) for x in a] == [('LOGIN_OK', 1, 1), ('ORIGIN_REJECTED', None, 1)] and a[0]['event_seq'] > r.event_seq and a[0]['event_seq'] < a[1]['event_seq']
    p.audit('ACK_ALERT', operator_id=1, node_id=1, episode_id=None, reason='alert_id 5'); settle(w, ing)
    assert rows(c, "SELECT node_id, reason FROM audit_events WHERE action = 'ACK_ALERT'") == [{'node_id': 1, 'reason': 'alert_id 5'}]
    w.stop()

def test_an_audit_row_that_breaks_a_constraint_is_skipped_and_counted_and_later_rows_still_commit(tmp_path):
    c, w, clock, ing, p = port(tmp_path); p.audit('LOGIN_OK', operator_id=99); p.audit('LOGIN_OK', operator_id=1); settle(w, ing)
    assert [x['operator_id'] for x in rows(c, 'SELECT * FROM audit_events')] == [1] and w.counters['write_rejected'] == 1
    w.stop()

def test_authenticate_and_the_failed_login_delay_come_from_the_authenticator(tmp_path):
    c, w, clock, ing, p = port(tmp_path)
    assert p.authenticate('tok-ana').operator_id == 1 and p.authenticate('nope') is None
    assert [p.login_failed(), p.login_failed(), p.login_failed()] == [1.0, 2.0, 4.0]; p.login_ok(); assert p.login_failed() == 1.0
    assert p.session_id() == 1; w.stop()

def test_recovering_retry_is_the_target_while_recovering_and_none_after(tmp_path):
    c, w, clock, ing, p = port(tmp_path); assert p.recovering_retry_s() == 3
    p.set_recovering(False); assert p.recovering_retry_s() is None; w.stop()

def test_client_dropped_writes_a_system_row(tmp_path):
    c, w, clock, ing, p = port(tmp_path); p.client_dropped('send timeout over 1.0 s on /ws'); settle(w, ing)
    assert rows(c, 'SELECT kind, detail, session_id FROM system_events') == [{'kind': 'CLIENT_DROPPED', 'detail': 'send timeout over 1.0 s on /ws', 'session_id': 1}]; w.stop()

def test_start_monitoring_is_idempotent_and_never_changes_the_operator_or_the_label(tmp_path):
    c, w, clock, ing, p = port(tmp_path); assert p.monitoring_active is False
    row, changed = p.start_monitoring(1, 'night shift'); wait(w, ing.write([]))
    assert (row.session_id, row.mode, changed) == (1, 'LIVE', True) and row.started_ts == 1
    s = rows(c, 'SELECT * FROM sessions')[0]; assert (s['monitoring_active'], s['operator_id'], s['session_label']) == (1, 1, 'night shift')
    row2, changed2 = p.start_monitoring(2, 'other'); wait(w, ing.write([]))
    s = rows(c, 'SELECT * FROM sessions')[0]; assert changed2 is False and row2 == row and (s['operator_id'], s['session_label']) == (1, 'night shift'); w.stop()

def test_a_resumed_session_that_was_already_monitoring_does_not_start_again(tmp_path):
    c, w, clock, ing = rig(tmp_path); op(c, 1); c.execute('UPDATE sessions SET monitoring_active = 1, operator_id = 1')
    p = HostPort(ing, tmp_path / 't.db', S, sec.Authenticator(tmp_path / 't.db', SALT, 5)); assert p.monitoring_active is True and p.start_monitoring(1, None)[1] is False; w.stop()

def test_ack_alert_goes_through_the_engine_is_idempotent_and_an_unknown_id_is_none(tmp_path):      # GV-09
    seen = []; c, w, clock, ing, p = port(tmp_path, publish=lambda fx, u, ok: seen.append((fx, ok)))
    r = send(ing, clock, pack(seq=1, co_x10=520, flags=1)); wait(w, r.unit); aid = by_type(c, 'co_threshold')[0]['alert_id']
    a = p.ack_alert(aid, 1); wait(w, ing.write([]))
    row = by_type(c, 'co_threshold')[0]; assert (a.alert_id, a.node_id, a.acknowledged_by) == (aid, 1, 1) and row['acknowledged_by'] == 1 and row['acknowledged_ts'] == a.acknowledged_ts and row['cleared_ts'] is None
    assert seen and seen[0][1] is True and type(seen[0][0][0]).__name__ == 'AlertAcknowledged'          # the publish hook got the effects after the commit
    clock.advance(5000); b = p.ack_alert(aid, 2); assert (b.acknowledged_ts, b.acknowledged_by) == (a.acknowledged_ts, 1)        # the first acknowledgement stands
    assert p.ack_alert(9999, 1) is None; w.stop()

def test_ack_alert_on_a_cleared_alert_writes_the_row_directly(tmp_path):                           # 3.8: 200 also for a cleared alert
    c, w, clock, ing, p = port(tmp_path); r = send(ing, clock, pack(seq=1, co_x10=520, flags=1)); wait(w, r.unit)
    for s in range(2, 20): r = send(ing, clock, pack(seq=s, co_x10=0)); wait(w, r.unit)
    row = by_type(c, 'co_threshold')[0]; assert row['cleared_ts'] is not None and row['acknowledged_ts'] is None
    a = p.ack_alert(row['alert_id'], 1); wait(w, ing.write([])); row = by_type(c, 'co_threshold')[0]
    assert row['acknowledged_by'] == 1 and row['acknowledged_ts'] == a.acknowledged_ts and a.acknowledged_by == 1; w.stop()

def test_acknowledging_an_unauth_alert_closes_it(tmp_path):                                        # GV-04, GV-10
    c, w, clock, ing, p = port(tmp_path); r = send(ing, clock, pack(seq=200, flags=6, node=2, key=WRONG_KEY), base='BAD_MAC'); wait(w, r.unit)
    aid = by_type(c, 'unauth_alert')[0]['alert_id']; p.ack_alert(aid, 1); wait(w, ing.write([]))
    row = by_type(c, 'unauth_alert')[0]; assert row['acknowledged_by'] == 1 and row['cleared_ts'] is not None and (2, 'unauth_alert') not in ing.st.alerts; w.stop()

def test_episode_acknowledge_then_resolve_with_the_latch_still_set_and_a_second_resolve_conflicts(tmp_path):   # GV-02, GV-20
    c, w, clock, ing, p = port(tmp_path); r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit); eid = rows(c, 'SELECT episode_id FROM episodes')[0]['episode_id']
    a = p.ack_episode(eid, 1); wait(w, ing.write([])); e = rows(c, 'SELECT * FROM episodes')[0]
    assert (a.episode_id, a.node_id, a.acknowledged_by) == (eid, 1, 1) and (e['state'], e['acknowledged_by']) == ('ACKNOWLEDGED', 1)
    assert p.ack_episode(eid, 2).acknowledged_by == 1                                              # repeat: the first acknowledgement stands
    z = p.resolve_episode(eid, 'rescued', 1); wait(w, ing.write([])); e = rows(c, 'SELECT * FROM episodes')[0]
    assert (z.state if hasattr(z, 'state') else 'RESOLVED', z.resolve_reason, z.resolved_by, z.latch_still_set) == ('RESOLVED', 'rescued', 1, True) and (e['state'], e['resolve_reason']) == ('RESOLVED', 'rescued')
    assert all(x['cleared_ts'] is not None for x in by_type(c, 'man_down'))
    for call in (lambda: p.resolve_episode(eid, 'rescued', 1), lambda: p.ack_episode(eid, 1)):
        with pytest.raises(Exception) as ex: call()
        assert (ex.value.status, ex.value.env.error_code) == (409, 'STATE_CONFLICT')
    assert p.ack_episode(9999, 1) is None and p.resolve_episode(9999, 'rescued', 1) is None; w.stop()

def test_resolve_after_the_jacket_cancelled_reports_the_latch_clear(tmp_path):
    c, w, clock, ing, p = port(tmp_path); r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit); r = send(ing, clock, pack(seq=2, flags=0)); wait(w, r.unit)
    assert p.resolve_episode(rows(c, 'SELECT episode_id FROM episodes')[0]['episode_id'], 'false_alarm', 1).latch_still_set is False; w.stop()

def test_an_episode_the_engine_does_not_hold_is_a_state_conflict_not_a_crash(tmp_path):            # open episodes are loaded into the engine in P24-3c
    c, w, clock, ing, p = port(tmp_path); r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit); eid = rows(c, 'SELECT episode_id FROM episodes')[0]['episode_id']
    ing.st = type(ing.st)(event_seq=ing.st.event_seq)                                               # a restarted engine with no state
    for call in (lambda: p.ack_episode(eid, 1), lambda: p.resolve_episode(eid, 'rescued', 1)):
        with pytest.raises(Exception) as ex: call()
        assert (ex.value.status, ex.value.env.error_code) == (409, 'STATE_CONFLICT')
    w.stop()

def test_scba_correction_is_live_state_for_a_rostered_node_with_the_operator_name(tmp_path):
    c, w, clock, ing, p = port(tmp_path); clock.advance(7)
    r = p.set_scba_correction(2, 'note', 1); assert (r.recorded_ts, r.operator) == (clock.wall_ms(), 'Ana') and p.scba[2] == (clock.wall_ms(), 'Ana')
    assert p.set_scba_correction(6, None, 1) is None; w.stop()

def test_banners_ack_only_while_active_once_and_the_ack_ends_with_the_condition(tmp_path):
    c, w, clock, ing, p = port(tmp_path)
    for k in ('host_gap', 'logging_fault'):
        with pytest.raises(Exception) as ex: p.ack_banner(k, 1)
        assert (ex.value.status, ex.value.env.error_code) == (409, 'STATE_CONFLICT')
    p.set_host_gap(12.5, 'db_restored'); b = p.ack_banner('host_gap', 1); assert b.kind == 'host_gap' and p.banner_state('host_gap') == (True, b.acknowledged_ts)
    with pytest.raises(Exception) as ex: p.ack_banner('host_gap', 1)
    assert ex.value.env.error_code == 'STATE_CONFLICT'
    p.set_host_gap(3.0); assert p.banner_state('host_gap') == (True, None)                          # a new gap is a new banner
    w.logging_fault = True; assert p.ack_banner('logging_fault', 1).kind == 'logging_fault'
    w.logging_fault = False; assert p.banner_state('logging_fault') == (False, None); w.logging_fault = True; assert p.banner_state('logging_fault') == (True, None); w.stop()

# end_session (close_session('ENDED') and the backup) is P25-3 and is tested in test_sessions.py
