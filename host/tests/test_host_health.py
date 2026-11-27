"""P24b-3: HostHealth (QUEUE_OVERFLOW, HOST_BATTERY, DISK_LOW, the host_power string), the LOGGING_FAULT callback and the HOST BATTERY audio item. Requirements: REQ-DB-002."""
import json
from types import SimpleNamespace as NS
from ppe_host.clock import FakeClock
from ppe_host.io import health as H

def make(bat=(False, None), disk=5.0, **kw):
    clock, ev = FakeClock(0, 0), []
    w = NS(counters={'queue_overflow': 0})
    st = dict(bat=bat, disk=disk)
    hh = H.HostHealth(clock, lambda k, d: ev.append((k, d)), w, '.', read_battery=lambda: st['bat'], read_disk_gb=lambda p: st['disk'], **kw)
    return hh, clock, ev, w, st

def test_host_power_string_matches_what_the_dashboard_parses():
    assert H.host_power_str(False, 10, 30) == 'ac' and H.host_power_str(True, None, 30) == 'battery' and H.host_power_str(True, 80, 30) == 'battery'
    assert H.host_power_str(True, 30, 30) == 'battery 30%' and H.host_power_str(True, 22, 30) == 'battery 22%'      # a number appears only at or below the threshold

def test_mains_and_enough_disk_log_nothing_and_read_once_a_minute():
    hh, c, ev, w, st = make(); calls = []; hh._read_battery = lambda: calls.append(1) or (False, None)
    for _ in range(59): hh.tick(); c.advance(1000)
    assert len(calls) == 1 and ev == []                                       # the first tick reads at once, the next read is 60 s later
    c.advance(1000); hh.tick(); assert len(calls) == 2 and hh.host_power() == 'ac' and hh.audio_level() is None

def test_on_battery_is_logged_once_then_again_at_the_threshold_then_after_a_return_to_mains():
    hh, c, ev, w, st = make(); st['bat'] = (True, 80); hh.check(); hh.check()
    assert ev == [('HOST_BATTERY', 'on battery 80%')] and hh.audio_level() == 'NONE' and hh.host_power() == 'battery'
    st['bat'] = (True, 25); hh.check(); hh.check()
    assert ev[-1] == ('HOST_BATTERY', 'on battery 25% (at or below 30%)') and len(ev) == 2 and hh.audio_level() == 'WARNING' and hh.host_power() == 'battery 25%'
    st['bat'] = (False, 25); hh.check(); assert len(ev) == 2 and hh.audio_level() is None and hh.host_power() == 'ac'
    st['bat'] = (True, None); hh.check(); assert len(ev) == 3 and ev[-1][1] == 'on battery'                          # unknown percent: notice only

def test_disk_low_is_logged_at_onset_and_again_only_after_it_cleared():
    hh, c, ev, w, st = make(); st['disk'] = 0.5; hh.check(); hh.check()
    assert ev == [('DISK_LOW', 'free 0.50 GB, minimum 1.00 GB')]
    st['disk'] = 2.0; hh.check(); st['disk'] = 0.9; hh.check(); assert [k for k, _ in ev] == ['DISK_LOW', 'DISK_LOW']

def test_unknown_readings_are_not_alarms():
    hh, c, ev, w, st = make(disk=None); hh.check(); assert ev == []
    def boom(): raise OSError('x')
    hh._read_battery = boom; hh._read_disk_gb = lambda p: (_ for _ in ()).throw(OSError('x')); hh.check(); assert ev == [] and hh.host_power() == 'ac'

def test_queue_overflow_is_logged_when_the_counter_grows_and_at_most_once_a_minute():
    hh, c, ev, w, st = make(); hh.tick(); assert ev == []
    w.counters['queue_overflow'] = 3; c.advance(1000); hh.tick(); assert ev == [('QUEUE_OVERFLOW', '3 unit(s) over the writer queue limit since the last report (total 3)')]
    w.counters['queue_overflow'] = 5; c.advance(1000); hh.tick(); assert len(ev) == 1                                  # inside the minute: counted, not logged
    c.advance(60000); hh.tick(); assert ev[-1][1] == '2 unit(s) over the writer queue limit since the last report (total 5)' and len(ev) == 2
    c.advance(120000); hh.tick(); assert len(ev) == 2                                                                  # no growth, no event

def test_a_custom_threshold_is_used():
    hh, c, ev, w, st = make(warn_pct=50, disk_min_gb=10.0); st['bat'] = (True, 45); st['disk'] = 5.0; hh.check()
    assert [k for k, _ in ev] == ['HOST_BATTERY', 'DISK_LOW'] and hh.host_power() == 'battery 45%'

# ---- through the Runtime ----
from test_audio_wiring import mk
from fakeaudio import FakeBackend

def close(rt, st): rt.writer.conn.close(); st.close()

def test_the_runtime_builds_host_health_from_settings(tmp_path):
    st, rt = mk(tmp_path, FakeBackend())
    assert rt.host_health.warn_pct == st.settings['host_bat_warn_pct'] and rt.host_health.disk_min_gb == st.settings['host_disk_min_gb']
    assert rt.host_health.disk_path == st.db_path.parent and rt.host_health.host_power() == 'ac'; close(rt, st)

def test_the_1hz_tick_runs_host_health_and_a_failure_does_not_stop_the_others(tmp_path):
    st, rt = mk(tmp_path, FakeBackend()); seen = []
    rt.host_health.tick = lambda: seen.append('hh') or (_ for _ in ()).throw(RuntimeError('x'))
    rt.liveness.stamp = lambda n: seen.append(n); rt.tick()
    assert seen == ['hh', 'tick'] and rt.ticks == 1; close(rt, st)

def test_audio_items_carry_host_power_only_when_on_battery(tmp_path):
    st, rt = mk(tmp_path, FakeBackend()); rt.port = NS(banner_state=lambda k: (False, None)); assert rt.audio_items() == []
    rt.host_health._bat_level = 1; assert rt.audio_items() == [dict(alert_type='host_power', level='NONE', acknowledged=False)]
    rt.host_health._bat_level = 2; assert rt.audio_items() == [dict(alert_type='host_power', level='WARNING', acknowledged=False)]; close(rt, st)

def test_a_low_battery_reaches_the_audio_thread_as_the_beep(tmp_path):
    from ppe_host.io.audio_watchdog import host_rank, RANK_WARNING
    from ppe_host.io.audio_watchdog import load_catalog
    cat = load_catalog()
    assert host_rank('host_power', 'WARNING', cat) == (RANK_WARNING, 'beep') and host_rank('host_power', 'NONE', cat) is None

def test_a_logging_fault_in_the_writer_becomes_a_system_event(tmp_path):
    st, rt = mk(tmp_path, FakeBackend()); rt.writer.on_logging_fault('alerts', 'UNIQUE constraint failed: x')
    rt.writer.start(); rt.writer.stop(drain=True)
    import sqlite3; c = sqlite3.connect(str(st.db_path)); rows = c.execute("SELECT detail FROM system_events WHERE kind = 'LOGGING_FAULT'").fetchall(); c.close()
    assert [json.loads(r[0]) for r in rows] == [{'table': 'alerts', 'error': 'UNIQUE constraint failed: x'}]; st.close()

def test_serve_gives_wire_the_host_power_reader(tmp_path):
    import inspect; from ppe_host import serve
    assert 'host_power=rt.host_health.host_power' in inspect.getsource(serve.build_app)
