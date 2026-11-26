"""P23b: AudioThread with a fake sound card and a FakeClock (design 3.12, 3.3, 5; guide P23). Run: python -m pytest host/tests/test_audio_thread.py -q
Needs host/sounds/ from tools/gen_sounds.py."""
import importlib.util, sys, threading, time
from pathlib import Path
import pytest
from ppe_host import cli
from ppe_host.clock import FakeClock
from ppe_host.io import audio_watchdog as aw
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gen_sounds', ROOT / 'tools' / 'gen_sounds.py'); gs = importlib.util.module_from_spec(spec); sys.modules['gen_sounds'] = gs; spec.loader.exec_module(gs)
CAT = aw.load_catalog()

class FakeCard:
    """Records (mono ms, call, name); fail_play makes play() raise RuntimeError like a missing device."""
    def __init__(self, clock): self.clock, self.log, self.fail_play = clock, [], None
    def play(self, path, loop=False, wait=False):
        if self.fail_play: raise RuntimeError(self.fail_play)
        self.log.append((self.clock.mono_ms(), 'loop' if loop else 'sync' if wait else 'play', Path(path).stem))
    def beep(self, hz, ms): self.log.append((self.clock.mono_ms(), 'pulse', (hz, ms)))
    def stop(self): self.log.append((self.clock.mono_ms(), 'stop', None))
    def starts(self, name=None): return [e for e in self.log if e[1] in ('play', 'loop') and (name is None or e[2] == name)]
    def pulses(self): return [e[0] for e in self.log if e[1] == 'pulse']
    def probes(self): return [e for e in self.log if e[1] == 'sync' and e[2] == 'probe']
def item(t, level, ack=False): return {'alert_type': t, 'level': level, 'acknowledged': ack}
DANGER, WARN = item('co_threshold', 'DANGER'), item('battery_low', 'WARNING')

def make(tmp_path=None, **kw):
    clock = FakeClock(0, 1_000); card = FakeCard(clock); events = []
    kw.setdefault('sounds_dir', aw.SOUNDS_DIR)
    t = aw.AudioThread(card, clock, CAT, on_event=lambda k, d: events.append((k, d)), **kw); return t, clock, card, events
def run_for(t, clock, ms, step=50):
    for _ in range(ms // step): clock.advance(step); t.tick()
def sounds_copy(tmp_path): gs.main(['--out', str(tmp_path)]); return tmp_path

def test_alarm_before_start_monitoring_sounds_with_no_operator_click():   # 3.12, Rev 3.29: a verified man-down frame sounds the host alarm from host start
    t, clock, card, _ = make(monitoring_fn=lambda: False, sockets_fn=lambda: 1); t.tick(); card.log.clear()
    t.set_items([item('man_down', 'DANGER')]); t.tick(); assert card.log == [(1_000, 'loop', 'siren')] and t.playing == 'siren'
def test_siren_is_started_once_and_loops_until_acknowledged():
    t, clock, card, _ = make(); t.tick(); card.log.clear(); t.set_items([DANGER]); run_for(t, clock, 30_000)
    assert len(card.starts('siren')) == 1 and card.log[0][1] == 'loop'
    t.set_items([item('co_threshold', 'DANGER', True)]); t.tick(); assert t.playing is None and card.log[-1][1] == 'stop'
def test_acknowledge_stops_that_card_only():
    t, clock, card, _ = make(); a, b = item('man_down', 'DANGER'), item('link_lost', 'DANGER'); t.set_items([a, b]); t.tick(); card.log.clear()
    t.set_items([dict(a, acknowledged=True), b]); run_for(t, clock, 1_000); assert t.playing == 'siren' and not [e for e in card.log if e[1] == 'stop']
    t.set_items([dict(a, acknowledged=True), dict(b, acknowledged=True)]); t.tick(); assert t.playing is None
def test_a_second_danger_during_an_acknowledged_one_restarts_the_sound():
    t, clock, card, _ = make(); t.set_items([item('man_down', 'DANGER', True)]); t.tick(); assert t.playing is None; card.log.clear()
    t.set_items([item('man_down', 'DANGER', True), item('link_lost', 'DANGER')]); t.tick(); assert card.starts('siren') and t.playing == 'siren'
def test_priority_one_sound_at_a_time_highest_class_plays():   # 3.3 Rev 3.17
    t, clock, card, _ = make(); t.set_items([WARN]); t.tick(); assert t.playing == 'beep'
    t.set_items([WARN, item('unauth_alert', 'NONE'), item('recovering', 'NONE'), item('estimate', 'NONE')]); t.tick(); assert t.playing == 'beep'
    t.set_items([WARN, DANGER]); t.tick(); assert t.playing == 'siren' and card.log[-2:] == [(1_000, 'stop', None), (1_000, 'loop', 'siren')]
    t.set_items([WARN]); t.tick(); assert t.playing == 'beep'                       # back to the lower class once the siren item is gone
    t.set_items([item('estimate', 'NONE'), item('host_gap', 'NONE')]); t.tick(); assert t.playing == 'one_beep'
    t.set_items([item('estimate', 'NONE')]); t.tick(); assert t.playing == 'chime'
def test_base_offline_and_mayday_outrank_other_danger_but_are_one_siren():
    t, _, card, _ = make(); t.set_items([item('base_offline', 'DANGER'), DANGER, WARN]); t.tick(); assert t.playing == 'siren' and len(card.starts()) == 1
def test_beep_repeats_every_10_s_within_1_s_with_every_tab_closed():   # guide P23: hidden or closed browser for 10 min
    t, clock, card, _ = make(sockets_fn=lambda: 0, monitoring_fn=lambda: True); t.set_items([WARN]); t.tick(); card.log.clear(); t0 = clock.mono_ms()
    run_for(t, clock, 600_000); ts = [e[0] - t0 for e in card.starts('beep')]
    assert 59 <= len(ts) <= 61 and all(abs(b - a - 10_000) <= 1_000 for a, b in zip(ts, ts[1:]))
def test_one_beep_repeats_and_chime_plays_once():
    t, clock, card, _ = make(); t.set_items([item('recovering', 'NONE')]); t.tick(); card.log.clear(); run_for(t, clock, 25_000); assert len(card.starts('one_beep')) == 2
    card.log.clear(); t.set_items([item('estimate', 'NONE')]); t.tick(); run_for(t, clock, 60_000); assert [e[2] for e in card.starts()] == ['chime']
def test_host_chime_every_15_min_idle_and_suppressed_while_a_safety_alert_is_open():   # 3.12 (a), D8
    t, clock, card, _ = make(); t.tick(); run_for(t, clock, 14 * 60_000 + 59_000); assert not card.starts('host_chime')
    run_for(t, clock, 2_000); assert len(card.starts('host_chime')) == 1; run_for(t, clock, 14 * 60_000); assert len(card.starts('host_chime')) == 1
    run_for(t, clock, 61_000); assert len(card.starts('host_chime')) == 2
    t.set_items([DANGER]); run_for(t, clock, 20 * 60_000); assert len(card.starts('host_chime')) == 2          # open for 20 min: no chime
    t.set_items([item('co_threshold', 'DANGER', True)]); t.tick(); run_for(t, clock, 14 * 60_000); assert len(card.starts('host_chime')) == 2
    run_for(t, clock, 61_000); assert len(card.starts('host_chime')) == 3                                      # 15 min after the alarm ended
def test_self_check_plays_a_silent_probe_every_60_s_only_while_idle():
    t, clock, card, _ = make(); t.tick(); assert len(card.probes()) == 1; run_for(t, clock, 180_000); assert len(card.probes()) == 4
    t.set_items([WARN]); n = len(card.probes()); run_for(t, clock, 180_000); assert len(card.probes()) == n
def test_failing_then_working_sink_writes_audio_fault_once_then_audio_ok():   # D8
    t, clock, card, ev = make(); card.fail_play = 'no device'; t.tick(); run_for(t, clock, 180_000)
    assert [k for k, _ in ev] == ['AUDIO_FAULT'] and 'no device' in ev[0][1] and t.audio_fault
    card.fail_play = None; run_for(t, clock, 60_000); assert [k for k, _ in ev] == ['AUDIO_FAULT', 'AUDIO_OK'] and not t.audio_fault
    run_for(t, clock, 120_000); assert len(ev) == 2
def test_a_failed_play_during_an_alarm_is_the_fault_and_the_pulse_sounds_every_2_s():
    t, clock, card, ev = make(); t.tick(); card.fail_play = 'device removed'; t.set_items([DANGER]); t.tick(); t0 = clock.mono_ms(); run_for(t, clock, 6_000)
    assert [k for k, _ in ev] == ['AUDIO_FAULT'] and [e[2] for e in card.log if e[1] == 'pulse'] == [(1000, 400)] * 4 and [p - t0 for p in card.pulses()][:4] == [0, 2_000, 4_000, 6_000]
    card.fail_play = None; run_for(t, clock, 2_000); assert card.starts('siren') and [k for k, _ in ev] == ['AUDIO_FAULT', 'AUDIO_OK']      # the WAV is tried again at each pulse
def test_missing_wav_raises_audio_fault_at_start_and_the_alarm_pulses_instead(tmp_path):
    d = sounds_copy(tmp_path); (d / 'beep.wav').unlink(); t, clock, card, ev = make(sounds_dir=d); t.set_items([WARN]); t.tick(); t0 = clock.mono_ms()
    assert ev == [('AUDIO_FAULT', 'beep.wav missing')] and not card.starts('beep'); run_for(t, clock, 4_000); assert [p - t0 for p in card.pulses()] == [0, 2_000, 4_000]
def test_altered_wav_is_not_trusted_and_a_restored_file_clears_the_fault_at_the_next_check(tmp_path):
    d = sounds_copy(tmp_path); good = (d / 'siren.wav').read_bytes(); b = bytearray(good); b[200] ^= 1; (d / 'siren.wav').write_bytes(bytes(b))
    t, clock, card, ev = make(sounds_dir=d); t.set_items([DANGER]); t.tick(); assert ev[0][0] == 'AUDIO_FAULT' and 'siren.wav altered' in ev[0][1] and not card.starts('siren') and card.pulses()
    (d / 'siren.wav').write_bytes(good); run_for(t, clock, 62_000); assert [k for k, _ in ev] == ['AUDIO_FAULT', 'AUDIO_OK'] and t.playing == 'siren' and card.starts('siren')
def test_a_missing_manifest_is_a_fault_but_the_files_still_play(tmp_path):
    d = sounds_copy(tmp_path); (d / 'manifest.json').unlink(); t, clock, card, ev = make(sounds_dir=d); t.set_items([WARN]); t.tick()
    assert ev == [('AUDIO_FAULT', 'manifest.json missing')] and card.starts('beep')
def test_zero_socket_warning_after_10_s_while_monitoring_and_stops_when_a_tab_returns():   # ADR 0026, D8 row
    n, mon = [0], [True]; t, clock, card, _ = make(sockets_fn=lambda: n[0], monitoring_fn=lambda: mon[0]); t.tick(); card.log.clear()
    run_for(t, clock, 9_900); assert not card.starts(); run_for(t, clock, 200); assert [e[2] for e in card.starts()] == ['beep']
    run_for(t, clock, 10_000); assert len(card.starts('beep')) == 2
    n[0] = 1; t.tick(); assert t.playing is None; card.log.clear(); run_for(t, clock, 20_000); assert not card.starts()
    n[0] = 0; run_for(t, clock, 9_000); assert not card.starts(); run_for(t, clock, 1_500); assert card.starts('beep')               # a fresh 10 s is counted
def test_zero_socket_warning_is_off_without_monitoring_or_without_a_socket_source():
    t, clock, card, _ = make(sockets_fn=lambda: 0, monitoring_fn=lambda: False); t.tick(); card.log.clear(); run_for(t, clock, 60_000); assert not card.starts()
    t2, c2, k2, _ = make(); t2.tick(); k2.log.clear(); run_for(t2, c2, 60_000); assert not k2.starts()
def test_zero_socket_warning_never_hides_a_siren():
    t, clock, card, _ = make(sockets_fn=lambda: 0, monitoring_fn=lambda: True); run_for(t, clock, 11_000); assert t.playing == 'beep'
    t.set_items([DANGER]); t.tick(); assert t.playing == 'siren'; t.set_items([]); t.tick(); assert t.playing == 'beep'
def test_broadcast_to_host_alarm_start_within_300_ms_median_and_maximum():   # design 5: real thread, real clock, mocked sink
    from ppe_host.clock import RealClock
    clock = RealClock(); seen = []; ev = threading.Event()
    class Card(FakeCard):
        def play(self, path, loop=False, wait=False):
            if Path(path).stem == 'siren': seen.append(time.monotonic()); ev.set()
    t = aw.AudioThread(Card(clock), clock, CAT); t.start(); time.sleep(0.2); lat = []
    try:
        for _ in range(20):
            ev.clear(); t0 = time.monotonic(); t.set_items([DANGER]); assert ev.wait(1.0); lat.append(seen[-1] - t0); t.set_items([]); time.sleep(0.12)
    finally: t.stop(); t.join(2)
    lat.sort(); assert lat[len(lat) // 2] < 0.3 and lat[-1] < 0.3, lat
def test_one_bad_tick_does_not_end_the_thread():
    from ppe_host.clock import RealClock
    clock = RealClock(); bad = [True]; ev = threading.Event()
    def sockets():
        if bad[0]: bad[0] = False; raise ValueError('boom')
        return 1
    class Card(FakeCard):
        def play(self, path, loop=False, wait=False): ev.set()
    t = aw.AudioThread(Card(clock), clock, CAT, sockets_fn=sockets, monitoring_fn=lambda: True); t.start(); time.sleep(0.2); t.set_items([DANGER])
    try: assert ev.wait(1.0) and t.errors == 1 and t.is_alive()
    finally: t.stop(); t.join(2)
def test_winsound_backend_reports_a_missing_device_as_runtime_error_off_windows():
    if sys.platform == 'win32': pytest.skip('real winsound')
    with pytest.raises(RuntimeError): aw.WinsoundBackend().play('x.wav')
def test_run_test_alarm_plays_siren_beep_and_host_chime_and_reports_faults(tmp_path):
    clock = FakeClock(); card = FakeCard(clock); naps = []
    ok, msg = aw.run_test_alarm(card, 3, sleep=naps.append, catalog=CAT); assert ok and naps == [3] and [(e[1], e[2]) for e in card.log] == [('loop', 'siren'), ('stop', None), ('sync', 'beep'), ('sync', 'host_chime')]
    d = sounds_copy(tmp_path); (d / 'chime.wav').unlink(); card.log.clear(); ok, msg = aw.run_test_alarm(card, 3, sleep=naps.append, sounds_dir=d, catalog=CAT); assert not ok and 'chime.wav missing' in msg and not card.log
    card.fail_play = 'no device'; ok, msg = aw.run_test_alarm(card, 3, sleep=naps.append, catalog=CAT); assert not ok and 'no device' in msg
def test_cli_test_alarm_exit_codes(monkeypatch, capsys):
    clock = FakeClock(); card = FakeCard(clock); monkeypatch.setattr(aw, 'WinsoundBackend', lambda: card); monkeypatch.setattr(time, 'sleep', lambda s: None)
    assert cli.main(['test-alarm', '--seconds', '1']) == 0 and 'test-alarm: played siren for 1 s' in capsys.readouterr().out
    card.fail_play = 'no device'; assert cli.main(['test-alarm']) == 1 and 'AUDIO FAULT' in capsys.readouterr().err
