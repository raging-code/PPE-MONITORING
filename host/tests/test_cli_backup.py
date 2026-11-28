"""P11-2: backup core and cli (design 2.3, 2.5, 2.6; Section 8 migration test). Requirements: REQ-DB-001."""
import os, shutil, sqlite3, stat
from ppe_host import cli
from ppe_host.io.backup import online_backup, verify_backup, backup_before_migration, backup_name
from ppe_host.io.db_writer import connect_db, run_migrations, applied_versions
from test_db_schema import MIG, master

def seeded(tmp_path, name='live.db'):
    p = tmp_path / name; assert cli.main(['seed-roster', '--db', str(p)]) == 0; return p

def test_seed_roster_creates_the_schema_fills_nodes_1_to_3_and_is_safe_to_repeat(tmp_path, capsys):
    p = seeded(tmp_path); c = connect_db(p); assert c.execute('SELECT node_id, alias, active FROM roster ORDER BY node_id').fetchall() == [(1, 'FF-01', 1), (2, 'FF-02', 1), (3, 'FF-03', 1)]
    assert applied_versions(c) == [1, 2, 3, 4] and cli.seed_roster(c) == 0 and c.execute('SELECT COUNT(*) FROM roster').fetchone()[0] == 3
    c.execute('UPDATE roster SET active=0 WHERE node_id=2'); c.close(); cli.main(['seed-roster', '--db', str(p)])
    assert connect_db(p).execute('SELECT active FROM roster WHERE node_id=2').fetchone()[0] == 0                       # a second run never overwrites a roster row
    assert 'roster nodes 1 to 3 present' in capsys.readouterr().out

def test_online_backup_includes_uncheckpointed_wal_rows_is_read_only_and_verifies(tmp_path):
    p = seeded(tmp_path); c = connect_db(p); c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (1, 1, 'LIVE', 'b', 'c', 's')")
    assert os.path.exists(str(p) + '-wal')                                                                             # the row is still in the WAL: a file copy would miss it
    b = online_backup(p, tmp_path / 'bk' / 'one.db'); assert not (b.parent / 'one.db.part').exists()
    assert not (os.stat(b).st_mode & stat.S_IWRITE) and verify_backup(b) == (True, 'ok')
    r = sqlite3.connect(b); assert r.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 1 and r.execute('PRAGMA journal_mode').fetchone()[0] == 'delete'; r.close()
    again = online_backup(p, b); assert again == b and verify_backup(b)[0]                                              # an existing read-only backup is replaced

def test_backup_verify_accepts_a_good_backup_and_rejects_damaged_foreign_and_missing_files(tmp_path, capsys):
    b = online_backup(seeded(tmp_path), tmp_path / 'good.db'); assert cli.main(['backup-verify', '--file', str(b)]) == 0 and 'OK' in capsys.readouterr().out
    bad = tmp_path / 'bad.db'; data = bytearray(b.read_bytes()); data[4096 * 2: 4096 * 2 + 400] = b'\xff' * 400; bad.write_bytes(bytes(data))
    assert cli.main(['backup-verify', '--file', str(bad)]) == 1 and 'FAILED' in capsys.readouterr().out
    trunc = tmp_path / 'trunc.db'; trunc.write_bytes(b.read_bytes()[:5000]); assert not verify_backup(trunc)[0]
    junk = tmp_path / 'junk.db'; junk.write_bytes(b'not a database' * 50); assert not verify_backup(junk)[0]
    other = tmp_path / 'other.db'; o = sqlite3.connect(other); o.execute('CREATE TABLE t (x)'); o.commit(); o.close(); assert verify_backup(other) == (False, 'not a PPE database (no schema_version)')
    assert cli.main(['backup-verify', '--file', str(tmp_path / 'missing.db')]) == 1

def test_migration_takes_an_online_backup_first_and_that_backup_is_restorable(tmp_path):
    d = tmp_path / 'm'; d.mkdir(); shutil.copy(MIG / '0001.sql', d / '0001.sql'); live = tmp_path / 'live.db'; c = connect_db(live); run_migrations(c, str(d), 1)
    c.execute("INSERT INTO roster(node_id, alias) VALUES (1, 'FF-01')"); before = master(c)
    (d / '0002.sql').write_text('-- Migration 0002 test\nCREATE TABLE extra (x INTEGER);\n', encoding='utf8'); made = []
    run_migrations(c, str(d), 2, lambda: made.append(backup_before_migration(live, tmp_path / 'backups', 1_700_000_000_000)))
    assert applied_versions(c) == [1, 2] and len(made) == 1 and made[0].name == backup_name('pre-migration', 1_700_000_000_000) == 'pre-migration-20231114T221320Z.db'
    assert verify_backup(made[0])[0]
    restored = tmp_path / 'restored.db'; shutil.copy(made[0], restored); os.chmod(restored, stat.S_IWRITE | stat.S_IREAD)           # restore = copy the verified file into place
    r = connect_db(restored); assert master(r) == before and applied_versions(r) == [1] and r.execute('SELECT alias FROM roster').fetchone()[0] == 'FF-01'
