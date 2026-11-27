"""services/doctor.py (P24-5b, ADR 0047): `python -m ppe_host.cli doctor`, the pre-shift check of design 1 (Release bundle and doctor, Rev 3.43).
One line per check, PASS, FAIL or SKIP: release version, settings, base serial device, sound files, audio device, free disk, port, prebuilt dashboard, secrets.json, database quick_check, lockfile.
It changes nothing: the database is opened read-only, the serial port is only looked up in the list of the system (never opened, so no DTR or RTS pulse reaches the ESP32), the port is only connected to, and the only
sound is the 100 ms silent probe WAV. Everything that touches the machine is a parameter of run_checks(), so the tests need no serial device, sound card or open port."""
import json, socket, sqlite3, sys
from pathlib import Path
from ..settings import REPO_ROOT, SettingsError, constants_hash, load_settings
from ..io.audio_watchdog import SOUNDS_DIR, check_sounds
from ..io.health import disk_free_gb

PASS, FAIL, SKIP = 'PASS', 'FAIL', 'SKIP'

def default_comports():
    from serial.tools import list_ports                  # pyserial is a runtime dependency; ImportError is reported as a FAIL
    return [p.device for p in list_ports.comports()]

def default_listening(host, port):
    """True when something accepts a connection on host:port. A connect, not a bind: it never takes the port and means the same on Windows and Linux."""
    try:
        with socket.create_connection((host, port), timeout=0.5): return True
    except OSError: return False

def default_backend():
    from ..io.audio_watchdog import WinsoundBackend
    return WinsoundBackend()

def _ro(db):
    """A connection that changes nothing. A read-only connection to a WAL database would still create the -wal and -shm files, so while neither exists (no host has the database open) the file is opened immutable:
    no locks and no side files. While one exists the host is running or stopped without closing, and the normal read-only connection reads through the WAL and creates nothing new."""
    p = Path(db).resolve(); open_elsewhere = any(Path(str(p) + s).exists() for s in ('-wal', '-shm'))
    return sqlite3.connect(p.as_uri() + ('?mode=ro' if open_elsewhere else '?mode=ro&immutable=1'), uri=True)

def check_release(root):
    for p in (Path(root) / 'build_manifest.json', Path(root) / 'dist' / 'build_manifest.json'):
        if p.exists(): break
    else: return FAIL, 'release version', 'build_manifest.json not found (a release folder has it; in the repository run just build)'
    try: m = json.loads(p.read_text('utf8'))
    except (OSError, ValueError): return FAIL, 'release version', '%s is not readable JSON' % p.name
    if not isinstance(m, dict) or not m.get('rev_tag'): return FAIL, 'release version', '%s has no rev_tag' % p.name
    try: here = constants_hash(Path(root) / 'shared' / 'constants.json')
    except SettingsError as e: return FAIL, 'release version', str(e)
    if m.get('constants_sha256') != here: return FAIL, 'release version', '%s: constants.json does not match this folder (built from another version)' % m['rev_tag']
    return PASS, 'release version', '%s, commit %s' % (m['rev_tag'], str(m.get('git_commit') or 'unknown')[:12])

def check_serial(s, comports):
    port = s['serial_port']
    if port == 'auto': return FAIL, 'base serial device', 'serial_port is "auto", which is not built yet: set the COM port in config/settings.local.json'
    try: ports = list(comports())
    except ImportError: return FAIL, 'base serial device', 'pyserial is not installed'
    except Exception as e: return FAIL, 'base serial device', 'cannot list serial ports: %s' % type(e).__name__
    if any(p.lower() == port.lower() for p in ports): return PASS, 'base serial device', '%s is present' % port
    return FAIL, 'base serial device', '%s not found (present: %s)' % (port, ', '.join(ports) or 'none')

def check_sound_files(sounds_dir):
    bad = check_sounds(sounds_dir)
    return (FAIL, 'sound files', '; '.join('%s %s' % b for b in bad[:4]) + (' ...' if len(bad) > 4 else '')) if bad else (PASS, 'sound files', 'every file matches manifest.json')

def check_audio_device(sounds_dir, backend, platform):
    if platform != 'win32': return SKIP, 'audio device', 'the host alarm plays through winsound, which is Windows only'
    try: backend.play(Path(sounds_dir) / 'probe.wav', wait=True)
    except RuntimeError as e: return FAIL, 'audio device', 'the silent probe did not play: %s' % e
    except Exception as e: return FAIL, 'audio device', 'the silent probe failed: %s' % type(e).__name__
    return PASS, 'audio device', 'the 100 ms silent probe played'

def check_disk(s):
    p = s.path('db_path').parent
    while not p.exists() and p != p.parent: p = p.parent
    free, need = disk_free_gb(p), s['host_disk_min_gb']
    if free is None: return FAIL, 'free disk', 'cannot read the free space of %s' % p
    return (PASS if free >= need else FAIL), 'free disk', '%.1f GB free on %s (minimum %s GB)' % (free, p, need)

def check_port(s, host_alive, listening):
    host, port = s['bind_host'], s['bind_port']; busy = listening(host, port)
    if host_alive: return (PASS, 'port %d' % port, 'held by the running host') if busy else (FAIL, 'port %d' % port, 'the lockfile says the host runs, but nothing listens on %s:%d' % (host, port))
    return (FAIL, 'port %d' % port, 'in use by another program (the host is not running)') if busy else (PASS, 'port %d' % port, 'free')

def check_dashboard(root):
    p = Path(root) / 'dashboard' / 'dist' / 'index.html'
    return (PASS, 'prebuilt dashboard', str(p)) if p.is_file() else (FAIL, 'prebuilt dashboard', '%s not found (run just build, then package)' % p)

def operators_exist(db):
    try:
        c = _ro(db)
        try: return c.execute('SELECT COUNT(*) FROM operators').fetchone()[0] > 0
        finally: c.close()
    except sqlite3.Error: return False

def check_secrets(s, db):
    if not s.secrets_path.exists(): return FAIL, 'secrets.json', '%s is missing: the host never runs without the CMAC key' % s.secrets_path
    try: s.cmac_key()
    except SettingsError as e: return FAIL, 'secrets.json', str(e)
    try: s.server_salt()
    except SettingsError as e:
        if operators_exist(db): return FAIL, 'secrets.json', 'operators exist but server_salt is missing or invalid (the host exits with code 2)'
        return PASS, 'secrets.json', 'cmac_key is valid; no server_salt yet (create-operator makes it)'
    return PASS, 'secrets.json', 'cmac_key and server_salt are valid'

def check_database(db):
    if not Path(db).exists(): return PASS, 'database quick_check', 'no database yet (the first start creates it)'
    try:
        c = _ro(db)
        try: res = [r[0] for r in c.execute('PRAGMA quick_check')]
        finally: c.close()
    except sqlite3.Error as e: return FAIL, 'database quick_check', '%s: %s' % (type(e).__name__, e)
    return (PASS, 'database quick_check', 'ok') if res == ['ok'] else (FAIL, 'database quick_check', '; '.join(res[:3]))

def check_lockfile(lock, read, alive):
    h = read(lock)
    if not Path(lock).exists(): return PASS, 'lockfile', 'none (the host is not running)'
    if h is not None and alive(lock): return PASS, 'lockfile', 'the host is running (PID %d)' % h[0]
    return PASS, 'lockfile', 'stale (%s): the next start replaces it' % ('PID %d is gone' % h[0] if h else 'unreadable')

def run_checks(home=None, db=None, root=REPO_ROOT, sounds_dir=SOUNDS_DIR, comports=default_comports, listening=default_listening, backend=None, platform=None):
    """[(status, name, detail)] in a fixed order. A settings problem is one FAIL and the checks that need settings are SKIP."""
    from ..main import LOCK_NAME, Lockfile                # imported here: main imports cli, and cli imports this module when the command runs
    rows = [check_release(root)]
    try: s = load_settings(home)
    except SettingsError as e:
        rows.append((FAIL, 'settings', str(e)))
        rows += [(SKIP, n, 'needs readable settings') for n in ('base serial device', 'free disk', 'port', 'secrets.json', 'database quick_check', 'lockfile')]
        rows.insert(2, check_sound_files(sounds_dir)); rows.insert(3, check_audio_device(sounds_dir, backend or default_backend(), platform or sys.platform)); rows.append(check_dashboard(root)); return rows
    dbp = Path(db) if db else s.path('db_path'); lock = s.home / LOCK_NAME; alive = Lockfile.holder_alive(lock)
    rows += [(PASS, 'settings', 'loaded from %s' % s.home), check_serial(s, comports), check_sound_files(sounds_dir), check_audio_device(sounds_dir, backend or default_backend(), platform or sys.platform), check_disk(s),
             check_port(s, alive, listening), check_dashboard(root), check_secrets(s, dbp), check_database(dbp), check_lockfile(lock, Lockfile.read, Lockfile.holder_alive)]
    return rows

def format_rows(rows):
    lines = ['doctor: %-4s %s: %s' % r for r in rows]
    n = {k: sum(1 for r in rows if r[0] == k) for k in (PASS, FAIL, SKIP)}
    lines.append('doctor: %d passed, %d failed, %d skipped' % (n[PASS], n[FAIL], n[SKIP]))
    return lines, n[FAIL] == 0
