"""P24-3c-3 part 3: the AudioThread inside the host: Runtime.audio_items, start and stop, the Wire.on_change feed, the AUDIO FAULT event and banner flag, the zero-socket inputs and main().
The AudioThread itself (priority, repeat times, self-check, fallback pulse) is tested in test_audio_thread.py; here the sound card is a FakeBackend. Requirements: REQ-AUD-003, REQ-AUD-004, REQ-AUD-005."""
import asyncio, dataclasses, sqlite3, time
from collections import deque
from types import SimpleNamespace as NS
from ppe_host import main as M, runtime as R, serve as S, wire as W
from ppe_host.clock import FakeClock
from ppe_host.core.rule_engine import OpenAlert, RaiseAlert
from fakeaudio import FakeBackend
from fakeport import FakePort
from test_startup import home, run, NOW

def mk(tmp_path, backend, mode='SIMULATOR'):
    h = home(tmp_path); st = run(h, mode); M.begin_session(st); st.recovering = False      # P25-2: RECOVERING is a one-beep item while the host recovers; these tests are about the alarms
    return st, R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: FakePort([]), audio_backend=backend)

def alert(t, level, ack=None, nid=1, seq=5): return OpenAlert(nid, t, level, seq, NOW, '', ack)

def put(rt, *alerts): rt.ingest.st = dataclasses.replace(rt.ingest.st, alerts={(a.node_id, a.type): a for a in alerts})

def until(fn, secs=3.0):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if fn(): return True
        time.sleep(0.01)
    return fn()

def events(rt, kind):
    c = sqlite3.connect(str(rt.st.db_path)); n = c.execute('SELECT COUNT(*) FROM system_events WHERE kind = ?', (kind,)).fetchone()[0]; c.close(); return n

# ---- the item list ----
def test_items_are_the_open_alerts_with_their_acknowledged_flag(tmp_path):
    st, rt = mk(tmp_path, FakeBackend())
    put(rt, alert('co_threshold', 'DANGER'), alert('heat', 'WARNING', ack=NOW, nid=2, seq=6))
    assert sorted((i['alert_type'], i['level'], i['acknowledged']) for i in rt.audio_items()) == [('co_threshold', 'DANGER', False), ('heat', 'WARNING', True)]
    rt.writer.conn.close(); st.close()

def test_base_offline_and_the_two_banners_are_items_and_recovering_is_not(tmp_path):
    st, rt = mk(tmp_path, FakeBackend()); assert rt.audio_items() == []
    rt.health.offline = True; rt.port = NS(banner_state=lambda k: {'logging_fault': (True, None), 'host_gap': (True, 123)}[k])
    got = {i['alert_type']: i for i in rt.audio_items()}
    assert got['base_offline'] == dict(alert_type='base_offline', level='DANGER', acknowledged=False)
    assert got['logging_fault'] == dict(alert_type='logging_fault', level='WARNING', acknowledged=False)
    assert got['host_gap'] == dict(alert_type='host_gap', level='NONE', acknowledged=True) and 'recovering' not in got
    rt.port = NS(banner_state=lambda k: (False, None)); rt.health.offline = False; assert rt.audio_items() == []
    rt.writer.conn.close(); st.close()

# ---- the thread ----
def test_without_a_backend_there_is_no_audio_thread_and_the_feed_does_nothing(tmp_path):
    st, rt = mk(tmp_path, None); assert rt.audio is None; rt.audio_refresh(); rt.writer.conn.close(); st.close()

def test_start_starts_the_audio_thread_and_stop_ends_it(tmp_path):
    fb = FakeBackend(); st, rt = mk(tmp_path, fb); assert not rt.audio.is_alive(); rt.start()
    assert rt.audio.is_alive() and rt.audio.name == 'AudioThread' and until(lambda: 'probe.wav' in fb.played())      # the start-up self-check plays the silent probe
    rt.stop(); assert not rt.audio.is_alive(); st.close()

def test_audio_settings_come_from_settings_json(tmp_path):
    st, rt = mk(tmp_path, FakeBackend()); assert rt.audio.check_ms == 60_000 and rt.audio.chime_ms == 15 * 60_000 and rt.audio.sockets_fn is None
    rt.writer.conn.close(); st.close()

def test_load_open_feeds_the_audio_thread(tmp_path):
    st, rt = mk(tmp_path, FakeBackend()); got = []; rt.audio.set_items = got.append; rt.load_open(); assert got == [[]]
    rt.writer.conn.close(); st.close()

# ---- the Wire feed ----
def test_on_effects_feeds_audio_before_it_does_anything_else_and_an_empty_effect_list_does_not():
    order = []; w = NS(_changed=lambda: order.append('changed'), pending=deque(), _send=lambda fx: order.append('send'))
    W.Wire.on_effects(w, (), None, None); assert order == []
    W.Wire.on_effects(w, ('fx',), None, True); assert order == ['changed', 'send']
    order.clear(); W.Wire.on_effects(w, ('fx',), None, False); assert order == ['changed'] and len(w.pending) == 1      # a slow commit holds the message, not the alarm

def test_a_failing_on_change_is_logged_and_never_reaches_the_wire(caplog):
    def boom(): raise RuntimeError('x')
    W.Wire._changed(NS(on_change=boom)); W.Wire._changed(NS(on_change=None)); assert 'on_change failed' in caplog.text

def wired(tmp_path, fb):
    st, rt = mk(tmp_path, fb); rt.start(); app, hub = S.build_app(rt, asyncio.new_event_loop()); return st, rt, hub

def test_build_app_connects_the_audio_thread_to_the_hub_the_wire_and_the_session(tmp_path):
    st, rt, hub = wired(tmp_path, FakeBackend())
    assert rt.wire.on_change == rt.audio_refresh and rt.audio.sockets_fn() == 0 and rt.audio.monitoring_fn() is False
    rt.port.monitoring_active = True; assert rt.audio.monitoring_fn() is True
    rt.stop(); st.close()

def test_a_danger_alert_starts_the_siren_within_300_ms_of_the_effects(tmp_path):
    fb = FakeBackend(); st, rt, hub = wired(tmp_path, fb); assert until(lambda: 'probe.wav' in fb.played()); fb.calls.clear()
    put(rt, alert('co_threshold', 'DANGER')); t0 = time.monotonic()
    rt.wire.on_effects((RaiseAlert(5, 1, 'co_threshold', 'DANGER', '', 0),), None, True)       # what Wire.on_frame does after the engine decided
    assert until(lambda: ('play', 'siren.wav', True, False) in fb.calls, 0.3) and time.monotonic() - t0 < 0.3
    rt.stop(); st.close()

def test_acknowledging_the_alert_stops_the_siren(tmp_path):
    fb = FakeBackend(); st, rt, hub = wired(tmp_path, fb); put(rt, alert('co_threshold', 'DANGER')); rt.audio_refresh(); assert until(lambda: 'siren.wav' in fb.played())
    fb.calls.clear(); put(rt, alert('co_threshold', 'DANGER', ack=NOW)); rt.wire.on_effects((RaiseAlert(5, 1, 'co_threshold', 'DANGER', '', 0),), None, True)
    assert until(lambda: ('stop',) in fb.calls) and rt.audio.playing is None
    rt.stop(); st.close()

def test_a_banner_acknowledgement_reaches_the_audio_thread(tmp_path):
    fb = FakeBackend(); st, rt, hub = wired(tmp_path, fb); seen = []; rt.audio.set_items = lambda items: seen.append(items)
    rt.wire.on_banner_acknowledged('logging_fault', NOW); assert len(seen) == 1
    rt.stop(); st.close()

# ---- AUDIO FAULT ----
def test_a_failing_sound_card_writes_audio_fault_once_and_sets_the_banner_flag(tmp_path):
    fb = FakeBackend(fail=RuntimeError('no device')); st, rt, hub = wired(tmp_path, fb)
    assert until(lambda: events(rt, 'AUDIO_FAULT') == 1) and rt.audio.audio_fault and rt.wire.audio_fault() is True
    time.sleep(0.3); assert events(rt, 'AUDIO_FAULT') == 1 and events(rt, 'AUDIO_OK') == 0             # once per fault
    rt.stop(); st.close()

def test_a_working_sound_card_writes_no_audio_event_and_the_flag_is_off(tmp_path):
    fb = FakeBackend(); st, rt, hub = wired(tmp_path, fb); assert until(lambda: 'probe.wav' in fb.played()); time.sleep(0.2)
    assert events(rt, 'AUDIO_FAULT') == 0 and rt.wire.audio_fault() is False
    rt.stop(); st.close()

def test_the_wire_flag_is_false_when_there_is_no_audio_thread(tmp_path):
    st, rt = mk(tmp_path, None); rt.start(); app, hub = S.build_app(rt, asyncio.new_event_loop()); assert rt.wire.audio_fault() is False
    rt.stop(); st.close()

# ---- the thread-safe tab count ----
def test_tab_counter_retries_when_the_set_changes_and_assumes_a_tab_after_three_failures():
    calls = []
    def flaky():
        calls.append(1)
        if len(calls) < 3: raise RuntimeError('Set changed size during iteration')
        return 2
    assert S.tab_counter(NS(connected_tabs=flaky))() == 2 and len(calls) == 3
    def always(): raise RuntimeError('x')
    assert S.tab_counter(NS(connected_tabs=always))() == 1                                           # never a false zero-socket warning

# ---- main() ----
def test_main_runs_the_audio_thread_during_step_10_and_stops_it_afterwards(tmp_path):
    h = home(tmp_path); box = {}
    async def serve(rt, host, port): box['rt'] = rt; box['alive'] = rt.audio.is_alive(); box['backend'] = rt.audio.backend
    assert M.main(['--home', str(h)], serve=serve) == 0
    assert box['alive'] and isinstance(box['backend'], FakeBackend) and not box['rt'].audio.is_alive()      # conftest swaps in the silent backend

def test_the_real_backend_is_the_winsound_one():
    from pathlib import Path
    assert 'def make_audio_backend(): return WinsoundBackend()' in Path(M.__file__).read_text(encoding='utf-8')       # conftest replaces the function in tests, so read the source
