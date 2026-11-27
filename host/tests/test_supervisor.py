"""P24-5a: scripts/run_supervisor.py (ADR 0046): respawn within 500 ms on a non-zero exit, no respawn on exit code 0, the crash-loop guard (5 non-zero exits within 60 s, then 5 s between respawns, the error window with the last crash marker, the local alarm), exit code 2 counts.
Requirements: REQ-REC-007"""
import importlib.util, json, os, subprocess, sys, time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'run_supervisor.py'
spec = importlib.util.spec_from_file_location('run_supervisor', SCRIPT); S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

class Child:
    def __init__(self, rc, clock=None, run_s=0, interrupt=False): self.rc, self.clock, self.run_s, self.interrupt, self.terminated = rc, clock, run_s, interrupt, False
    def wait(self):
        if self.interrupt: raise KeyboardInterrupt
        if self.clock is not None: self.clock.t += self.run_s
        return self.rc
    def terminate(self): self.terminated = True

class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t

def rig(codes, run_s=0, marker=None):
    """A supervisor over a list of exit codes (or (code, run_seconds) pairs); sleep advances the fake clock and the list running out ends the run with 0."""
    clock, sleeps, windows, alarms, logs, children = Clock(), [], [], [], [], []
    it = iter(list(codes) + [0])
    def spawn():
        c = next(it); rc, r = c if isinstance(c, tuple) else (c, run_s); ch = Child(rc, clock, r); children.append(ch); return ch
    def sleep(s): sleeps.append(s); clock.t += s
    sup = S.Supervisor(spawn, clock=clock, sleep=sleep, marker=lambda: marker, show_error=windows.append, alarm=lambda: alarms.append(1), log=logs.append)
    return sup, clock, sleeps, windows, alarms, logs, children

def test_exit_code_0_is_never_respawned():
    sup, _, sleeps, windows, alarms, _, children = rig([0, 1, 1])
    assert sup.run() == 0 and len(children) == 1 and not sleeps and not windows and not alarms

def test_a_non_zero_exit_is_respawned_at_once_with_no_wait():
    sup, _, sleeps, windows, alarms, _, children = rig([1, 0])
    assert sup.run() == 0 and len(children) == 2 and sleeps == [] and windows == [] and alarms == []
    assert sup.last_gap_ms is not None and sup.last_gap_ms <= S.RESPAWN_BUDGET_MS

def test_four_non_zero_exits_do_not_start_the_guard():
    sup, _, sleeps, windows, alarms, _, children = rig([1, 1, 1, 1, 0])
    assert sup.run() == 0 and len(children) == 5 and sleeps == [] and windows == [] and alarms == []

def test_the_fifth_non_zero_exit_waits_5_s_shows_the_window_once_and_sounds_the_alarm():
    sup, _, sleeps, windows, alarms, _, children = rig([1, 1, 1, 1, 1, 0])
    assert sup.run() == 0 and len(children) == 6
    assert sleeps == [5] and len(windows) == 1 and len(alarms) == 1

def test_the_guard_keeps_waiting_5_s_between_respawns_and_the_window_is_not_repeated():
    sup, _, sleeps, windows, alarms, _, children = rig([1] * 8 + [0])
    assert sup.run() == 0 and len(children) == 9
    assert sleeps == [5, 5, 5, 5] and len(windows) == 1 and len(alarms) == 4

def test_exit_code_2_counts_toward_the_guard():
    sup, _, sleeps, windows, _, _, _ = rig([2, 2, 2, 2, 2, 0])
    assert sup.run() == 0 and sleeps == [5] and len(windows) == 1 and 'Last exit code: 2' in windows[0] and 'configuration or database' in windows[0]

def test_a_signal_style_negative_exit_code_counts_too():
    sup, _, sleeps, _, _, _, _ = rig([-9, 1, 2, 3, -1, 0])
    assert sup.run() == 0 and sleeps == [5]

def test_exits_spread_over_more_than_60_s_never_start_the_guard():
    sup, _, sleeps, windows, _, _, children = rig([(1, 20)] * 8 + [0])         # one exit every 20 s: at most 3 fit in the 60 s window
    assert sup.run() == 0 and len(children) == 9 and sleeps == [] and windows == []

def test_the_guard_ends_after_a_run_of_more_than_60_s():
    sup, _, sleeps, windows, _, _, _ = rig([1, 1, 1, 1, 1, (1, 61), 1, 1, 0])
    assert sup.run() == 0 and sleeps == [5]                                    # only the fifth exit waited; after the long run the old exits are out of the window
    assert len(windows) == 1

def test_a_second_crash_loop_shows_the_window_again():
    sup, _, sleeps, windows, _, _, _ = rig([1, 1, 1, 1, 1, (1, 61), 1, 1, 1, 1, 0])
    sup.run(); assert len(windows) == 2 and sleeps == [5, 5]

def test_the_window_text_names_the_count_the_exit_code_and_the_crash_marker():
    marker = {'v': 1, 'kind': 'stall', 'ts': 1700000000000, 'stalled': 'loop', 'age_ms': 3400, 'limit_ms': 3000}
    sup, _, _, windows, _, _, _ = rig([1] * 5 + [0], marker=marker); sup.run()
    t = windows[0]
    assert '5 times' in t and 'Last exit code: 1' in t and 'kind=stall' in t and 'stalled=loop' in t and 'age_ms=3400' in t and 'LAPTOP OFFLINE' in t

def test_the_window_says_so_when_there_is_no_marker_or_the_marker_is_damaged():
    s1, *_r = rig([1] * 5 + [0]); w1 = _r[2]; s1.run(); assert 'none found' in w1[0]
    s2, *_r2 = rig([1] * 5 + [0], marker={'kind': 'unreadable'}); w2 = _r2[2]; s2.run(); assert 'damaged' in w2[0]

def test_a_host_that_cannot_be_started_counts_as_a_non_zero_exit_and_is_logged():
    clock, sleeps, windows, logs = Clock(), [], [], []
    def spawn(): raise OSError('python not found')
    sup = S.Supervisor(spawn, clock=clock, sleep=lambda s: (sleeps.append(s), _stop()), show_error=windows.append, log=logs.append)
    def _stop():
        if len(sleeps) == 2: raise KeyboardInterrupt
    assert sup.run() == 0 and len(sleeps) == 2 and len(windows) == 1 and 'could not be started' in windows[0] and any('python not found' in l for l in logs)

def test_ctrl_c_stops_the_child_and_the_supervisor_with_code_0():
    clock = Clock(); child = Child(0, interrupt=True)
    sup = S.Supervisor(lambda: child, clock=clock); assert sup.run() == 0 and child.terminated

def test_read_marker_takes_the_newest_file_and_reports_a_damaged_one(tmp_path):
    assert S.read_marker(None) is None and S.read_marker(tmp_path) is None
    last = tmp_path / 'crash_marker.last.json'; last.write_text(json.dumps({'kind': 'stall', 'stalled': 'serial'})); os.utime(last, (1, 1))
    assert S.read_marker(tmp_path)['stalled'] == 'serial'
    cur = tmp_path / 'crash_marker.json'; cur.write_text(json.dumps({'kind': 'stall', 'stalled': 'tick'}))
    assert S.read_marker(tmp_path)['stalled'] == 'tick'
    cur.write_text('{not json'); assert S.read_marker(tmp_path) == {'kind': 'unreadable'}

def test_a_real_child_that_exits_1_is_respawned_within_500_ms(tmp_path):
    """The design test: respawn within 500 ms on a non-zero exit, with a fake child that is a real short-lived process (first run exits 1, second exits 0)."""
    flag = tmp_path / 'ran_once'; stamps = tmp_path / 'stamps.txt'
    code = "import sys,time,pathlib; f=pathlib.Path(%r); s=pathlib.Path(%r); s.open('a').write('start %%f\\n' %% time.time()); sys.exit(0 if f.exists() else (f.write_text('x'), s.open('a').write('exit %%f\\n' %% time.time()), 1)[2])" % (str(flag), str(stamps))
    def spawn():
        return S.ProcessChild(subprocess.Popen([sys.executable, '-c', code]))
    sup = S.Supervisor(spawn, log=lambda m: None)
    assert sup.run() == 0
    lines = stamps.read_text().split('\n'); starts = [float(l.split()[1]) for l in lines if l.startswith('start')]; first_exit = float([l for l in lines if l.startswith('exit')][0].split()[1])
    assert len(starts) == 2 and starts[1] - first_exit < 0.5 + 0.3                   # 0.3 s slack for the Python start-up of the second child itself
    assert sup.last_gap_ms <= S.RESPAWN_BUDGET_MS                                    # the supervisor's own gap from exit to spawn

def test_make_spawn_runs_the_host_module_with_the_host_folder_on_the_path_and_ppe_home_set(tmp_path, monkeypatch):
    seen = {}
    class P:
        def __init__(self, args, cwd=None, env=None): seen.update(args=args, cwd=cwd, env=env)
    monkeypatch.setattr(S.subprocess, 'Popen', P)
    S.make_spawn('py', tmp_path, '/data', ['--mode', 'LIVE'])()
    assert seen['args'] == ['py', '-m', 'ppe_host.main', '--mode', 'LIVE'] and seen['cwd'] == str(tmp_path)
    assert seen['env']['PYTHONPATH'].split(os.pathsep)[0] == str(tmp_path / 'host') and seen['env']['PPE_HOME'] == '/data'

def test_the_script_imports_only_the_standard_library_at_module_level():
    import ast
    tree = ast.parse(SCRIPT.read_text('utf8')); mods = set()
    for n in tree.body:
        if isinstance(n, ast.Import): mods |= {a.name.split('.')[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.module: mods.add(n.module.split('.')[0])
    assert mods <= {'argparse', 'json', 'os', 'subprocess', 'sys', 'threading', 'time', 'pathlib'}, mods     # ppe_host, winsound and ctypes are imported inside functions
