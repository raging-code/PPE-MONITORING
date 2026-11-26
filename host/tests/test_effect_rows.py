"""P24-3a: effect-to-row mapping (design 1 commit paragraph, 2.3 alerts, episodes and audit_events, 14.1). Real DBWriter and database, FakeClock, bytes from frames.json style packers.
The frame row, the alert rows it raises and any episode change commit in one unit; ticks and operator actions go through the same mapping."""
import sqlite3
from ppe_host.core.rule_engine import (AckAlertEvent, AckEpisodeEvent, ChangeAlertLevel, ClearAlert, EpisodeLabelChanged, EpisodeOpened, RaiseAlert, ResolveEpisodeEvent)
from ppe_host.io.db_writer import Ref
from ppe_host.io.ingest import effect_stmts
from test_ingest import fr, rig, rows, send
from test_gv_bytes import WRONG_KEY, pack

def op(c, oid=1): c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (?, ?, 'h', 1, 1)", (oid, 'op%d' % oid))
def alerts(c, where='1'): return rows(c, 'SELECT * FROM alerts WHERE %s ORDER BY event_seq' % where)
def by_type(c, t): return alerts(c, "type = '%s'" % t)
def wait(w, unit): assert w.wait(unit, 2000) is True

def test_a_raised_alert_commits_with_its_frame_and_is_linked_to_it(tmp_path):                       # GV-01 (F-01: node 1, 52.0 ppm)
    c, w, clock, ing = rig(tmp_path); r = send(ing, clock, pack(seq=100, co_x10=520, flags=1)); wait(w, r.unit)
    fx = [e for e in r.effects if isinstance(e, RaiseAlert)]; a = by_type(c, 'co_threshold'); f = rows(c)
    assert len(fx) == 1 and len(a) == 1 and len(f) == 1
    assert (a[0]['event_seq'], a[0]['session_id'], a[0]['node_id'], a[0]['level'], a[0]['authenticated'], a[0]['episode_id'], a[0]['cleared_ts'], a[0]['acknowledged_ts']) == (fx[0].event_seq, 1, 1, 'WARNING', 1, None, None, None)
    assert a[0]['frame_id'] == f[0]['frame_id'] and a[0]['raised_ts'] == f[0]['rx_ts'] and a[0]['event_seq'] > f[0]['event_seq'] and a[0]['reasons'] == fx[0].reasons
    assert r.unit._ids['frame'] == f[0]['frame_id'] and r.unit._ids['alert:%d' % fx[0].event_seq] == a[0]['alert_id']      # the ids a broadcaster needs
    w.stop()

def test_escalation_in_place_clears_the_acknowledgement_and_lowering_keeps_it_and_the_clear_closes_the_row(tmp_path):   # GV-09, 14.1 co_threshold
    c, w, clock, ing = rig(tmp_path); op(c)
    send(ing, clock, pack(seq=1, co_x10=520, flags=1)); fx, u = ing.operator(AckAlertEvent(1, 'co_threshold', 1)); wait(w, u)
    assert alerts(c)[0]['acknowledged_by'] == 1 and alerts(c)[0]['acknowledged_ts'] is not None
    r = send(ing, clock, pack(seq=2, co_x10=2500, flags=2)); wait(w, r.unit)
    a = alerts(c); assert len(a) == 1 and a[0]['level'] == 'DANGER' and a[0]['acknowledged_ts'] is None and a[0]['acknowledged_by'] is None
    assert any(isinstance(e, ChangeAlertLevel) for e in r.effects)
    fx, u = ing.operator(AckAlertEvent(1, 'co_threshold', 1)); wait(w, u)
    for s in range(3, 16): r = send(ing, clock, pack(seq=s, co_x10=1500, flags=1)); wait(w, r.unit)        # 150 ppm for 10 s: DANGER lowers to WARNING in place, acknowledgement kept
    a = alerts(c); assert len(a) == 1 and a[0]['level'] == 'WARNING' and a[0]['acknowledged_ts'] is not None and a[0]['cleared_ts'] is None
    for s in range(16, 30): r = send(ing, clock, pack(seq=s, co_x10=0)); wait(w, r.unit)
    a = alerts(c); assert a[0]['cleared_ts'] is not None and a[0]['cleared_event_seq'] > a[0]['event_seq']
    log = [x['record_type'] for x in rows(c, "SELECT record_type FROM v_full_log WHERE record_type LIKE 'alert%' ORDER BY event_seq")]; assert log == ['alert_raised', 'alert_cleared']
    w.stop()

def test_man_down_opens_an_episode_and_links_the_alert_and_mayday_escalates_it_with_an_audit_row(tmp_path):   # GV-02, GV-03
    c, w, clock, ing = rig(tmp_path); op(c)
    r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit)
    e = rows(c, 'SELECT * FROM episodes'); md = by_type(c, 'man_down')
    assert len(e) == 1 and (e[0]['kind'], e[0]['state'], e[0]['node_id'], e[0]['session_id']) == ('MAN_DOWN', 'OPEN', 1, 1) and md[0]['episode_id'] == e[0]['episode_id']
    assert isinstance(r.effects[0], EpisodeOpened) and r.unit._ids['episode:%d' % r.effects[0].event_seq] == e[0]['episode_id']      # the episode comes before its alert
    r = send(ing, clock, pack(seq=2, flags=6, status4=16)); wait(w, r.unit)
    e = rows(c, 'SELECT * FROM episodes'); my = by_type(c, 'mayday'); au = rows(c, "SELECT * FROM audit_events WHERE action = 'EPISODE_ESCALATED'")
    assert len(e) == 1 and e[0]['kind'] == 'MAYDAY' and my[0]['episode_id'] == e[0]['episode_id']
    assert len(au) == 1 and (au[0]['session_id'], au[0]['operator_id'], au[0]['node_id'], au[0]['episode_id'], au[0]['reason']) == (1, None, 1, e[0]['episode_id'], 'MAN_DOWN to MAYDAY')
    fx, u = ing.operator(AckEpisodeEvent(1, 1)); wait(w, u)
    e = rows(c, 'SELECT * FROM episodes')[0]; assert (e['state'], e['acknowledged_by']) == ('ACKNOWLEDGED', 1) and {a['acknowledged_by'] for a in by_type(c, 'man_down') + by_type(c, 'mayday')} == {1}
    assert fx[0].__class__.__name__ == 'EpisodeAcknowledged' and not any(isinstance(x, ClearAlert) for x in fx)      # Acknowledge never closes a safety alert
    fx, u = ing.operator(ResolveEpisodeEvent(1, 'rescued', 1)); wait(w, u)
    e = rows(c, 'SELECT * FROM episodes')[0]; assert (e['state'], e['resolve_reason'], e['resolved_by']) == ('RESOLVED', 'rescued', 1) and e['resolved_ts'] is not None
    assert all(a['cleared_ts'] is not None for a in by_type(c, 'man_down') + by_type(c, 'mayday'))
    assert ing.operator(ResolveEpisodeEvent(1, 'rescued', 1)) == ((), None)                             # a repeat adds nothing
    w.stop()

def test_a_bad_resolve_reason_raises_and_changes_nothing(tmp_path):
    c, w, clock, ing = rig(tmp_path); op(c); r = send(ing, clock, pack(seq=1, flags=6)); wait(w, r.unit); before = ing.st
    try: ing.operator(ResolveEpisodeEvent(1, 'because', 1)); raise AssertionError('no error')
    except ValueError: pass
    assert ing.st == before and rows(c, 'SELECT state FROM episodes')[0]['state'] == 'OPEN'; w.stop()

def test_a_bad_mac_frame_that_claims_an_alert_stores_an_unauthenticated_row_linked_to_its_frame(tmp_path):   # GV-04 (F-16)
    c, w, clock, ing = rig(tmp_path); r = send(ing, clock, pack(seq=200, flags=6, node=2, key=WRONG_KEY), base='BAD_MAC'); wait(w, r.unit)
    a = by_type(c, 'unauth_alert'); f = rows(c)
    assert len(a) == 1 and (a[0]['node_id'], a[0]['authenticated'], a[0]['frame_id']) == (2, 0, f[0]['frame_id']) and f[0]['verify'] == 'BAD_MAC'
    assert rows(c, 'SELECT * FROM episodes') == []; w.stop()

def test_the_tick_raises_signal_lost_after_the_silence_and_a_fresh_frame_clears_it(tmp_path):      # GV-08
    c, w, clock, ing = rig(tmp_path); r = send(ing, clock, pack(seq=1)); wait(w, r.unit)
    clock.advance(16_000); fx, u = ing.tick(); wait(w, u)
    a = by_type(c, 'signal_lost'); assert len(a) == 1 and a[0]['node_id'] == 1 and a[0]['frame_id'] is None and a[0]['cleared_ts'] is None and any(isinstance(x, RaiseAlert) for x in fx)
    assert ing.tick() == ((), None)                                                                        # nothing changes on the next tick: no unit, no row
    r = send(ing, clock, pack(seq=2)); wait(w, r.unit); assert by_type(c, 'signal_lost')[0]['cleared_ts'] is not None; w.stop()

def test_a_one_shot_notice_is_stored_already_closed(tmp_path):                                      # GV-12 (reboot), 14.1b
    c, w, clock, ing = rig(tmp_path); send(ing, clock, pack(seq=5, boot_ctr=7)); r = send(ing, clock, pack(seq=0, boot_ctr=8, status2=8)); wait(w, r.unit)
    n = by_type(c, 'node_reboot'); assert len(n) == 1 and n[0]['level'] == 'NONE' and n[0]['cleared_ts'] == n[0]['raised_ts'] and n[0]['cleared_event_seq'] is None; w.stop()

def test_effect_stmts_is_pure_and_a_label_change_has_no_row():
    assert effect_stmts((EpisodeLabelChanged(9, 1, 'movement_detected', 5),), 1) == []
    s = effect_stmts((RaiseAlert(7, 1, 'man_down', 'DANGER', 'x', 5), RaiseAlert(8, 1, 'heat', 'WARNING', '', 5)), 3)
    assert [x.tag for x in s] == ['alert:7', 'alert:8'] and 'episodes' in s[0].sql and 'episodes' not in s[1].sql and s[1].params[3:] == (1, 'heat', 'WARNING', 1, None, 5, None)
    assert s[0].params == (7, 3, Ref('frame'), 1, 1, 'man_down', 'DANGER', 1, 'x', 5, None)

def test_a_failed_row_is_skipped_and_the_frame_row_still_commits(tmp_path):                         # Rev 3.36: deterministic failure, one by one
    c, w, clock, ing = rig(tmp_path); c.execute('DELETE FROM alert_types WHERE type = ?', ('co_threshold',))
    r = send(ing, clock, pack(seq=1, co_x10=520, flags=1)); wait(w, r.unit)
    assert len(rows(c)) == 1 and alerts(c) == [] and w.counters['write_rejected'] == 1 and r.unit.rejected == 1; w.stop()
