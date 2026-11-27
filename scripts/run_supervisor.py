"""scripts/run_supervisor.py (P24-5a, ADR 0046): the user-session supervisor of design 1 (Windows packaging) and 14.5 (thread map, item 1).
It starts `python -m ppe_host.main` and starts it again within 500 ms whenever the exit code is not 0. Exit code 0 (clean shutdown, or another host already runs)
never respawns. Crash-loop guard (Rev 3.25): after 5 non-zero exits within 60 s it waits 5 s between respawns, shows a local error window with the last crash
marker, plays the local laptop alarm and keeps trying. Exit code 2 (configuration or database failure) counts like any other non-zero exit.
Run from the release or repository folder: python scripts/run_supervisor.py [--home PPE_HOME] [--mode LIVE|SIMULATOR|REPLAY]
Only the standard library is used here, so the supervisor starts even when the host package is broken (the host package is read only to find the log folder)."""
import argparse, json, os, subprocess, sys, threading, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]               # the release folder or the repository root; the host package is in ROOT/host
RESPAWN_BUDGET_MS = 500                                  # design 1: respawn within 500 ms
GUARD_EXITS, GUARD_WINDOW_S, GUARD_WAIT_S = 5, 60, 5     # design 1 (Rev 3.25): 5 non-zero exits within 60 s, then 5 s between respawns
SPAWN_FAILED = 127                                       # counted as an exit code when the host process cannot even be started
MARKER_NAMES = ('crash_marker.json', 'crash_marker.last.json')   # io/os_watchdog.py: the marker, and where the next start moves it

def read_marker(log_dir):
    """The newest crash marker as a dict, or None. A damaged file is reported as {'kind': 'unreadable'}."""
    if log_dir is None: return None
    found = []
    for name in MARKER_NAMES:
        p = Path(log_dir) / name
        try: found.append((p.stat().st_mtime, p))
        except OSError: continue
    for _, p in sorted(found, key=lambda t: t[0], reverse=True):
        try:
            d = json.loads(p.read_text('utf8'))
            return d if isinstance(d, dict) else {'kind': 'unreadable'}
        except (OSError, ValueError): return {'kind': 'unreadable'}
    return None

def describe(rc, n_exits, marker):
    """The text of the local error window."""
    why = {1: 'the host crashed or was stopped by its watchdog', 2: 'configuration or database failure; the host printed the reason before it exited', SPAWN_FAILED: 'the host process could not be started'}.get(rc, 'the host exited')
    lines = ['The PPE host has stopped %d times in the last %d s. The supervisor keeps trying every %d s.' % (n_exits, GUARD_WINDOW_S, GUARD_WAIT_S), 'Last exit code: %s (%s).' % (rc, why)]
    if marker is None: lines.append('Crash marker: none found.')
    else: lines.append('Last crash marker: ' + ', '.join('%s=%s' % (k, marker[k]) for k in ('kind', 'ts', 'stalled', 'age_ms', 'limit_ms') if k in marker) if marker.get('kind') != 'unreadable' else 'Last crash marker: file is damaged.')
    lines.append('Laptop alarm sounds; the base panel shows LAPTOP OFFLINE after 5 s without a host tick.')
    return '\n'.join(lines)

class Supervisor:
    """spawn() returns a child with wait() -> exit code and terminate(). Everything that touches the machine is injected, so a test needs no process, clock or sound card."""
    def __init__(self, spawn, clock=time.monotonic, sleep=time.sleep, marker=lambda: None, show_error=lambda text: None, alarm=lambda: None, log=lambda msg: None):
        self.spawn, self.clock, self.sleep, self.marker, self.show_error, self.alarm, self.log = spawn, clock, sleep, marker, show_error, alarm, log
        self.exits = []                 # clock() of each non-zero exit inside the guard window
        self.guarded = False
        self.last_gap_ms = None         # exit to next spawn, in ms (design 1: at most 500 on an ordinary respawn)

    def _note_exit(self, rc):
        now = self.clock(); self.exits = [t for t in self.exits if now - t < GUARD_WINDOW_S] + [now]
        return now, len(self.exits) >= GUARD_EXITS

    def run(self):
        """Returns 0 when the host exits with 0 (never respawned) or the supervisor is stopped with Ctrl+C; otherwise it never returns."""
        child = None; exited_at = None
        try:
            while True:
                try: child = self.spawn()
                except OSError as e:
                    self.log('cannot start the host: %s' % e); child = None
                if exited_at is not None: self.last_gap_ms = round((self.clock() - exited_at) * 1000)
                rc = SPAWN_FAILED if child is None else child.wait()
                if rc == 0: self.log('host exited with code 0: not restarting'); return 0
                now, guard = self._note_exit(rc); exited_at = now
                self.log('host exited with code %s (%d non-zero exit(s) in the last %d s)' % (rc, len(self.exits), GUARD_WINDOW_S))
                if guard:
                    if not self.guarded: self.show_error(describe(rc, len(self.exits), self.marker()))      # once per crash loop; the window is not a modal stop
                    self.guarded = True; self.alarm(); self.sleep(GUARD_WAIT_S)
                else: self.guarded = False                                                                    # the crash loop is over once fewer than 5 exits are left in the window
        except KeyboardInterrupt:
            if child is not None:
                try: child.terminate()
                except OSError: pass
            self.log('stopped by the operator'); return 0

class ProcessChild:
    def __init__(self, popen): self.p = popen
    def wait(self): return self.p.wait()
    def terminate(self): self.p.terminate()

def make_spawn(python, root, home, extra):
    def spawn():
        env = dict(os.environ); env['PYTHONPATH'] = str(Path(root) / 'host') + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
        if home: env['PPE_HOME'] = str(home)
        return ProcessChild(subprocess.Popen([python, '-m', 'ppe_host.main'] + list(extra), cwd=str(root), env=env))
    return spawn

def windows_error_window(text):
    """A message box in its own thread, so the supervisor keeps respawning while it is open. Elsewhere (development) the text goes to standard error."""
    if sys.platform != 'win32': print(text, file=sys.stderr); return
    import ctypes
    threading.Thread(target=lambda: ctypes.windll.user32.MessageBoxW(0, text, 'PPE host is not staying up', 0x10 | 0x40000), daemon=True).start()   # MB_ICONERROR | MB_TOPMOST

def local_alarm():
    """The 1 kHz 400 ms pulse of the fallback alarm (design 3.12); no WAV is needed, so a broken sounds folder cannot silence the supervisor."""
    try: import winsound; winsound.Beep(1000, 400)
    except (ImportError, RuntimeError): sys.stderr.write('\a')

def log_dir_of(home):
    try:
        sys.path.insert(0, str(ROOT / 'host'))
        from ppe_host.settings import load_settings
        return load_settings(home).path('log_dir')
    except Exception: return None                      # a broken settings file must not stop the supervisor: the host will report it itself (exit 2)

def main(argv=None):
    ap = argparse.ArgumentParser(prog='run_supervisor.py', description='Keeps the PPE host running (design 1).')
    ap.add_argument('--home', help='PPE_HOME (default: the PPE_HOME variable, else this folder)'); ap.add_argument('--mode', choices=('LIVE', 'SIMULATOR', 'REPLAY'), help='passed to the host')
    ap.add_argument('--python', default=sys.executable, help='the Python that runs the host (default: this one)')
    a = ap.parse_args(argv)
    extra = (['--mode', a.mode] if a.mode else []) + (['--home', a.home] if a.home else [])
    log_dir = log_dir_of(a.home)
    logfile = Path(log_dir) / 'supervisor.log' if log_dir else None
    def log(msg):
        line = time.strftime('%Y-%m-%d %H:%M:%S') + ' supervisor: ' + msg; print(line, flush=True)
        if logfile is not None:
            try: logfile.parent.mkdir(parents=True, exist_ok=True); logfile.open('a', encoding='utf8').write(line + '\n')
            except OSError: pass
    sup = Supervisor(make_spawn(a.python, ROOT, a.home, extra), marker=lambda: read_marker(log_dir), show_error=windows_error_window, alarm=local_alarm, log=log)
    return sup.run()

if __name__ == '__main__': sys.exit(main())
