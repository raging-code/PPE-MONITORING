"""P24-3c-2 (Part 2): load_open_state() and Ingest.load_open() (start-up step 9, ADR 0034). Real database, real writer, FakeClock."""
import logging
from ppe_host.clock import FakeClock
from ppe_host.core import rule_engine as eng
from ppe_host.core.rule_engine import AckAlertEvent, AckEpisodeEvent, OpenAlert, ResolveEpisodeEvent
from ppe_host.io.db_writer import DBWriter
from ppe_host.io.ingest import Ingest, OPEN_ALERTS_SQL, OPEN_EPISODES_SQL, load_open_state
from test_db_schema import new_db, session
from test_gv_bytes import KEY, SYS

T = 1_700_000_000_000

def rig(tmp_path):
    c = new_db(tmp_path); session(c); clock = FakeClock(T, 10_000)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (7, 'op', 'x', 1, 1)")
    w = DBWriter(tmp_path / 't.db', clock, retry_sleep_s=0.005).start()
    return c, w, Ingest(KEY, SYS, (1, 2, 3), w, clock, 1, event_seq_start=100)

def add_alert(c, seq, typ, node=1, level='WARNING', raised=T, ep=None, why='r', ack=None):
    c.execute('INSERT INTO alerts(event_seq, session_id, episode_id, node_id, type, level, reasons, raised_ts, acknowledged_ts) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)', (seq, ep, node, typ, level, why, raised, ack))

def add_episode(c, node=1, kind='MAN_DOWN', state='OPEN', opened=T):
    return c.execute("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state) VALUES (1, ?, ?, ?, ?)", (node, kind, opened, state)).lastrowid

def test_open_alerts_and_open_episodes_are_loaded_as_engine_values(tmp_path):
    c, w, ing = rig(tmp_path)
    ep = add_episode(c, 1, 'MAN_DOWN'); add_alert(c, 11, 'man_down', 1, 'DANGER', ep=ep, why='still'); add_alert(c, 12, 'co_threshold', 2, 'WARNING', raised=T + 5, ack=T + 9)
    add_alert(c, 13, 'link_lost', 3, 'NONE'); c.execute("UPDATE alerts SET cleared_ts = 5 WHERE event_seq = 13")      # cleared: never loaded
    rep = ing.load_open(c); w.stop()
    assert (rep.alerts, rep.episodes, rep.skipped) == (2, 1, ())
    assert ing.st.alerts[(1, 'man_down')] == OpenAlert(1, 'man_down', 'DANGER', 11, T, 'still', None)
    assert ing.st.alerts[(2, 'co_threshold')] == OpenAlert(2, 'co_threshold', 'WARNING', 12, T + 5, 'r', T + 9) and (3, 'link_lost') not in ing.st.alerts
    e = ing.st.episodes[1]
    assert (e.kind, e.state, e.opened_ts, e.opened_event_seq, e.motion_state) == ('MAN_DOWN', 'OPEN', T, 10, eng.NO_RESPONSE)

def test_mayday_episode_has_no_motion_label_and_an_acknowledged_episode_keeps_its_fields(tmp_path):
    c, w, ing = rig(tmp_path)
    ep = add_episode(c, 2, 'MAYDAY', 'OPEN'); add_alert(c, 21, 'mayday', 2, 'DANGER', ep=ep)
    c.execute("UPDATE episodes SET state = 'ACKNOWLEDGED', acknowledged_ts = ?, acknowledged_by = 7 WHERE episode_id = ?", (T + 3, ep))
    ing.load_open(c); w.stop(); e = ing.st.episodes[2]
    assert (e.kind, e.state, e.motion_state, e.acknowledged_ts, e.acknowledged_by, e.opened_event_seq) == ('MAYDAY', 'ACKNOWLEDGED', None, T + 3, 7, 20)

def test_opened_event_seq_is_zero_when_the_episode_has_no_open_row(tmp_path):
    c, w, ing = rig(tmp_path); add_episode(c, 1, 'MAN_DOWN')
    ing.load_open(c); w.stop(); assert ing.st.episodes[1].opened_event_seq == 0

def test_opened_event_seq_comes_from_the_oldest_open_episode_row(tmp_path):
    c, w, ing = rig(tmp_path); ep = add_episode(c, 1, 'MAYDAY')
    add_alert(c, 31, 'man_down', 1, 'DANGER', ep=ep); c.execute('UPDATE alerts SET cleared_ts = 9 WHERE event_seq = 31'); add_alert(c, 35, 'mayday', 1, 'DANGER', ep=ep)
    ing.load_open(c); w.stop(); assert ing.st.episodes[1].opened_event_seq == 34       # the cleared man_down row is not open, so the open mayday row is the oldest

def test_open_unauth_alert_comes_back_with_count_one_and_its_raised_ts(tmp_path):
    c, w, ing = rig(tmp_path); add_alert(c, 41, 'unauth_alert', 1, 'NONE', raised=T + 77)
    ing.load_open(c); w.stop(); n = ing.st.nodes[1]
    assert (n.unauth_count, n.unauth_last_seen_ts) == (1, T + 77) and (1, 'unauth_alert') in ing.st.alerts

def test_a_second_call_changes_nothing_and_returns_zeros(tmp_path):
    c, w, ing = rig(tmp_path); ep = add_episode(c, 1); add_alert(c, 11, 'man_down', 1, 'DANGER', ep=ep); add_alert(c, 12, 'unauth_alert', 2, 'NONE')
    first = ing.load_open(c); before = ing.st; second = ing.load_open(c); w.stop()
    assert (first.alerts, first.episodes) == (2, 1) and (second.alerts, second.episodes) == (0, 0) and ing.st == before

def test_load_open_writes_nothing_and_uses_no_event_seq(tmp_path):
    c, w, ing = rig(tmp_path); ep = add_episode(c, 1); add_alert(c, 11, 'man_down', 1, 'DANGER', ep=ep)
    snap = lambda: (c.execute('SELECT * FROM alerts').fetchall(), c.execute('SELECT * FROM episodes').fetchall(), c.execute('SELECT COUNT(*) FROM system_events').fetchone())
    before = snap(); ing.load_open(c); w.stop()
    assert ing.st.event_seq == 100 and snap() == before and w.counters['commits'] == 0

def test_existing_engine_state_wins_over_the_database(tmp_path):
    c, w, ing = rig(tmp_path); ep = add_episode(c, 1, 'MAN_DOWN'); add_alert(c, 11, 'man_down', 1, 'DANGER', ep=ep); add_alert(c, 12, 'unauth_alert', 2, 'NONE', raised=T + 1)
    live = OpenAlert(1, 'man_down', 'DANGER', 99, T + 500, 'live', T + 600); live_ep = eng.Episode(1, 'MAYDAY', 'ACKNOWLEDGED', 98, T + 400, T + 450, 7, motion_state=None)
    live_n = eng.NodeState(unauth_count=5, unauth_last_seen_ts=T + 900)
    ing.st = eng.replace(ing.st, alerts={(1, 'man_down'): live, (2, 'unauth_alert'): OpenAlert(2, 'unauth_alert', 'NONE', 97, T + 800, 'x')}, episodes={1: live_ep}, nodes={2: live_n})
    rep = ing.load_open(c); w.stop()
    assert (rep.alerts, rep.episodes) == (0, 0) and ing.st.alerts[(1, 'man_down')] is live and ing.st.episodes[1] is live_ep and ing.st.nodes[2] == live_n

def test_load_adds_only_what_is_missing(tmp_path):
    c, w, ing = rig(tmp_path); add_alert(c, 11, 'co_threshold', 1); add_alert(c, 12, 'heat', 2)
    live = OpenAlert(1, 'co_threshold', 'DANGER', 99, T, 'live'); ing.st = eng.replace(ing.st, alerts={(1, 'co_threshold'): live})
    rep = ing.load_open(c); w.stop()
    assert rep.alerts == 1 and ing.st.alerts[(1, 'co_threshold')] is live and ing.st.alerts[(2, 'heat')].event_seq == 12

def test_open_rows_of_an_earlier_session_are_loaded_too(tmp_path):
    c, w, ing = rig(tmp_path); session(c, 2, ended=50); c.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (5, 2, 3, 'battery_low', 'WARNING', 1)")
    ing.load_open(c); w.stop(); assert (3, 'battery_low') in ing.st.alerts

def test_skipped_rows_are_listed_logged_and_never_fatal(tmp_path, caplog):
    c, w, ing = rig(tmp_path)
    c.execute('PRAGMA foreign_keys=OFF'); c.execute('PRAGMA ignore_check_constraints=ON')
    c.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (1, 1, NULL, 'co_threshold', 'WARNING', 1)")        # node_id NULL
    c.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (2, 1, 1, 'banana', 'WARNING', 1)")                   # unknown type
    c.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (3, 1, 1, 'heat', 'PURPLE', 1)")                      # unknown level
    c.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (4, 1, 2, 'unauth_alert', 'NONE', 1)")
    c.execute("INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts) VALUES (5, 1, 2, 'unauth_alert', 'NONE', 2)")               # second open row, same node and type
    c.execute("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state) VALUES (1, 3, 'BANANA', 1, 'OPEN')")                                   # unknown kind
    c.execute('PRAGMA ignore_check_constraints=OFF'); c.execute('PRAGMA foreign_keys=ON')
    with caplog.at_level(logging.WARNING, logger='ppe.ingest'): rep = ing.load_open(c)
    w.stop()
    assert (rep.alerts, rep.episodes) == (1, 0) and set(ing.st.alerts) == {(2, 'unauth_alert')} and ing.st.alerts[(2, 'unauth_alert')].event_seq == 4       # the lowest event_seq stays
    assert sorted((what, why.split()[0]) for what, _, why in rep.skipped) == [('alert', 'node_id'), ('alert', 'second'), ('alert', 'unknown'), ('alert', 'unknown'), ('episode', 'unknown')]
    assert sum('not loaded' in r.getMessage() for r in caplog.records) == 5

def test_a_second_active_episode_for_a_node_is_skipped(tmp_path):
    c, w, ing = rig(tmp_path); c.execute('DROP INDEX idx_episodes_one_active')          # the index normally makes this impossible; the loader must still not fail
    add_episode(c, 1, 'MAN_DOWN', 'OPEN'); add_episode(c, 1, 'MAYDAY', 'ACKNOWLEDGED')
    rep = ing.load_open(c); w.stop()
    assert rep.episodes == 1 and ing.st.episodes[1].kind == 'MAN_DOWN' and [s[:1] + (s[2],) for s in rep.skipped] == [('episode', 'second active episode for node 1')]

def test_empty_database_loads_nothing(tmp_path):
    c, w, ing = rig(tmp_path); before = ing.st; rep = ing.load_open(c); w.stop()
    assert (rep.alerts, rep.episodes, rep.skipped) == (0, 0, ()) and ing.st == before
    s = load_open_state(c); assert (s.alerts, s.episodes, s.unauth, s.skipped) == ({}, {}, {}, ())

def test_both_queries_use_their_indexes(tmp_path):
    c, w, ing = rig(tmp_path); w.stop()
    plan = lambda sql: ' '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN ' + sql))
    assert 'USING INDEX idx_alerts_open' in plan(OPEN_ALERTS_SQL)
    # On a database with no statistics the planner prefers a rowid scan for the episodes query (it needs no sort); once ANALYZE has run it uses the partial index. The table holds one row per episode, so either is cheap.
    assert plan(OPEN_EPISODES_SQL).startswith('SCAN episodes')
    c.execute('ANALYZE'); assert 'USING INDEX idx_episodes_one_active' in plan(OPEN_EPISODES_SQL)

def test_acknowledge_and_resolve_work_after_a_restart(tmp_path):
    c, w, ing = rig(tmp_path); ep = add_episode(c, 1, 'MAN_DOWN'); add_alert(c, 11, 'man_down', 1, 'DANGER', ep=ep); add_alert(c, 12, 'co_threshold', 2)
    ing.load_open(c)
    fx, unit = ing.operator(AckAlertEvent(2, 'co_threshold', 7)); assert fx and unit is not None and unit.done.wait(3)
    fx, unit = ing.operator(AckEpisodeEvent(1, 7)); assert fx and unit.done.wait(3)
    assert c.execute('SELECT acknowledged_by FROM alerts WHERE event_seq = 12').fetchone() == (7,)
    assert c.execute('SELECT state, acknowledged_by FROM episodes WHERE episode_id = ?', (ep,)).fetchone() == ('ACKNOWLEDGED', 7)
    assert ing.operator(AckAlertEvent(2, 'co_threshold', 7)) == ((), None)                 # a repeat is a no-op
    fx, unit = ing.operator(ResolveEpisodeEvent(1, 'rescued', 7)); assert fx and unit.done.wait(3); w.stop()
    row = c.execute('SELECT state, resolve_reason, resolved_by FROM episodes WHERE episode_id = ?', (ep,)).fetchone()
    assert row == ('RESOLVED', 'rescued', 7) and 1 not in ing.st.episodes
