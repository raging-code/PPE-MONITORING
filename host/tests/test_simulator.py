"""S7-1 (ADR 0057): services/simulator.py (frame encoder, the five scenarios, the schedule and the SimulatorThread), the optional simulator of Runtime (SIMULATOR mode only) and the --scenario and --seed options of main.
The simulator side of the mode isolation test of design 8 (the LIVE_FRAME_IN_TEST_MODE half is S7-2). Requirements: REQ-ING-001."""
import json, sqlite3, threading, time
from pathlib import Path
import pytest
from ppe_host import abi, main as M, runtime as R
from ppe_host.clock import FakeClock
from ppe_host.core import crypto_abi as ca
from ppe_host.core.rule_engine import ChangeAlertLevel, ClearAlert, EngineState, FrameEvent, RaiseAlert, TickEvent, step
from ppe_host.core.seq_classifier import SeqState, classify
from ppe_host.io.serial_reader import Heartbeat, parse_line
from ppe_host.services import simulator as S
from fakeport import frame_line
from test_gv_bytes import pack
from test_startup import NOW, home, run

ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
KEY, SYS = bytes.fromhex(VEC['key_hex']), VEC['sys_id']
T0 = 1_700_000_000_000

def poll_all(sched, seconds, step_ms=100):
    out = []
    for t in range(0, int(seconds * 1000) + 1, step_ms): out += [(t, k, p) for k, p in sched.poll(t)]
    return out

def frames_of(items, node=None): return [p for _, k, p in items if k == 'frame' and (node is None or ca.node_id_of(p.raw) == node)]
def seq_of(f): return ca.decode_frame(f.raw)['seq']

def engine_events(scenario, seconds, seed=1):
    """(second, 'raise'|'level'|'clear', node, type, level) of the real rule engine fed by the simulator's frames and a 1 Hz tick, the order the host uses."""
    s, clk, st, cs, out = S.Schedule(scenario, seed, KEY, SYS), FakeClock(T0, 10_000), EngineState(), SeqState(), []
    def note(t, fx):
        for e in fx:
            if isinstance(e, RaiseAlert): out.append((round(t / 1000), 'raise', e.node_id, e.type, e.level))
            elif isinstance(e, ChangeAlertLevel): out.append((round(t / 1000), 'level', e.node_id, e.type, e.level))
            elif isinstance(e, ClearAlert): out.append((round(t / 1000), 'clear', e.node_id, e.type, None))
    for t in range(0, int(seconds * 1000) + 1, 100):
        if t: clk.advance(100)
        for kind, f in s.poll(t):
            if kind != 'frame': continue
            r = ca.classify_frame(f.raw, KEY, SYS); now = clk.now(); cs, res = classify(cs, r.node_id, f.raw, r.decoded, now.mono_ms)
            st, fx = step(st, FrameEvent(r.node_id, r.result, res.seq_class, r.decoded), now); note(t, fx)
        if t % 1000 == 0: st, fx = step(st, TickEvent(), clk.now()); note(t, fx)
    return out

def first(ev, kind, node, typ, level=None): return next((e[0] for e in ev if e[1] == kind and e[2] == node and e[3] == typ and (level is None or e[4] == level)), None)

# ---- encode_frame ----
def test_encode_frame_rebuilds_every_ok_vector_of_frames_json_byte_for_byte():
    n = 0
    for f in VEC['frames']:
        e = f['expect']
        if e['result'] != 'OK': continue
        d = e['decoded']; kw = {k: d[k] for k in ('co_x10', 'temp_x100', 'hum', 'hr', 'motion_x100', 'bat', 'status2', 'flags', 'uptime_s', 'status3', 'status4', 'boot_ctr')}
        raw = S.encode_frame(KEY, SYS, e['node_id'], d['seq'], scba=d['scba_on'], link_ok=d['link_ok'], evt_unsent=d['evt_unsent'], posture=(d['id_mode'] >> 4) & 3, **kw)
        assert raw.hex() == f['hex'], f['id']; n += 1
    assert n >= 15

def test_encode_frame_equals_the_test_packer_for_many_field_combinations():
    for i in range(200):
        kw = dict(seq=(i * 977) & 0xFFFF, co_x10=(i * 31) % 6000, temp_x100=(i * 53) % 6000 - 1000, hum=i % 100, hr=(i * 3) % 200, motion_x100=i % 256, bat=i % 101, status2=i & 0xFF, flags=(i * 7) & 0xFF,\
                  node=1 + i % 3, scba=i % 2, posture=i % 4, link_ok=(i // 2) % 2, evt_unsent=(i // 3) % 2, uptime_s=(i * 1234) & 0xFFFF, status3=(i * 5) & 0xFF, status4=(i * 11) & 0xFF, boot_ctr=i % 256)
        node, seq = kw.pop('node'), kw.pop('seq')
        assert S.encode_frame(KEY, SYS, node, seq, **kw) == pack(seq=seq, node=node, **kw)

def test_encode_frame_refuses_a_value_that_does_not_fit_and_a_node_outside_1_to_7():
    for bad in (dict(node=0), dict(node=8), dict(seq=70000), dict(seq=-1), dict(co_x10=70000), dict(hum=256), dict(temp_x100=40000), dict(bat=-1)):
        kw = dict(node=1, seq=1); kw.update(bad); node, seq = kw.pop('node'), kw.pop('seq')
        with pytest.raises(ValueError): S.encode_frame(KEY, SYS, node, seq, **kw)

def test_a_wrong_key_or_sys_id_gives_a_frame_the_host_rejects():
    good = S.encode_frame(KEY, SYS, 1, 5); assert ca.verify_frame(good, KEY, SYS) == 'OK'
    assert ca.verify_frame(S.encode_frame(bytes(16), SYS, 1, 5), KEY, SYS) == 'BAD_MAC' and ca.verify_frame(S.encode_frame(KEY, SYS + 1, 1, 5), KEY, SYS) == 'BAD_MAC'

# ---- the schedule ----
def test_every_scenario_makes_only_valid_frames_for_the_roster_over_ten_minutes_and_twenty_seeds():
    for scenario in S.SCENARIOS:
        for seed in range(1, 21):
            for f in frames_of(poll_all(S.Schedule(scenario, seed, KEY, SYS), 600, 500)):
                r = ca.classify_frame(f.raw, KEY, SYS); assert r.result == 'OK' and r.node_id in S.NODES and f.base_verify == 'OK' and len(f.raw) == abi.FRAME_BYTES

def test_a_simulated_frame_is_what_the_serial_reader_makes_of_the_line_the_base_would_send():
    s = S.Schedule('rehearsal', 3, KEY, SYS, base_id=2)
    for _, kind, f in poll_all(s, 30):
        if kind != 'frame': continue
        k, parsed = parse_line(frame_line(f.raw.hex(), rssi=f.rssi, snr=f.snr, uptime_ms=f.base_uptime_ms, base_id=2)); assert k == 'frame' and parsed == f

def test_the_same_scenario_and_seed_give_the_same_bytes_and_another_seed_gives_other_bytes():
    a, b, c = (poll_all(S.Schedule('rehearsal', sd, KEY, SYS), 120) for sd in (1, 1, 2))
    assert a == b and a != c

def test_the_bytes_of_a_slot_do_not_depend_on_how_often_the_schedule_is_polled():
    s1, s2 = S.Schedule('rehearsal', 1, KEY, SYS), S.Schedule('rehearsal', 1, KEY, SYS)
    fast = {(ca.node_id_of(f.raw), seq_of(f)): f.raw for f in frames_of(poll_all(s1, 200, 50))}
    slow = {(ca.node_id_of(f.raw), seq_of(f)): f.raw for f in frames_of(poll_all(s2, 200, 1000))}
    assert slow and all(fast[k] == v for k, v in slow.items())
    assert S.Schedule('rehearsal', 1, KEY, SYS).frame_bytes(2, 40) == S.Schedule('rehearsal', 1, KEY, SYS).frame_bytes(2, 40)

def test_scenario_and_seed_are_checked():
    for bad in ('', 'Quiet', 'nope', None): 
        with pytest.raises(ValueError): S.Schedule(bad, 1, KEY, SYS)
    for bad in (1.5, '1', None, True):
        with pytest.raises(ValueError): S.Schedule('quiet', bad, KEY, SYS)
    assert set(S.SCENARIOS) == {'quiet', 'co_ramp', 'man_down', 'link_loss', 'rehearsal'} and S.DEFAULT_SCENARIO in S.SCENARIOS

def test_each_node_sends_every_two_seconds_with_seq_plus_one_and_all_three_nodes_are_heard():
    items = poll_all(S.Schedule('quiet', 1, KEY, SYS), 60, 100)
    for n in S.NODES:
        fs = [(t, seq_of(f)) for t, k, f in items if k == 'frame' and ca.node_id_of(f.raw) == n]
        assert 29 <= len(fs) <= 31
        for (t0, s0), (t1, s1) in zip(fs, fs[1:]): assert s1 == (s0 + 1) & 0xFFFF and 1900 <= t1 - t0 <= 2100
    assert {ca.node_id_of(f.raw) for f in frames_of(items)} == set(S.NODES)

def test_the_base_sends_one_heartbeat_a_second_and_its_counters_agree_with_the_frames():
    items = poll_all(S.Schedule('quiet', 1, KEY, SYS), 60, 100); hbs = [(t, p) for t, k, p in items if k == 'hb']
    assert [t for t, _ in hbs] == list(range(0, 60001, 1000)) and all(isinstance(p, Heartbeat) for _, p in hbs)
    assert all(b.uptime_ms - a.uptime_ms == 1000 for (_, a), (_, b) in zip(hbs, hbs[1:])) and all(0 <= p.bat_pct <= 100 for _, p in hbs)
    seen = 0
    for t, k, p in items:
        if k == 'frame': seen += 1
        if k == 'hb': assert p.rx_ok == seen, t
    assert hbs[-1][1].rx_bad_len == hbs[-1][1].rx_bad_crc == hbs[-1][1].rx_bad_mac == 0 and hbs[-1][1].fw is None and hbs[-1][1].abi is None

def test_a_long_pause_sends_the_newest_frame_of_each_node_and_one_heartbeat_not_a_burst_and_leaves_a_seq_gap():
    s = S.Schedule('quiet', 1, KEY, SYS); first_ = s.poll(0) + s.poll(2500); before = {ca.node_id_of(f.raw): seq_of(f) for k, f in first_ if k == 'frame'}
    after = s.poll(2500 + 600_000)
    assert sum(1 for k, _ in after if k == 'frame') == 3 and sum(1 for k, _ in after if k == 'hb') == 1
    for k, f in after:
        if k == 'frame': n = ca.node_id_of(f.raw); assert (seq_of(f) - before[n]) & 0xFFFF > 250      # about 300 slots in 600 s, none of them sent late
    nxt = s.poll(2500 + 600_000 + 2100); assert sum(1 for k, _ in nxt if k == 'frame') >= 2           # and then it is back to one frame per period

def test_a_clock_that_goes_back_never_repeats_a_frame_or_a_heartbeat():
    s = S.Schedule('quiet', 1, KEY, SYS); a = s.poll(5000); b = s.poll(1000); c = s.poll(5000)
    assert a and b == [] and c == []

def test_link_loss_silences_node_3_from_20_to_95_seconds_and_seq_jumps_when_it_returns():
    items = poll_all(S.Schedule('link_loss', 1, KEY, SYS), 140, 100); n3 = [(t, seq_of(f)) for t, k, f in items if k == 'frame' and ca.node_id_of(f.raw) == 3]
    # a frame is made at its slot time and handed out at the next poll, up to 100 ms later: the silent window is checked from 20.1 s
    assert not [t for t, _ in n3 if 20_100 <= t < 95_000] and [t for t, _ in n3 if t < 20_000] and [t for t, _ in n3 if t >= 95_000]
    last_before = max((t, s) for t, s in n3 if t < 20_000); first_after = min((t, s) for t, s in n3 if t >= 95_000)
    assert 34 <= first_after[1] - last_before[1] <= 40 and first_after[0] - last_before[0] > 70_000                  # about 37 missed slots
    for n in (1, 2): assert len([1 for t, k, f in items if k == 'frame' and ca.node_id_of(f.raw) == n and 20_000 <= t < 95_000]) >= 36   # the other nodes are not silenced

def test_the_frame_content_of_each_scenario_is_what_the_firmware_would_send():
    items = poll_all(S.Schedule('rehearsal', 1, KEY, SYS), 240, 500); dec = lambda n: [(t, ca.decode_frame(f.raw)) for t, k, f in items if k == 'frame' and ca.node_id_of(f.raw) == n]
    co = max(d['co_x10'] for _, d in dec(1)); assert 2200 <= co <= 2500 and max(d['flags'] & 3 for _, d in dec(1)) == 2
    assert any(d['flags'] & 4 and d['flags'] & 3 == 2 and (d['id_mode'] >> 4) & 3 == 2 for _, d in dec(2))                          # mandown latched, DANGER, horizontal
    assert not any(d['flags'] & 4 for _, d in dec(1) + dec(3)) and all(d['co_x10'] < 100 for _, d in dec(2) + dec(3))             # no other node latches man-down or sees CO
    assert all(d['link_ok'] == 1 and d['boot_ctr'] == dec(1)[0][1]['boot_ctr'] for _, d in dec(1))

# ---- what the rule engine does with the scenarios ----
def test_quiet_raises_nothing_in_ten_minutes():
    assert engine_events('quiet', 600) == []

def test_co_ramp_raises_a_warning_then_danger_then_falls_back_and_clears():
    ev = engine_events('co_ramp', 160); assert {e[2] for e in ev} == {1}
    assert 26 <= first(ev, 'raise', 1, 'co_threshold', 'WARNING') <= 32 and 64 <= first(ev, 'level', 1, 'co_threshold', 'DANGER') <= 70
    assert first(ev, 'level', 1, 'co_threshold', 'WARNING') > 100 and first(ev, 'clear', 1, 'co_threshold') > 120

def test_man_down_raises_man_down_on_node_2_only_and_nothing_else():
    ev = engine_events('man_down', 200); assert [e[1:] for e in ev] == [('raise', 2, 'man_down', 'DANGER')] and 50 <= ev[0][0] <= 58

def test_link_loss_raises_signal_lost_after_15_s_and_link_lost_after_60_s_and_clears_when_the_node_returns():
    ev = engine_events('link_loss', 140); assert {e[2] for e in ev} == {3}
    assert 33 <= first(ev, 'raise', 3, 'signal_lost') <= 39 and 78 <= first(ev, 'raise', 3, 'link_lost') <= 84 and 95 <= first(ev, 'clear', 3, 'link_lost') <= 100

@pytest.mark.parametrize('seed', [1, 2, 3, 4, 5])
def test_rehearsal_runs_the_three_events_on_three_nodes_in_order_whatever_the_seed(seed):
    ev = engine_events('rehearsal', 240, seed)
    co, md, sl, ll = first(ev, 'raise', 1, 'co_threshold', 'WARNING'), first(ev, 'raise', 2, 'man_down'), first(ev, 'raise', 3, 'signal_lost'), first(ev, 'raise', 3, 'link_lost')
    assert None not in (co, md, sl, ll) and co < md < sl < ll and 26 <= co <= 32 and 110 <= md <= 118 and 153 <= sl <= 159 and 198 <= ll <= 204
    assert first(ev, 'level', 1, 'co_threshold', 'DANGER') < md and first(ev, 'clear', 3, 'link_lost') >= 215

# ---- the thread ----
def wait_polls(sim, n=2, timeout=5.0):
    target, end = sim.polls + n, time.monotonic() + timeout
    while sim.polls < target and time.monotonic() < end: time.sleep(0.001)
    assert sim.polls >= target, 'the simulator thread did not poll'

def make_thread(got, clock=None, **kw):
    clock = clock or FakeClock(T0, 0); kw.setdefault('poll_s', 0.002)
    return clock, S.SimulatorThread(clock, lambda k, p: got.append((k, p)), KEY, SYS, **kw)

def test_the_thread_polls_the_injected_clock_and_gives_the_items_to_the_callback():
    got = []; clock, th = make_thread(got, scenario='quiet', seed=1); th.start()
    try:
        wait_polls(th); assert [k for k, _ in got] == ['hb']                      # time 0: the first heartbeat, no node is due yet
        for _ in range(20): clock.advance(500); wait_polls(th)
    finally: th.stop()
    ref = S.Schedule('quiet', 1, KEY, SYS); want = []
    for t in range(0, 10_001, 500): want += ref.poll(t)
    assert got == want and th.counters == {'sim_frames': sum(k == 'frame' for k, _ in want), 'sim_heartbeats': 11, 'sim_handler_errors': 0}
    assert not th.alive() and th.scenario == 'quiet' and th.seed == 1

def test_a_long_clock_jump_gives_the_callback_one_frame_per_node_not_a_burst():
    got = []; clock, th = make_thread(got, scenario='quiet', seed=1); th.start()
    try:
        wait_polls(th); clock.advance(3000); wait_polls(th); n0 = len(got); clock.advance(3_600_000); wait_polls(th)
    finally: th.stop()
    assert 1 <= len(got) - n0 <= 4 and sum(k == 'frame' for k, _ in got[n0:]) == 3

def test_a_failing_callback_is_counted_and_never_stops_the_thread():
    calls = []
    def cb(kind, payload):
        calls.append(kind)
        if len(calls) == 1: raise RuntimeError('boom')
    clock = FakeClock(T0, 0); th = S.SimulatorThread(clock, cb, KEY, SYS, 'quiet', 1, poll_s=0.002).start()
    try:
        wait_polls(th); clock.advance(1000); wait_polls(th)
    finally: th.stop()
    assert th.counters['sim_handler_errors'] == 1 and 'boom' in th.last_error and th.counters['sim_frames'] + th.counters['sim_heartbeats'] == len(calls) - 1 and th.counters['sim_heartbeats'] >= 1

def test_the_thread_calls_on_alive_and_stop_returns_at_once_even_with_a_slow_poll():
    alive = []; th = S.SimulatorThread(FakeClock(T0, 0), lambda k, p: None, KEY, SYS, 'quiet', 1, poll_s=30, on_alive=lambda: alive.append(1)).start()
    try:
        end = time.monotonic() + 5
        while th.polls < 1 and time.monotonic() < end: time.sleep(0.001)
        assert th.polls == 1 and alive                                            # one pass, then it waits 30 s
    finally: t = time.monotonic(); th.stop()
    assert time.monotonic() - t < 1 and not th.alive()

# ---- the runtime ----
def sim_runtime(tmp_path, mode='SIMULATOR', scenario='quiet', seed=1):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st); clock = FakeClock(NOW, 0)
    rt = R.Runtime(st, clock, open_port=lambda: pytest.fail('no serial port may be opened'), simulator=(scenario, seed)); rt.sim.poll_s = 0.002
    return st, rt, clock

def rows(db, sql):
    c = sqlite3.connect(db); out = c.execute(sql).fetchall(); c.close(); return out

def test_runtime_in_simulator_mode_queues_simulated_frames_until_release_then_stores_them_in_the_test_database(tmp_path):
    st, rt, clock = sim_runtime(tmp_path); rt.start()
    try:
        assert rt.serial is False and rt.sim.alive() and not rt.reader.alive()
        wait_polls(rt.sim)
        for _ in range(20): clock.advance(500); wait_polls(rt.sim)
        assert rt.gate.depth() > 0                                                  # frames wait for RECOVERING_EXIT like live ones
        assert rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0] == 0
        fed = rt.release(); assert fed == rt.sim.counters['sim_frames'] and rt.gate.depth() == 0
    finally: rt.stop(); st.close()
    ref = S.Schedule('quiet', 1, st.settings.cmac_key(), st.settings['sys_id'], st.settings['base_id']); items = []
    for t in range(0, 10_001, 500): items += ref.poll(t)
    assert rows(st.db_path, 'SELECT node_id, verify, COUNT(*) FROM frames GROUP BY 1, 2 ORDER BY 1') == [(n, 'OK', sum(1 for k, f in items if k == 'frame' and ca.node_id_of(f.raw) == n)) for n in S.NODES]
    assert rows(st.db_path, 'SELECT COUNT(*) FROM base_health')[0][0] == 11 and rows(st.db_path, "SELECT mode FROM sessions") == [('SIMULATOR',)]
    assert not (st.settings.home / 'data' / 'ppe.db').exists()                       # mode isolation: db_path is never opened (Rev 3.40)

def test_a_simulated_frame_after_release_goes_straight_to_ingest_and_a_man_down_scenario_raises_its_alert(tmp_path):
    st, rt, clock = sim_runtime(tmp_path, scenario='man_down'); rt.start()
    try:
        wait_polls(rt.sim); rt.release()
        for _ in range(130): clock.advance(500); wait_polls(rt.sim)
    finally: rt.stop(); st.close()
    got = rows(st.db_path, "SELECT node_id, type, level FROM alerts ORDER BY alert_id"); assert got == [(2, 'man_down', 'DANGER')]

def test_runtime_stops_the_simulator_before_the_writer_and_leaves_no_thread_behind(tmp_path):
    st, rt, clock = sim_runtime(tmp_path); rt.start(); wait_polls(rt.sim); sim = rt.sim; rt.stop(); st.close()
    assert not sim.alive() and not [t for t in threading.enumerate() if t.name == 'SimulatorThread']

def test_runtime_stamps_the_serial_liveness_from_the_simulator_thread(tmp_path):
    st, rt, clock = sim_runtime(tmp_path); rt.start()
    try: wait_polls(rt.sim); assert 'serial' in rt.liveness.ages()
    finally: rt.stop(); st.close()

@pytest.mark.parametrize('mode', ['LIVE', 'REPLAY'])
def test_a_simulator_is_refused_outside_simulator_mode_before_anything_is_built(tmp_path, mode):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st)
    try:
        with pytest.raises(ValueError, match='SIMULATOR'): R.Runtime(st, FakeClock(NOW, 0), simulator=('quiet', 1))
        assert not [t for t in threading.enumerate() if t.name == 'SimulatorThread']
    finally: st.close()

def test_runtime_without_a_simulator_is_as_before_no_thread_and_no_frames(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st); rt = R.Runtime(st, FakeClock(NOW, 0)); assert rt.sim is None; rt.start(); rt.stop(); st.close()
    assert rows(st.db_path, 'SELECT COUNT(*) FROM frames')[0][0] == 0 and rows(st.db_path, 'SELECT COUNT(*) FROM base_health')[0][0] == 0

def test_an_unknown_scenario_stops_the_runtime_before_it_starts(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); M.begin_session(st)
    try:
        with pytest.raises(ValueError, match='scenario'): R.Runtime(st, FakeClock(NOW, 0), simulator=('nope', 1))
    finally: st.close()

# ---- main ----
def run_main(tmp_path, argv, capsys):
    box = {}
    async def serve(rt, host, port):
        box['rt'] = rt; box['alive'] = rt.sim is not None and rt.sim.alive()
    h = home(tmp_path); code = M.main(['--home', str(h)] + argv, serve=serve); out = capsys.readouterr(); return code, out.out, out.err, box, h

def test_main_in_simulator_mode_without_options_runs_the_rehearsal_scenario_with_seed_1(tmp_path, capsys):
    code, out, err, box, h = run_main(tmp_path, ['--mode', 'SIMULATOR'], capsys)
    assert code == 0 and 'SIMULATOR' in out and 'scenario rehearsal seed 1' in out and box['alive'] and box['rt'].sim.scenario == 'rehearsal' and box['rt'].sim.seed == 1
    assert not box['rt'].sim.alive() and (h / 'data' / 'ppe_test.db').exists() and not (h / 'data' / 'ppe.db').exists()

def test_main_passes_scenario_and_seed_to_the_runtime_and_prints_them(tmp_path, capsys):
    code, out, err, box, h = run_main(tmp_path, ['--mode', 'SIMULATOR', '--scenario', 'co_ramp', '--seed', '7'], capsys)
    assert code == 0 and 'scenario co_ramp seed 7' in out and (box['rt'].sim.scenario, box['rt'].sim.seed) == ('co_ramp', 7)

@pytest.mark.parametrize('argv', [['--scenario', 'quiet'], ['--seed', '3'], ['--mode', 'LIVE', '--scenario', 'co_ramp'], ['--mode', 'REPLAY', '--seed', '1'], ['--mode', 'REPLAY', '--scenario', 'quiet', '--seed', '1']])
def test_main_refuses_scenario_and_seed_outside_simulator_mode_with_exit_2_and_starts_nothing(tmp_path, capsys, argv):
    h = home(tmp_path)
    assert M.main(['--home', str(h)] + argv, serve=lambda *a: pytest.fail('the server must not start')) == 2
    assert 'need --mode SIMULATOR' in capsys.readouterr().err and not (h / 'data').exists() and not (h / M.LOCK_NAME).exists()

def test_main_refuses_an_unknown_scenario_and_a_seed_that_is_not_a_number(tmp_path, capsys):
    h = home(tmp_path)
    for argv in (['--mode', 'SIMULATOR', '--scenario', 'nope'], ['--mode', 'SIMULATOR', '--seed', 'x']):
        with pytest.raises(SystemExit) as e: M.main(['--home', str(h)] + argv, serve=lambda *a: pytest.fail('the server must not start'))
        assert e.value.code == 2
    assert not (h / 'data').exists()

def test_main_in_live_mode_prints_no_scenario_and_starts_no_simulator(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(R, 'open_serial', lambda *a, **k: (_ for _ in ()).throw(OSError('no port in the test')))
    code, out, err, box, h = run_main(tmp_path, [], capsys)
    assert code == 0 and 'scenario' not in out and box['rt'].sim is None and box['alive'] is False

# ---- docs ----
def test_adr_0057_exists_is_proposed_and_progress_points_to_it():
    adr = (ROOT / 'docs' / 'adr' / '0057.md').read_text(encoding='utf8'); assert adr.startswith('# ADR 0057') and ('Status: Proposed' in adr or 'Status: Decided' in adr)
    assert all(name in adr for name in S.SCENARIOS) and '--scenario' in adr and 'create-operator' in adr and 'Ctrl+C' in adr
    assert 'Part S7-1 done (ADR 0057' in (ROOT / 'docs' / 'PROGRESS.md').read_text(encoding='utf8')
