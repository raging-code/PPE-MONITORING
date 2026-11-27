"""P24b Part 2: io/os_watchdog.py (ADR 0036) — Liveness, the marker file, OSWatchdogThread.check()/run()/stop(), and the next-start read (consume_marker)."""
import json
import pytest
from ppe_host.clock import FakeClock
from ppe_host.io import os_watchdog as W

def mk(tmp_path, stall_s=3, check_s=0.01):
    c = FakeClock(wall_ms=1_700_000_000_000, mono_ms=0)
    live = W.Liveness(c)
    marker = tmp_path / 'logs' / W.MARKER_NAME
    exits = []
    th = W.OSWatchdogThread(live, c, marker, stall_s=stall_s, exit_fn=lambda code: exits.append(code), check_s=check_s)
    return c, live, marker, exits, th

def test_all_fresh_stamps_mean_no_stall(tmp_path):
    c, live, marker, exits, th = mk(tmp_path)
    live.stamp('serial'); live.stamp('loop'); live.stamp('tick')
    c.advance(2900)                                           # under the 3 s limit
    assert th.check() is None and exits == [] and not marker.exists()

def test_a_part_that_never_stamped_is_simply_absent_not_stale(tmp_path):
    c, live, marker, exits, th = mk(tmp_path)
    live.stamp('serial'); live.stamp('loop')                   # 'tick' never stamped (e.g. before step 10 starts); it must never appear in ages()
    c.advance(2900)                                            # under the limit for the parts that did stamp
    assert th.check() is None and exits == [] and 'tick' not in live.ages()

def test_a_stale_stamp_writes_the_marker_before_exit_and_calls_exit_fn(tmp_path):
    c, live, marker, exits, th = mk(tmp_path)
    live.stamp('serial'); live.stamp('loop')
    c.advance(3_001); live.stamp('tick')                        # 'tick' is fresh; 'serial' and 'loop' are now 3001 ms old
    body = th.check()
    assert exits == [1] and th.marker_ok is True and marker.exists()
    assert body['kind'] == 'stall' and body['age_ms'] == 3001 and body['limit_ms'] == 3000
    assert body['stalled'] in ('serial', 'loop') and 'tick' not in body['stale']
    assert json.loads(marker.read_text()) == body              # the file on disk matches what check() returned

def test_the_worst_of_several_stale_stamps_is_named(tmp_path):
    c, live, marker, exits, th = mk(tmp_path)
    live.stamp('serial'); c.advance(1000)
    live.stamp('loop'); c.advance(1000)
    live.stamp('tick'); c.advance(3_500)                        # ages at check time: serial 5500, loop 4500, tick 3500
    body = th.check()
    assert body['stalled'] == 'serial' and set(body['stale']) == {'serial', 'loop', 'tick'}
    assert body['ages']['serial'] == 5500 and body['ages']['tick'] == 3500

def test_retire_takes_a_part_out_of_judgement_entirely(tmp_path):
    c, live, marker, exits, th = mk(tmp_path)
    live.stamp('serial'); live.retire('serial'); live.stamp('tick')
    c.advance(10_000); live.stamp('tick')                       # keep re-stamping 'tick' so only 'serial' could ever fire, and it's retired
    assert th.check() is None and exits == [] and 'serial' not in live.ages()

def test_a_retired_part_that_stamps_again_is_judged_from_its_new_stamp(tmp_path):
    c, live, marker, exits, th = mk(tmp_path)
    live.stamp('serial'); live.retire('serial')
    c.advance(10_000)
    live.stamp('serial')                                        # fresh again
    assert th.check() is None and exits == []

def test_a_failed_marker_write_does_not_stop_the_exit(tmp_path, monkeypatch):
    c, live, marker, exits, th = mk(tmp_path)
    monkeypatch.setattr(W, 'write_marker', lambda *a, **k: False)
    live.stamp('tick'); c.advance(5000)
    body = th.check()
    assert exits == [1] and th.marker_ok is False and body is not None

def test_run_fires_once_through_the_wait_loop_and_stops_after_a_fake_exit(tmp_path):
    c, live, marker, exits, th = mk(tmp_path, check_s=0.01)
    live.stamp('tick'); c.advance(5000)
    th.run()                                                     # exit_fn here is the recorder, so run() returns instead of killing the process
    assert exits == [1] and th.checks >= 1

def test_one_bad_pass_in_run_is_counted_and_does_not_end_the_thread(tmp_path):
    c, live, marker, exits, th = mk(tmp_path, check_s=0.001)
    bad = {'n': 0}
    def boom():
        bad['n'] += 1
        if bad['n'] == 1: raise RuntimeError('transient')
        th.stop(); return None
    th.check = boom
    th.run()
    assert th.errors == 1 and bad['n'] == 2

def test_stop_halts_run_even_when_nothing_ever_stalls(tmp_path):
    c, live, marker, exits, th = mk(tmp_path, check_s=0.001)
    live.stamp('tick')
    def ok():
        th.checks += 1
        if th.checks >= 3: th.stop()
        return None
    th.check = ok
    th.run()
    assert exits == [] and th.checks == 3

# --- write_marker / consume_marker -----------------------------------------------------------

def test_write_marker_is_atomic_and_readable_back(tmp_path):
    p = tmp_path / 'logs' / W.MARKER_NAME
    body = {'kind': 'stall', 'stalled': 'tick'}
    assert W.write_marker(p, body) is True
    assert not p.with_name(p.name + '.tmp').exists()
    assert json.loads(p.read_text()) == body

def test_write_marker_returns_false_and_never_raises_on_a_bad_path():
    assert W.write_marker('/this/does/not/exist/\x00bad', {'a': 1}) is False

def test_consume_marker_returns_none_when_there_is_no_marker(tmp_path):
    assert W.consume_marker(tmp_path / 'logs') is None

def test_consume_marker_reads_the_body_and_rotates_it_to_last(tmp_path):
    d = tmp_path / 'logs'; p = d / W.MARKER_NAME
    body = {'kind': 'stall', 'stalled': 'tick', 'age_ms': 4000}
    W.write_marker(p, body)
    got = W.consume_marker(d)
    assert got == body
    assert not p.exists() and json.loads((d / W.LAST_MARKER_NAME).read_text()) == body

def test_consume_marker_handles_a_damaged_file_without_raising(tmp_path):
    d = tmp_path / 'logs'; d.mkdir(); (d / W.MARKER_NAME).write_text('{not json')
    got = W.consume_marker(d)
    assert got == {'kind': 'unreadable'}
    assert not (d / W.MARKER_NAME).exists()

def test_consume_marker_handles_a_json_value_that_is_not_an_object(tmp_path):
    d = tmp_path / 'logs'; d.mkdir(); (d / W.MARKER_NAME).write_text('[1, 2, 3]')
    assert W.consume_marker(d) == {'kind': 'unreadable'}

def test_consume_marker_called_twice_in_a_row_is_none_the_second_time(tmp_path):
    d = tmp_path / 'logs'; W.write_marker(d / W.MARKER_NAME, {'kind': 'stall'})
    first = W.consume_marker(d); second = W.consume_marker(d)
    assert first == {'kind': 'stall'} and second is None

# --- Liveness ----------------------------------------------------------------------------------

def test_ages_reports_milliseconds_since_each_named_stamp():
    c = FakeClock(mono_ms=1000); live = W.Liveness(c)
    live.stamp('a'); c.advance(250); live.stamp('b'); c.advance(100)
    assert live.ages() == {'a': 350, 'b': 100}

def test_stamper_returns_a_zero_arg_callable_bound_to_the_name():
    c = FakeClock(); live = W.Liveness(c)
    bump = live.stamper('loop'); c.advance(42); bump()
    assert live.ages() == {'loop': 0}
