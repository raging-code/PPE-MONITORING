"""P26-3 (ADR 0040): the second-drive copy at End shift, read-only backup files and the full integrity_check at session end (design 2.5, 2.6). io/backup.py and HostPort.end_session.
Real database, writer and FakeClock. A 'drive' is a temporary folder; an unplugged drive is a folder that does not exist.
The copy is made from the verified local backup, into an existing folder only, read-only, verified, and a failure of it never undoes the shift or the local backup (backup_ok is False and BACKUP_FAIL says why)."""
import json, os, sqlite3, stat
from ppe_host.api import security as sec
from ppe_host.host_port import HostPort
from ppe_host.io import backup as bk
from ppe_host.settings import load_settings, settings_hash
from test_effect_rows import op, wait
from test_ingest import rig, rows
from test_sessions import Cfg, backups, err
from test_settings import DEFAULTS, home as settings_home
import test_purge_session as TP

def rig_port(tmp_path, drive=None, **extra):
    c, w, clock, ing = rig(tmp_path); op(c, 1); d = {'recovering_target_s': 3, 'login_backoff_cap_s': 5, 'backup_dir': 'backups/', 'second_drive_dir': '' if drive is None else str(drive)}; d.update(extra)
    return c, w, clock, ing, HostPort(ing, tmp_path / 't.db', Cfg(d, tmp_path), sec.Authenticator(tmp_path / 't.db', '00' * 32, 5), recovering=False)
def kinds(c, w, ing, like):
    wait(w, ing.write([])); return [(r['session_id'], r['kind'], r['detail']) for r in rows(c, 'SELECT session_id, kind, detail FROM system_events ORDER BY event_seq') if r['kind'].startswith(like.rstrip('%'))]
def read_only(p): return not (os.stat(p).st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
def small_db(tmp_path, name='s.db'):
    p = tmp_path / name; c = sqlite3.connect(p); c.execute('CREATE TABLE schema_version(v)'); c.execute('CREATE TABLE t(a PRIMARY KEY, b)'); c.executemany('INSERT INTO t VALUES (?, ?)', [(i, 'x' * 200) for i in range(2000)]); c.commit(); c.close(); return p

# ---- the copy ----
def test_end_shift_copies_the_verified_backup_to_the_second_drive_read_only(tmp_path):
    usb = tmp_path / 'usb'; usb.mkdir(); c, w, clock, ing, p = rig_port(tmp_path, usb); res = p.end_session(1, 1)
    local = backups(tmp_path); copies = sorted(usb.glob('*.db')); assert res.backup_ok is True and len(local) == 1 and [f.name for f in copies] == [local[0].name] and list(usb.glob('*.part')) == []
    assert bk.verify_backup(copies[0]) == (True, 'ok') and read_only(copies[0]) and read_only(local[0]) and copies[0].read_bytes() == local[0].read_bytes()                  # backup files are read-only (2.6)
    assert kinds(c, w, ing, 'BACKUP%') == [(2, 'BACKUP_OK', local[0].name), (2, 'BACKUP_OK', 'second drive: %s' % copies[0])]; w.stop()

def test_an_empty_second_drive_setting_changes_nothing(tmp_path):
    c, w, clock, ing, p = rig_port(tmp_path); res = p.end_session(1, 1)
    assert res.backup_ok is True and [k[1] for k in kinds(c, w, ing, 'BACKUP%')] == ['BACKUP_OK'] and bk.second_drive_dir(Cfg({'second_drive_dir': '  '}, tmp_path)) is None; w.stop()

def test_an_unplugged_drive_fails_the_copy_makes_no_folder_and_still_closes_the_shift(tmp_path):
    gone = tmp_path / 'E_drive' / 'ppe'; c, w, clock, ing, p = rig_port(tmp_path, gone); res = p.end_session(1, 1)
    assert (res.new_session_id, res.backup_ok) == (2, False) and not gone.exists() and not gone.parent.exists() and len(backups(tmp_path)) == 1 and bk.verify_backup(backups(tmp_path)[0])[0]
    k = kinds(c, w, ing, 'BACKUP%'); assert [x[1] for x in k] == ['BACKUP_OK', 'BACKUP_FAIL'] and k[1][2].startswith('second drive: OSError: second drive folder not found')
    assert rows(c, 'SELECT end_kind FROM sessions WHERE session_id = 1') == [{'end_kind': 'ENDED'}]; w.stop()

def test_a_second_drive_that_is_the_backup_folder_is_refused_and_the_local_backup_stays(tmp_path):
    (tmp_path / 'backups').mkdir(); c, w, clock, ing, p = rig_port(tmp_path, tmp_path / 'backups'); res = p.end_session(1, 1)
    assert res.backup_ok is False and len(backups(tmp_path)) == 1 and 'same folder as backup_dir' in kinds(c, w, ing, 'BACKUP_FAIL')[0][2]; w.stop()

def test_a_failed_local_backup_makes_no_second_copy_and_says_so(tmp_path, monkeypatch):
    usb = tmp_path / 'usb'; usb.mkdir(); c, w, clock, ing, p = rig_port(tmp_path, usb)
    def boom(*a, **k): raise OSError('disk full')
    monkeypatch.setattr(bk, 'online_backup', boom); res = p.end_session(1, 1)
    assert res.backup_ok is False and list(usb.iterdir()) == [] and [x[2] for x in kinds(c, w, ing, 'BACKUP_FAIL')] == ['OSError: disk full', 'second drive: OSError: no verified local backup to copy']; w.stop()

def test_a_copy_that_fails_verification_is_removed_and_reported(tmp_path, monkeypatch):
    usb = tmp_path / 'usb'; usb.mkdir(); real = bk.verify_backup
    monkeypatch.setattr(bk, 'verify_backup', lambda f: (False, 'integrity_check: page 3 is bad') if 'usb' in str(f) else real(f))
    c, w, clock, ing, p = rig_port(tmp_path, usb); res = p.end_session(1, 1)
    assert res.backup_ok is False and list(usb.iterdir()) == [] and len(backups(tmp_path)) == 1 and 'failed verification and was removed' in kinds(c, w, ing, 'BACKUP_FAIL')[0][2]; w.stop()

def test_copy_to_second_drive_replaces_a_read_only_copy_and_leaves_no_part_file(tmp_path):
    src = bk.online_backup(small_db(tmp_path), tmp_path / 'local' / 'end-shift-1.db'); usb = tmp_path / 'usb'; usb.mkdir()
    a = bk.copy_to_second_drive(src, usb); b = bk.copy_to_second_drive(src, usb, tmp_path / 'local')
    assert a == b == usb / 'end-shift-1.db' and read_only(b) and sorted(f.name for f in usb.iterdir()) == ['end-shift-1.db'] and bk.verify_backup(b) == (True, 'ok')
    assert read_only(src) and src.read_bytes() == b.read_bytes()

def test_a_conflicting_end_shift_makes_no_copy_and_no_integrity_row(tmp_path):
    usb = tmp_path / 'usb'; usb.mkdir(); c, w, clock, ing, p = rig_port(tmp_path, usb); p.end_session(1, 1)
    assert err(lambda: p.end_session(1, 1)) == (409, 'STATE_CONFLICT') and len(list(usb.iterdir())) == 1
    assert len(kinds(c, w, ing, 'INTEGRITY%')) == 1 and len(kinds(c, w, ing, 'BACKUP%')) == 2; w.stop()

# ---- backup files are read-only ----
def test_online_backup_files_are_read_only_and_a_rewrite_replaces_them(tmp_path):
    db = small_db(tmp_path); a = bk.online_backup(db, tmp_path / 'b' / 'x.db'); assert read_only(a) and bk.verify_backup(a) == (True, 'ok')
    b = bk.online_backup(db, tmp_path / 'b' / 'x.db'); assert read_only(b) and not list((tmp_path / 'b').glob('*.part'))

# ---- the full integrity check ----
def test_end_shift_runs_the_full_integrity_check_of_the_live_database_and_logs_it(tmp_path):
    c, w, clock, ing, p = rig_port(tmp_path); p.end_session(1, 1)
    assert kinds(c, w, ing, 'INTEGRITY%') == [(2, 'INTEGRITY_OK', 'integrity_check at session end: ok')]; w.stop()

def test_a_failed_integrity_check_is_logged_as_integrity_fail_and_the_shift_still_closes(tmp_path, monkeypatch):
    c, w, clock, ing, p = rig_port(tmp_path); monkeypatch.setattr(bk, 'integrity_check', lambda path: (False, 'Page 4: btreeInitPage() returns error code 11')); res = p.end_session(1, 1)
    assert res.new_session_id == 2 and res.backup_ok is True and kinds(c, w, ing, 'INTEGRITY%') == [(2, 'INTEGRITY_FAIL', 'integrity_check at session end: Page 4: btreeInitPage() returns error code 11')]; w.stop()

def test_integrity_check_finds_a_damaged_file_and_passes_a_good_one_without_writing_it(tmp_path):
    good = small_db(tmp_path); before = good.read_bytes(); assert bk.integrity_check(good) == (True, 'ok') and good.read_bytes() == before
    bad = tmp_path / 'bad.db'; data = bytearray(before)
    for off in range(4096 * 2, len(data), 4096): data[off:off + 64] = b'\xff' * 64            # smash the start of every data page after the first two
    bad.write_bytes(bytes(data)); ok, why = bk.integrity_check(bad); assert ok is False and why != 'ok'
    junk = tmp_path / 'junk.db'; junk.write_bytes(b'not a database' * 50); ok, why = bk.integrity_check(junk); assert ok is False and 'DatabaseError' in why
    assert bk.integrity_check(tmp_path / 'missing.db')[0] is False and not (tmp_path / 'missing.db').exists()

def test_the_integrity_check_reads_the_live_database_while_the_writer_is_running(tmp_path):
    c, w, clock, ing, p = rig_port(tmp_path); wait(w, ing.write([])); assert bk.integrity_check(tmp_path / 't.db') == (True, 'ok'); w.stop()

# ---- the setting and the purge CLI ----
def test_second_drive_dir_is_a_path_key_off_by_default_and_outside_the_settings_hash(tmp_path):
    s = load_settings(settings_home(tmp_path)); assert DEFAULTS['second_drive_dir'] == '' and bk.second_drive_dir(s) is None
    s2 = load_settings(settings_home(tmp_path, {'second_drive_dir': 'E:/ppe-backups'})); assert str(bk.second_drive_dir(s2)).replace('\\', '/').endswith('E:/ppe-backups') and settings_hash(s2) == settings_hash(s)

def test_purge_session_also_sweeps_the_configured_second_drive_and_a_missing_one_is_exit_2(tmp_path, capsys):
    home, db = TP.build(tmp_path); usb = tmp_path / 'usb'; local = bk.online_backup(db, home / 'backups' / 'end-shift-1.db'); copy = bk.online_backup(db, usb / 'end-shift-1.db')
    (home / 'config').mkdir(); (home / 'config' / 'settings.local.json').write_text(json.dumps({'second_drive_dir': str(usb)}))
    assert TP.run(home, db, '--session-id', 1) == 0 and set(TP.per_session(copy, 1).values()) == {0} and set(TP.per_session(local, 1).values()) == {0} and read_only(copy)
    other = tmp_path / 'b'; other.mkdir(); home, db = TP.build(other); (home / 'config').mkdir(); (home / 'config' / 'settings.local.json').write_text(json.dumps({'second_drive_dir': str(tmp_path / 'unplugged')}))
    capsys.readouterr(); assert TP.run(home, db, '--session-id', 1) == 2 and 'does not exist' in capsys.readouterr().err
