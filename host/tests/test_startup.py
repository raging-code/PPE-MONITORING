"""P24-1: start-up steps 1 to 5 and the start-up failure policy of design 14.5 (a lockfile, b quick_check, c failed migration, d secrets and salt). Requirements: REQ-REC-007."""
import json, os, shutil, sqlite3
import pytest
from ppe_host import main as M
from ppe_host.cli import MIGRATIONS_DIR
from ppe_host.io.backup import online_backup
from ppe_host.io.db_writer import connect_db, run_migrations

KEY = '000102030405060708090a0b0c0d0e0f'
NOW = 1_700_000_000_000
FAKE_PID = 4_000_001

def home(tmp_path, secrets=True, salt=False):
    (tmp_path / 'config').mkdir(exist_ok=True)
    if secrets: (tmp_path / 'config' / 'secrets.json').write_text(json.dumps({'cmac_key': KEY, **({'server_salt': 'ab' * 32} if salt else {})}))
    return tmp_path

def run(h, mode='LIVE', alive=None, **kw):
    """startup() with a fake process table: alive = {pid: start token}; the new process is FAKE_PID."""
    table = dict(alive or {}); table.setdefault(FAKE_PID, 1)
    return M.startup(str(h), mode, now_ms=lambda: NOW, proc_start=table.get, pid=FAKE_PID, **kw)

def make_db(path, operators=False):
    c = connect_db(path); run_migrations(c, str(MIGRATIONS_DIR), NOW); c.execute("INSERT INTO roster(node_id, alias) VALUES (1, 'FF-01')")
    if operators: c.execute("INSERT INTO operators(display_name, token_hash, created_ts, token_issued_ts) VALUES ('op', 'x', 1, 1)")
    c.close()

def test_clean_start_creates_a_migrated_database_with_the_roster_and_a_lockfile(tmp_path):
    h = home(tmp_path); st = run(h)
    assert st.db_path == h / 'data' / 'ppe.db' and st.event_seq == 1 and st.recovery is None and st.applied == [1, 2]
    assert [r[0] for r in st.conn.execute('SELECT node_id FROM roster ORDER BY 1')] == [1, 2, 3]
    assert M.Lockfile.read(h / M.LOCK_NAME) == (FAKE_PID, 1); assert (h / 'config' / 'secrets.json').read_text().count('server_salt') == 1       # the salt is created when no operator exists
    st.close(); assert not (h / M.LOCK_NAME).exists()

def test_event_seq_continues_after_the_largest_stored_value(tmp_path):
    h = home(tmp_path, salt=True); make_db(h / 'data' / 'ppe.db') if (h / 'data').mkdir() is None else None
    c = connect_db(h / 'data' / 'ppe.db'); c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (1, 1, 'LIVE', 'b', 'c', 's')")
    c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind) VALUES (1, 41, 1, 'HOST_START')"); c.close()
    st = run(h); assert st.event_seq == 42 and st.applied == []; st.close()

def test_simulator_uses_test_db_path_and_never_opens_db_path(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR'); assert st.db_path == h / 'data' / 'ppe_test.db' and not (h / 'data' / 'ppe.db').exists()
    assert [r[0] for r in st.conn.execute('SELECT node_id FROM roster ORDER BY 1')] == [1, 2, 3]; st.close()

# ---- (d) secrets ----
@pytest.mark.parametrize('body', [None, '{not json', '{"server_salt": "%s"}' % ('ab' * 32), '{"cmac_key": "zz"}'])
def test_missing_or_unreadable_secrets_exit_2_and_never_show_the_key(tmp_path, body, capsys):
    h = home(tmp_path, secrets=False)
    if body is not None: (h / 'config' / 'secrets.json').write_text(body)
    with pytest.raises(M.StartupExit) as e: run(h)
    assert e.value.code == 2 and ('secrets.json' in e.value.message or 'cmac_key' in e.value.message) and KEY not in e.value.message and not (h / M.LOCK_NAME).exists()

def test_missing_server_salt_while_operators_exist_exits_2_and_releases_the_lock(tmp_path):
    h = home(tmp_path); (h / 'data').mkdir(); make_db(h / 'data' / 'ppe.db', operators=True)
    with pytest.raises(M.StartupExit) as e: run(h)
    assert e.value.code == 2 and 'server_salt' in e.value.message and not (h / M.LOCK_NAME).exists()
    assert 'server_salt' not in (h / 'config' / 'secrets.json').read_text()

def test_a_bad_settings_override_exits_2(tmp_path):
    h = home(tmp_path); (h / 'config' / 'settings.local.json').write_text('{"no_such_key": 1}')
    with pytest.raises(M.StartupExit) as e: run(h)
    assert e.value.code == 2

# ---- (a) lockfile ----
def test_a_live_lockfile_makes_the_new_process_exit_0_and_keeps_the_old_lock(tmp_path):
    h = home(tmp_path); (h / M.LOCK_NAME).write_text(json.dumps({'pid': 77, 'start': 5}))
    with pytest.raises(M.StartupExit) as e: run(h, alive={77: 5})
    assert e.value.code == 0 and M.Lockfile.read(h / M.LOCK_NAME) == (77, 5)

@pytest.mark.parametrize('alive, content', [({}, '{"pid": 77, "start": 5}'), ({77: 6}, '{"pid": 77, "start": 5}'), ({77: 5}, 'garbage')])
def test_a_stale_lockfile_is_replaced_and_logged(tmp_path, caplog, alive, content):
    h = home(tmp_path); (h / M.LOCK_NAME).write_text(content)        # PID not running, PID reused (start time differs), unreadable file
    with caplog.at_level('WARNING', logger='ppe_host'): st = run(h, alive=alive)
    assert M.Lockfile.read(h / M.LOCK_NAME) == (FAKE_PID, 1) and 'stale lockfile' in caplog.text; st.close()

def test_simulator_and_live_share_one_lockfile_in_both_directions(tmp_path):
    h = home(tmp_path); st = run(h, 'SIMULATOR')
    for mode in ('LIVE', 'REPLAY'):
        with pytest.raises(M.StartupExit) as e: run(h, mode, alive={FAKE_PID: 1})
        assert e.value.code == 0
    st.close(); run(h, 'LIVE').close()

def test_own_process_start_token_is_readable_and_a_missing_pid_is_none():
    assert M.process_start(os.getpid()) is not None and M.process_start(os.getpid()) == M.process_start(os.getpid()) and M.process_start(4_194_000) is None

# ---- (b) quick_check ----
def corrupt(db): db.write_bytes(b'this is not a database' * 200); (db.parent / (db.name + '-wal')).write_bytes(b'w'); (db.parent / (db.name + '-shm')).write_bytes(b's')

def good_backup(h, name, mtime):
    src = h / 'data' / 'src.db'; src.parent.mkdir(exist_ok=True); make_db(src); p = online_backup(src, h / 'backups' / name); src.unlink(); os.utime(p, (mtime, mtime)); return p

def test_failed_quick_check_quarantines_with_wal_and_shm_and_restores_the_newest_good_backup(tmp_path):
    h = home(tmp_path, salt=True); db = h / 'data' / 'ppe.db'; good_backup(h, 'old.db', 100); good_backup(h, 'new.db', 200)
    bad = h / 'backups' / 'newest-bad.db'; bad.write_bytes(b'junk'); os.utime(bad, (300, 300)); corrupt(db)
    st = run(h); tag = '.corrupt-' + M.utc_stamp(NOW)
    assert st.recovery == {'quarantined': 'ppe.db' + tag, 'backup': 'new.db'}
    assert (db.parent / ('ppe.db' + tag)).read_bytes().startswith(b'this is not') and (db.parent / ('ppe.db' + tag + '-wal')).exists() and (db.parent / ('ppe.db' + tag + '-shm')).exists()
    assert [r[0] for r in st.conn.execute('SELECT node_id FROM roster')] == [1] and st.conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok'; st.close()

def test_failed_quick_check_with_no_good_backup_creates_a_fresh_seeded_database(tmp_path):
    h = home(tmp_path, salt=True); db = h / 'data' / 'ppe.db'; db.parent.mkdir(); corrupt(db); (h / 'backups').mkdir(); (h / 'backups' / 'x.db').write_bytes(b'junk')
    st = run(h); assert st.recovery['backup'] is None and st.applied == [1, 2] and st.conn.execute('SELECT COUNT(*) FROM roster').fetchone()[0] == 3; st.close()

def test_failed_quick_check_in_simulator_restores_no_backup(tmp_path):
    h = home(tmp_path, salt=True); good_backup(h, 'g.db', 100); t = h / 'data' / 'ppe_test.db'; corrupt(t)
    st = run(h, 'SIMULATOR'); assert st.recovery['backup'] is None and st.conn.execute('SELECT COUNT(*) FROM roster').fetchone()[0] == 3 and not (h / 'data' / 'ppe.db').exists(); st.close()

# ---- (c) migrations ----
def two_migrations(tmp_path, second_sql):
    d = tmp_path / 'mig'; d.mkdir(); shutil.copy(MIGRATIONS_DIR / '0001.sql', d / '0001.sql'); shutil.copy(MIGRATIONS_DIR / '0002.sql', d / '0002.sql'); (d / '0003.sql').write_text(second_sql); return d   # the test migration comes after every real one

def test_failed_migration_restores_the_pre_migration_backup_and_exits_2(tmp_path):
    h = home(tmp_path, salt=True); (h / 'data').mkdir(); make_db(h / 'data' / 'ppe.db')
    d = two_migrations(tmp_path, '-- bad\nDELETE FROM roster;\nCOMMIT;\nSELEC oops;')          # commits a change, then fails: only the restore brings the roster back
    with pytest.raises(M.StartupExit) as e: run(h, migrations_dir=d)
    assert e.value.code == 2 and 'restored' in e.value.message and not (h / M.LOCK_NAME).exists()
    assert list((h / 'backups').glob('pre-migration-*.db'))
    c = sqlite3.connect(str(h / 'data' / 'ppe.db')); assert c.execute('SELECT COUNT(*) FROM roster').fetchone()[0] == 1 and c.execute('SELECT MAX(version) FROM schema_version').fetchone()[0] == 2

def test_a_database_newer_than_the_code_exits_2(tmp_path):
    h = home(tmp_path, salt=True); (h / 'data').mkdir(); c = connect_db(h / 'data' / 'ppe.db'); run_migrations(c, str(two_migrations(tmp_path, 'CREATE TABLE t(x);')), NOW); c.close()
    with pytest.raises(M.StartupExit) as e: run(h)
    assert e.value.code == 2 and 'newer' in e.value.message

def test_pending_migration_runs_after_an_online_backup(tmp_path):
    h = home(tmp_path, salt=True); (h / 'data').mkdir(); make_db(h / 'data' / 'ppe.db'); st = run(h, migrations_dir=two_migrations(tmp_path, '-- add t\nCREATE TABLE t(x);'))
    assert st.applied == [3] and list((h / 'backups').glob('pre-migration-*.db')); st.close()

# ---- main() exit codes ----
async def no_serve(rt, host, port): return         # step 10 (P24-3c-3) would block on Uvicorn; test_serve.py covers it
def test_main_exit_codes(tmp_path, monkeypatch, capsys):
    h = home(tmp_path); assert M.main(['--home', str(h)], serve=no_serve) == 0 and not (h / M.LOCK_NAME).exists()
    assert M.main(['--home', str(home(tmp_path / 'x' if (tmp_path / 'x').mkdir() is None else tmp_path, secrets=False))]) == 2
    (h / M.LOCK_NAME).write_text(json.dumps({'pid': os.getpid(), 'start': M.process_start(os.getpid())})); assert M.main(['--home', str(h)]) == 0 and (h / M.LOCK_NAME).exists()
    (h / M.LOCK_NAME).unlink(); monkeypatch.setattr(M, 'quick_check', lambda db: 1 / 0); assert M.main(['--home', str(h)]) == 1 and not (h / M.LOCK_NAME).exists()
