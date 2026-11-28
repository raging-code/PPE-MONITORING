"""P24-5b: cli doctor (ADR 0047): the pre-shift check of design 1 (Release bundle and doctor). One PASS, FAIL or SKIP line per check, exit 1 on any FAIL, and it changes nothing.
The serial list, the port, the sound card and the platform are fakes, so no device is needed."""
import hashlib, json, shutil, sqlite3
from pathlib import Path
from fakeaudio import FakeBackend
from ppe_host import cli
from ppe_host.io.audio_watchdog import SOUNDS_DIR
from ppe_host.main import LOCK_NAME, Lockfile
from ppe_host.io.db_writer import run_migrations
from ppe_host.main import MIGRATIONS_DIR
from ppe_host.services import abi_check, doctor as D
from ppe_host.settings import CONSTANTS_PATH, constants_hash

CMAC, SALT = 'ab' * 16, 'cd' * 32

def make(tmp_path, secrets=True, salt=True, dashboard=True, manifest=True):
    """A home folder with secrets and a release root with a matching manifest, the constants and the dashboard."""
    home, root = tmp_path / 'home', tmp_path / 'root'
    (home / 'config').mkdir(parents=True); (root / 'shared').mkdir(parents=True)
    if secrets: (home / 'config' / 'secrets.json').write_text(json.dumps({'cmac_key': CMAC, **({'server_salt': SALT} if salt else {})}))
    shutil.copy(CONSTANTS_PATH, root / 'shared' / 'constants.json'); shutil.copy(abi_check.ABI_JSON, root / 'shared' / 'abi.json')
    if manifest: (root / 'build_manifest.json').write_text(json.dumps({'rev_tag': 'Rev 3.45', 'git_commit': 'abcdef1234567890', 'constants_sha256': constants_hash(root / 'shared' / 'constants.json')}))
    if dashboard: (root / 'dashboard' / 'dist').mkdir(parents=True); (root / 'dashboard' / 'dist' / 'index.html').write_text('<html></html>')
    return home, root

def run(tmp_path, home, root, **kw):
    args = dict(comports=lambda: ['COM3', 'COM4'], listening=lambda h, p: False, backend=FakeBackend(), platform='win32'); args.update(kw)
    return D.run_checks(str(home), None, root, **args)

def by(rows, name): return [r for r in rows if r[1] == name][0]
def status(rows, name): return by(rows, name)[0]

def add_operators(db, *ops):
    """ops = (display_name, has_pin) or (display_name, has_pin, active). Real schema (0003 has the PIN columns)."""
    c = sqlite3.connect(str(db))
    for n, o in enumerate(ops, 1): c.execute('INSERT INTO operators(operator_id, display_name, token_hash, active, created_ts, token_issued_ts, pin_hash, pin_salt) VALUES (?, ?, ?, ?, 1, 1, ?, ?)', (n, o[0], 'x', o[2] if len(o) > 2 else 1, 'h' if o[1] else None, 's' if o[1] else None))
    c.commit(); c.close()

def test_a_good_machine_passes_every_check_and_exits_0(tmp_path):
    home, root = make(tmp_path); db = abi_db(home, [[]]); add_operators(db, ('Ana', True)); rows = run(tmp_path, home, root)                    # one earlier shift and one operator with a PIN; without a session the base ABI row is a SKIP
    assert [r[0] for r in rows] == ['PASS'] * 14 and [r[1] for r in rows] == ['release version', 'host ABI', 'settings', 'base serial device', 'sound files', 'audio device', 'free disk', 'port 8420', 'prebuilt dashboard', 'secrets.json', 'database quick_check', 'operator PINs', 'base ABI', 'lockfile']
    lines, ok = D.format_rows(rows); assert ok and lines[-1] == 'doctor: 14 passed, 0 failed, 0 skipped'

def test_the_release_check_needs_a_manifest_with_a_rev_tag_and_the_constants_of_this_folder(tmp_path):
    home, root = make(tmp_path, manifest=False); assert status(run(tmp_path, home, root), 'release version') == 'FAIL'
    (root / 'build_manifest.json').write_text(json.dumps({'rev_tag': None, 'constants_sha256': 'x'})); assert 'no rev_tag' in by(run(tmp_path, home, root), 'release version')[2]
    (root / 'build_manifest.json').write_text(json.dumps({'rev_tag': 'Rev 3.45', 'constants_sha256': '0' * 64})); assert 'does not match' in by(run(tmp_path, home, root), 'release version')[2]
    (root / 'build_manifest.json').write_text('{broken'); assert 'not readable' in by(run(tmp_path, home, root), 'release version')[2]

def test_the_manifest_is_also_found_in_dist_for_a_repository_checkout(tmp_path):
    home, root = make(tmp_path); (root / 'dist').mkdir(); shutil.move(str(root / 'build_manifest.json'), str(root / 'dist' / 'build_manifest.json'))
    r = by(run(tmp_path, home, root), 'release version'); assert r[0] == 'PASS' and 'Rev 3.45' in r[2] and 'abcdef123456' in r[2]

def test_the_serial_check_looks_the_port_up_and_never_opens_it(tmp_path):
    home, root = make(tmp_path)
    assert status(run(tmp_path, home, root, comports=lambda: ['com4']), 'base serial device') == 'PASS'                     # the name is compared without case, as Windows does
    r = by(run(tmp_path, home, root, comports=lambda: ['COM7']), 'base serial device'); assert r[0] == 'FAIL' and 'COM4 not found' in r[2] and 'COM7' in r[2]
    assert 'none' in by(run(tmp_path, home, root, comports=lambda: []), 'base serial device')[2]
    def no_pyserial(): raise ImportError('serial')
    assert 'pyserial is not installed' in by(run(tmp_path, home, root, comports=no_pyserial), 'base serial device')[2]

def test_serial_port_auto_is_a_fail_with_the_way_out(tmp_path):
    home, root = make(tmp_path); (home / 'config' / 'settings.local.json').write_text(json.dumps({'serial_port': 'auto'}))
    r = by(run(tmp_path, home, root), 'base serial device'); assert r[0] == 'FAIL' and 'settings.local.json' in r[2]

def test_an_altered_sound_file_is_a_fail_that_names_the_file(tmp_path):
    home, root = make(tmp_path); snd = tmp_path / 'sounds'; shutil.copytree(SOUNDS_DIR, snd); (snd / 'siren.wav').write_bytes(b'not a wav')
    r = by(run(tmp_path, home, root, sounds_dir=snd), 'sound files'); assert r[0] == 'FAIL' and 'siren.wav altered' in r[2]
    (snd / 'siren.wav').unlink(); assert 'siren.wav missing' in by(run(tmp_path, home, root, sounds_dir=snd), 'sound files')[2]

def test_the_audio_device_plays_the_silent_probe_on_windows(tmp_path):
    home, root = make(tmp_path); b = FakeBackend(); rows = run(tmp_path, home, root, backend=b)
    assert status(rows, 'audio device') == 'PASS' and b.played() == ['probe.wav'] and b.calls[0][3] is True      # synchronous

def test_a_probe_that_fails_is_a_fail_and_off_windows_the_check_is_skipped_without_playing(tmp_path):
    home, root = make(tmp_path); r = by(run(tmp_path, home, root, backend=FakeBackend(fail=RuntimeError('no device'))), 'audio device'); assert r[0] == 'FAIL' and 'no device' in r[2]
    b = FakeBackend(); r = by(run(tmp_path, home, root, backend=b, platform='linux'), 'audio device'); assert r[0] == 'SKIP' and b.calls == []
    lines, ok = D.format_rows([r]); assert ok                                                                      # a SKIP never fails the command

def test_too_little_free_disk_is_a_fail(tmp_path):
    home, root = make(tmp_path); (home / 'config' / 'settings.local.json').write_text(json.dumps({'host_disk_min_gb': 1e12}))
    r = by(run(tmp_path, home, root), 'free disk'); assert r[0] == 'FAIL' and 'minimum' in r[2]

def test_the_port_is_free_or_held_by_the_running_host_and_nothing_else(tmp_path):
    home, root = make(tmp_path)
    assert status(run(tmp_path, home, root), 'port 8420') == 'PASS'
    r = by(run(tmp_path, home, root, listening=lambda h, p: True), 'port 8420'); assert r[0] == 'FAIL' and 'another program' in r[2]
    Lockfile.acquire(home / LOCK_NAME)                                                                             # this very process holds the lock: the host is "running"
    assert status(run(tmp_path, home, root, listening=lambda h, p: True), 'port 8420') == 'PASS'
    r = by(run(tmp_path, home, root, listening=lambda h, p: False), 'port 8420'); assert r[0] == 'FAIL' and 'nothing listens' in r[2]

def test_the_real_listening_probe_sees_an_open_port_and_a_closed_one():
    import socket
    s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(1); port = s.getsockname()[1]
    try: assert D.default_listening('127.0.0.1', port) is True
    finally: s.close()
    assert D.default_listening('127.0.0.1', port) is False

def test_a_missing_prebuilt_dashboard_is_a_fail(tmp_path):
    home, root = make(tmp_path, dashboard=False); r = by(run(tmp_path, home, root), 'prebuilt dashboard'); assert r[0] == 'FAIL' and 'index.html' in r[2]

def test_secrets_missing_or_bad_is_a_fail_and_the_key_is_never_printed(tmp_path):
    home, root = make(tmp_path, secrets=False); assert status(run(tmp_path, home, root), 'secrets.json') == 'FAIL'
    (home / 'config' / 'secrets.json').write_text(json.dumps({'cmac_key': 'ab' * 15})); r = by(run(tmp_path, home, root), 'secrets.json'); assert r[0] == 'FAIL' and 'cmac_key' in r[2] and 'ab' * 15 not in r[2]
    home, root = make(tmp_path / 'ok'); out = '\n'.join(D.format_rows(run(tmp_path, home, root))[0]); assert CMAC not in out and SALT not in out

def test_a_missing_server_salt_is_a_fail_only_when_operators_exist(tmp_path):
    home, root = make(tmp_path, salt=False); r = by(run(tmp_path, home, root), 'secrets.json'); assert r[0] == 'PASS' and 'no server_salt yet' in r[2]
    db = home / 'data' / 'ppe.db'; db.parent.mkdir(); c = sqlite3.connect(str(db)); c.execute('CREATE TABLE operators(operator_id INTEGER)'); c.execute('INSERT INTO operators VALUES (1)'); c.commit(); c.close()
    r = by(run(tmp_path, home, root), 'secrets.json'); assert r[0] == 'FAIL' and 'server_salt' in r[2]

def test_the_database_check_passes_a_good_file_and_fails_a_damaged_one(tmp_path):
    home, root = make(tmp_path); db = home / 'data' / 'ppe.db'; db.parent.mkdir(); c = sqlite3.connect(str(db)); c.execute('CREATE TABLE t(x)'); c.commit(); c.close()
    assert by(run(tmp_path, home, root), 'database quick_check')[2] == 'ok'
    db.write_bytes(b'this is not a database file' * 200); r = by(run(tmp_path, home, root), 'database quick_check'); assert r[0] == 'FAIL'

def tree(folder): return {str(p.relative_to(folder)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(Path(folder).rglob('*')) if p.is_file()}

def test_doctor_changes_nothing_not_even_on_a_wal_database(tmp_path):
    home, root = make(tmp_path); db = home / 'data' / 'ppe.db'; db.parent.mkdir(); c = sqlite3.connect(str(db)); c.execute('PRAGMA journal_mode=WAL'); c.execute('CREATE TABLE t(x)'); c.execute('INSERT INTO t VALUES (1)'); c.commit(); c.close()
    before = tree(tmp_path); rows = run(tmp_path, home, root); after = tree(tmp_path)
    assert status(rows, 'database quick_check') == 'PASS' and before == after

def test_a_database_that_a_running_host_holds_open_is_read_without_new_files_or_a_changed_main_file(tmp_path):
    home, root = make(tmp_path); db = home / 'data' / 'ppe.db'; db.parent.mkdir()
    host = sqlite3.connect(str(db)); host.execute('PRAGMA journal_mode=WAL'); host.execute('CREATE TABLE t(x)'); host.execute('INSERT INTO t VALUES (1)'); host.commit()      # stays open, as the host's writer does
    try:
        names = sorted(p.name for p in db.parent.iterdir()); main_bytes = db.read_bytes(); assert 'ppe.db-wal' in names
        assert status(run(tmp_path, home, root), 'database quick_check') == 'PASS' and sorted(p.name for p in db.parent.iterdir()) == names and db.read_bytes() == main_bytes
    finally: host.close()

def test_the_lockfile_line_says_none_running_or_stale(tmp_path):
    home, root = make(tmp_path); assert 'none' in by(run(tmp_path, home, root), 'lockfile')[2]
    (home / LOCK_NAME).write_text(json.dumps({'pid': 2 ** 30, 'start': 'x'})); r = by(run(tmp_path, home, root), 'lockfile'); assert r[0] == 'PASS' and 'stale' in r[2] and 'replaces' in r[2]
    (home / LOCK_NAME).write_text('garbage'); assert 'unreadable' in by(run(tmp_path, home, root), 'lockfile')[2]
    (home / LOCK_NAME).unlink(); Lockfile.acquire(home / LOCK_NAME); assert 'is running' in by(run(tmp_path, home, root), 'lockfile')[2]

def test_unreadable_settings_are_one_fail_and_the_checks_that_need_them_are_skipped(tmp_path):
    home, root = make(tmp_path); (home / 'config' / 'settings.local.json').write_text(json.dumps({'no_such_key': 1}))
    rows = run(tmp_path, home, root); assert status(rows, 'settings') == 'FAIL' and 'no_such_key' in by(rows, 'settings')[2]
    assert [r[0] for r in rows if r[1] in ('base serial device', 'free disk', 'port', 'secrets.json', 'database quick_check', 'base ABI', 'lockfile')] == ['SKIP'] * 7
    assert status(rows, 'release version') == 'PASS' and status(rows, 'host ABI') == 'PASS' and status(rows, 'sound files') == 'PASS' and status(rows, 'prebuilt dashboard') == 'PASS'

def test_the_host_abi_row_compares_abi_py_with_the_abi_json_of_this_folder(tmp_path):
    home, root = make(tmp_path); r = by(run(tmp_path, home, root), 'host ABI'); assert r[0] == 'PASS' and 'matches' in r[2]
    p = root / 'shared' / 'abi.json'; a = json.loads(p.read_text('utf8')); a['beacon']['abi_ver'] += 1; p.write_text(json.dumps(a))              # a folder mixed from two builds
    r = by(run(tmp_path, home, root), 'host ABI'); assert r[0] == 'FAIL' and 'BEACON_ABI_VER' in r[2] and 'exit 2' in r[2]
    p.write_text('{broken'); r = by(run(tmp_path, home, root), 'host ABI'); assert r[0] == 'FAIL' and 'cannot read abi.json' in r[2]
    p.unlink(); assert status(run(tmp_path, home, root), 'host ABI') == 'FAIL'
    p.write_text('{}'); assert 'layout' in by(run(tmp_path, home, root), 'host ABI')[2]

def abi_db(home, sessions):
    """The real schema (0001 and 0002). sessions = [[(kind, detail), ...], ...], one list of system_events rows per session, oldest first."""
    db = home / 'data' / 'ppe.db'; db.parent.mkdir(parents=True, exist_ok=True); c = sqlite3.connect(str(db)); run_migrations(c, MIGRATIONS_DIR, 1)
    for n, rows in enumerate(sessions, 1):
        c.execute("INSERT INTO sessions(session_id, started_ts, ended_ts, end_kind, mode, host_build, constants_hash, settings_hash) VALUES (?, ?, ?, 'ENDED', 'LIVE', 'b', 'c', 's')", (n, n, n + 1))
        for seq, (kind, detail) in enumerate(rows, 1): c.execute('INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (?, ?, ?, ?, ?)', (n, seq, seq, kind, detail))
    c.commit(); c.close(); return db

MISMATCH = ('ABI_MISMATCH', 'base reports abi 2, host expects 3')

def test_the_base_abi_row_is_skipped_without_a_database_or_a_session(tmp_path):
    home, root = make(tmp_path); r = by(run(tmp_path, home, root), 'base ABI'); assert r[0] == 'SKIP' and 'no database' in r[2]
    abi_db(home, []); r = by(run(tmp_path, home, root), 'base ABI'); assert r[0] == 'SKIP' and 'no session' in r[2]

def test_the_base_abi_row_fails_on_a_recorded_mismatch_and_names_both_numbers(tmp_path):
    home, root = make(tmp_path); abi_db(home, [[('FW_REPORTED', 'fw-1'), MISMATCH]])
    r = by(run(tmp_path, home, root), 'base ABI'); assert r[0] == 'FAIL' and 'session 1' in r[2] and 'abi 2' in r[2] and 'host expects 3' in r[2] and 'firmware' in r[2]
    lines, ok = D.format_rows(run(tmp_path, home, root)); assert not ok

def test_the_base_abi_row_passes_when_nothing_was_recorded_or_the_mismatch_was_cleared(tmp_path):
    home, root = make(tmp_path); abi_db(home, [[('FW_REPORTED', 'fw-1')]])
    r = by(run(tmp_path, home, root), 'base ABI'); assert r[0] == 'PASS' and 'no ABI mismatch recorded' in r[2]
    home, root = make(tmp_path / 'b'); abi_db(home, [[MISMATCH, ('ABI_OK', 'base reports abi 3')]]); assert status(run(tmp_path, home, root), 'base ABI') == 'PASS'     # the newest ABI row decides
    home, root = make(tmp_path / 'c'); abi_db(home, [[MISMATCH], []]); r = by(run(tmp_path, home, root), 'base ABI'); assert r[0] == 'PASS' and 'session 2' in r[2]      # only the newest session counts

def test_the_base_abi_row_reads_without_changing_anything_and_an_unreadable_file_is_a_skip(tmp_path):
    home, root = make(tmp_path); db = abi_db(home, [[MISMATCH]]); before = tree(tmp_path); rows = run(tmp_path, home, root); assert status(rows, 'base ABI') == 'FAIL' and tree(tmp_path) == before
    db.write_bytes(b'this is not a database file' * 200); r = by(run(tmp_path, home, root), 'base ABI'); assert r[0] == 'SKIP' and 'cannot read' in r[2] and status(run(tmp_path, home, root), 'database quick_check') == 'FAIL'
    home, root = make(tmp_path / 'b'); db = home / 'data' / 'ppe.db'; db.parent.mkdir(); c = sqlite3.connect(str(db)); c.execute('CREATE TABLE t(x)'); c.commit(); c.close()      # a database without the tables
    assert status(run(tmp_path, home, root), 'base ABI') == 'SKIP'

def test_the_command_is_registered_with_home_and_db_and_its_exit_code_follows_the_checks(tmp_path, monkeypatch, capsys):
    assert 'doctor' in cli.COMMANDS and {f for f, _ in cli.COMMANDS['doctor'][1]} == {'--home', '--db'}
    monkeypatch.setattr(D, 'run_checks', lambda home, db: [('PASS', 'a', 'fine'), ('SKIP', 'b', 'not here')])
    assert cli.main(['doctor']) == 0; out = capsys.readouterr().out; assert 'doctor: PASS a: fine' in out and out.rstrip().endswith('doctor: 1 passed, 0 failed, 1 skipped')
    monkeypatch.setattr(D, 'run_checks', lambda home, db: [('PASS', 'a', 'fine'), ('FAIL', 'b', 'broken')])
    assert cli.main(['doctor']) == 1; assert 'doctor: FAIL b: broken' in capsys.readouterr().out

def test_the_operator_pin_row_passes_when_every_active_operator_has_a_pin(tmp_path):
    home, root = make(tmp_path); add_operators(abi_db(home, []), ('Ana', True), ('Ben', True))
    r = by(run(tmp_path, home, root), 'operator PINs'); assert r[0] == 'PASS' and '2 active operator(s), every one has a PIN' in r[2]

def test_the_operator_pin_row_names_who_has_no_pin_and_is_never_a_fail(tmp_path):
    home, root = make(tmp_path); add_operators(abi_db(home, []), ('Ana', True), ('Ben', False), ('Cy', False), ('Old', False, 0))      # Old is disabled: not named
    rows = run(tmp_path, home, root); r = by(rows, 'operator PINs')
    assert r[0] == 'WARN' and 'no PIN for 2 of 3 active operator(s): Ben (id 2), Cy (id 3)' in r[2] and 'Old' not in r[2] and 'set-pin' in r[2] and 'token only' in r[2]
    assert D.format_rows(rows)[1] is True                                                                                                # the exit code stays 0

def test_the_operator_pin_row_lists_four_names_and_then_dots(tmp_path):
    home, root = make(tmp_path); add_operators(abi_db(home, []), *[('Op%d' % i, False) for i in range(6)])
    r = by(run(tmp_path, home, root), 'operator PINs'); assert 'no PIN for 6 of 6' in r[2] and 'Op3 (id 4)' in r[2] and 'Op4' not in r[2] and ' ...' in r[2]

def test_the_operator_pin_row_is_skipped_without_a_database_an_operator_or_migration_0003(tmp_path):
    home, root = make(tmp_path); r = by(run(tmp_path, home, root), 'operator PINs'); assert r[0] == 'SKIP' and 'no database' in r[2]
    db = abi_db(home, []); r = by(run(tmp_path, home, root), 'operator PINs'); assert r[0] == 'SKIP' and 'no active operator' in r[2]
    add_operators(db, ('Old', True, 0)); assert status(run(tmp_path, home, root), 'operator PINs') == 'SKIP'                           # only a disabled operator
    old, mig = tmp_path / 'old' / 'ppe.db', tmp_path / 'mig'; mig.mkdir(); old.parent.mkdir()
    for f in ('0001.sql', '0002.sql'): shutil.copy(MIGRATIONS_DIR / f, mig / f)
    c = sqlite3.connect(str(old)); run_migrations(c, mig, 1); c.commit(); c.close()
    h2, r2 = make(tmp_path / 'b'); (h2 / 'data').mkdir(); shutil.copy(old, h2 / 'data' / 'ppe.db')
    r = by(run(tmp_path, h2, r2), 'operator PINs'); assert r[0] == 'SKIP' and 'migration 0003' in r[2]

def test_the_operator_pin_row_changes_nothing(tmp_path):
    home, root = make(tmp_path); add_operators(abi_db(home, [[]]), ('Ana', False)); before = tree(tmp_path)
    assert status(run(tmp_path, home, root), 'operator PINs') == 'WARN' and tree(tmp_path) == before

def test_a_settings_problem_skips_the_operator_pin_row_with_the_others(tmp_path):
    home, root = make(tmp_path); (home / 'config' / 'settings.local.json').write_text('{"session_hours": 0}')
    assert status(run(tmp_path, home, root), 'operator PINs') == 'SKIP'

def test_the_operator_pin_row_is_a_warn_that_counts_and_never_fails_the_run(tmp_path):
    home, root = make(tmp_path); add_operators(abi_db(home, [[]]), ('Ana', True), ('Ben', False)); rows = run(tmp_path, home, root)
    assert status(rows, 'operator PINs') == 'WARN'
    lines, ok = D.format_rows(rows); assert ok is True
    assert any(l.startswith('doctor: WARN operator PINs: no PIN for 1 of 2 active operator(s): Ben (id 2)') for l in lines) and lines[-1] == 'doctor: 13 passed, 0 failed, 0 skipped, 1 warned'

def test_the_summary_line_names_warned_only_when_a_check_warned():
    lines, ok = D.format_rows([('PASS', 'a', 'x'), ('WARN', 'b', 'y'), ('WARN', 'c', 'z'), ('SKIP', 'd', 'w')])
    assert ok and lines[-1] == 'doctor: 1 passed, 0 failed, 1 skipped, 2 warned'
    lines, ok = D.format_rows([('PASS', 'a', 'x'), ('FAIL', 'b', 'y'), ('WARN', 'c', 'z')]); assert not ok and lines[-1] == 'doctor: 1 passed, 1 failed, 0 skipped, 1 warned'
    lines, ok = D.format_rows([('PASS', 'a', 'x')]); assert ok and lines[-1] == 'doctor: 1 passed, 0 failed, 0 skipped'

def test_cli_doctor_exits_0_on_a_warn(capsys, monkeypatch):
    monkeypatch.setattr(D, 'run_checks', lambda home=None, db=None: [('PASS', 'a', 'fine'), ('WARN', 'b', 'check this')])
    assert cli.main(['doctor']) == 0; out = capsys.readouterr().out; assert 'doctor: WARN b: check this' in out and out.rstrip().endswith('doctor: 1 passed, 0 failed, 0 skipped, 1 warned')
