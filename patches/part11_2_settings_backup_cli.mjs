// patches/part11_2_settings_backup_cli.mjs  (run from repo root: node patches/part11_2_settings_backup_cli.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  put('host/ppe_host/settings.py', String.raw`"""settings.py (P11-2): the minimal loader of design 1 (Host configuration) and the two session hashes. P24 extends it (mode choice, 'auto' serial port, lockfile).
Committed defaults: host/config/settings.json. Machine-specific overrides: <PPE_HOME>/config/settings.local.json. Secrets: <PPE_HOME>/config/secrets.json.
PPE_HOME defaults to the repository folder. Secrets never appear in repr, errors, hashes or logs."""
import hashlib, json, os, re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULTS_PATH = REPO_ROOT / 'host' / 'config' / 'settings.json'
CONSTANTS_PATH = REPO_ROOT / 'shared' / 'constants.json'
PATH_KEYS = ('db_path', 'test_db_path', 'backup_dir', 'log_dir')            # resolved against PPE_HOME
HASH_EXCLUDED = ('serial_port', 'db_path', 'test_db_path', 'backup_dir', 'log_dir', 'bind_host', 'bind_port',                         # connection and path keys (Rev 3.41)
                 'host_alarm_budget_ms', 'checkpoint_interval_s', 'checkpoint_max_bytes', 'host_budget_ms', 'dashboard_budget_ms',     # the nine rows marked
                 'recovering_target_s', 'host_bat_warn_pct', 'host_disk_min_gb', 'supervisor_restart_target_s')                        # 'Not in settings_hash' (Rev 3.42)

class SettingsError(ValueError): pass

def canonical_json(obj):
    """Canonical sorted-key compact UTF-8 JSON (design 1): formatting or key order never changes a hash."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':')).encode('utf-8')

def _read_json(path, what):
    try: return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e: raise SettingsError('cannot read %s (%s)' % (what, type(e).__name__)) from None

def _same_kind(default, value):
    if isinstance(default, bool) or isinstance(value, bool): return isinstance(default, bool) and isinstance(value, bool)
    if isinstance(default, (int, float)): return isinstance(value, (int, float))
    return isinstance(value, type(default))

@dataclass(frozen=True)
class Settings:
    values: dict
    home: Path
    _secrets: dict = field(default_factory=dict, repr=False)
    def __getitem__(self, k): return self.values[k]
    def get(self, k, default=None): return self.values.get(k, default)
    def path(self, key):
        if key not in PATH_KEYS: raise KeyError(key)
        return self.home / self.values[key]                      # an absolute value in settings stays as it is
    @property
    def secrets_path(self): return self.home / 'config' / 'secrets.json'
    def _hex_secret(self, name, nchars):
        v = self._secrets.get(name)
        if not (isinstance(v, str) and re.fullmatch(r'[0-9a-fA-F]{%d}' % nchars, v)): raise SettingsError('%s in config/secrets.json is missing or is not %d hex characters' % (name, nchars))
        return bytes.fromhex(v)
    def cmac_key(self): return self._hex_secret('cmac_key', 32)           # the 16-byte shared key
    def server_salt(self): return self._hex_secret('server_salt', 64)     # 32 random bytes; P19b generates it, the host never replaces a missing one

def load_settings(ppe_home=None, defaults_path=DEFAULTS_PATH, env=None):
    home = Path(ppe_home or (env if env is not None else os.environ).get('PPE_HOME') or REPO_ROOT)
    values = _read_json(defaults_path, 'settings.json')
    local = home / 'config' / 'settings.local.json'
    if local.exists():
        over = _read_json(local, 'settings.local.json')
        if not isinstance(over, dict): raise SettingsError('settings.local.json must be a JSON object')
        for k, v in over.items():
            if k not in values: raise SettingsError('unknown key in settings.local.json: %s' % k)
            if not _same_kind(values[k], v): raise SettingsError('settings.local.json: %s must be of type %s' % (k, type(values[k]).__name__))
            values[k] = v
    sec = home / 'config' / 'secrets.json'
    secrets = _read_json(sec, 'secrets.json') if sec.exists() else {}
    if not isinstance(secrets, dict): raise SettingsError('secrets.json must be a JSON object')
    return Settings(values, home, secrets)

def settings_hash(settings):
    """SHA-256 over the merged settings without HASH_EXCLUDED, canonical JSON (design 1; a changed hash ends the session)."""
    vals = settings.values if isinstance(settings, Settings) else settings
    return hashlib.sha256(canonical_json({k: v for k, v in vals.items() if k not in HASH_EXCLUDED})).hexdigest()

def constants_hash(path=CONSTANTS_PATH):
    """SHA-256 over the whole of shared/constants.json, canonical JSON."""
    return hashlib.sha256(canonical_json(_read_json(path, 'constants.json'))).hexdigest()
`);
  put('host/ppe_host/io/backup.py', String.raw`"""io/backup.py (P11-2): online backup and backup verification (design 2.5, 2.6). P26 adds scheduling, the second drive and purge.
The backup uses the sqlite3 backup API (250 pages per step), never a file copy, because the WAL is active. The result is one self-contained file
(journal_mode DELETE, so it opens read-only anywhere) and is made read-only (2.6)."""
import os, sqlite3, stat
from datetime import datetime, timezone
from pathlib import Path

PAGES_PER_STEP = 250

def online_backup(src_path, dest_path):
    """Copy the database at src_path into dest_path through the backup API. Written beside the destination first and renamed into place."""
    dest = Path(dest_path); dest.parent.mkdir(parents=True, exist_ok=True); tmp = dest.with_name(dest.name + '.part')
    if tmp.exists(): tmp.unlink()
    src = sqlite3.connect('file:%s?mode=ro' % str(src_path).replace('\\', '/'), uri=True); out = sqlite3.connect(str(tmp))
    try:
        src.backup(out, pages=PAGES_PER_STEP); out.execute('PRAGMA journal_mode=DELETE')
    finally: out.close(); src.close()
    if dest.exists(): os.chmod(dest, stat.S_IWRITE | stat.S_IREAD); dest.unlink()
    os.replace(tmp, dest); os.chmod(dest, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)       # 0444 (Windows: the read-only attribute)
    return dest

def backup_name(prefix, now_ms): return '%s-%s.db' % (prefix, datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc).strftime('%Y%m%dT%H%M%SZ'))

def backup_before_migration(db_path, backup_dir, now_ms):
    """The run_migrations before_apply hook (design 2.3: an online backup before any migration)."""
    return online_backup(db_path, Path(backup_dir) / backup_name('pre-migration', now_ms))

def verify_backup(path):
    """(ok, detail). A good backup opens read-only, passes integrity_check, has PPE's schema_version table and an empty foreign_key_check."""
    if not Path(path).is_file(): return False, 'file not found'
    try:
        c = sqlite3.connect('file:%s?mode=ro' % str(path).replace('\\', '/'), uri=True)
        try:
            res = [r[0] for r in c.execute('PRAGMA integrity_check')]
            if res != ['ok']: return False, 'integrity_check: ' + '; '.join(res[:3])
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone(): return False, 'not a PPE database (no schema_version)'
            if c.execute('PRAGMA foreign_key_check').fetchall(): return False, 'foreign_key_check reports rows'
            return True, 'ok'
        finally: c.close()
    except sqlite3.Error as e: return False, '%s: %s' % (type(e).__name__, e)
`);
  put('host/ppe_host/cli.py', String.raw`"""cli.py (P11-2): offline maintenance commands. A command is one entry in COMMANDS: name -> (function(args) -> exit code, [(flag, argparse kwargs)]).
Later parts add commands with replace on the marker line inside COMMANDS. Run: python -m ppe_host.cli <command> ..."""
import argparse, sys
from pathlib import Path
from .io.backup import verify_backup
from .io.db_writer import connect_db, run_migrations, applied_versions

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / 'migrations'
ROSTER = ((1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03'))      # Tier 1: node ids 1 to 3 with their alias codes (design 2.1: aliases, never names)

def seed_roster(conn):
    """Insert nodes 1 to 3 if missing (safe to repeat). Returns the number of rows added."""
    before = conn.execute('SELECT COUNT(*) FROM roster').fetchone()[0]
    conn.executemany('INSERT OR IGNORE INTO roster(node_id, alias, active) VALUES (?, ?, 1)', ROSTER)
    return conn.execute('SELECT COUNT(*) FROM roster').fetchone()[0] - before

def cmd_seed_roster(a):
    import time
    conn = connect_db(a.db)
    try:
        if not applied_versions(conn): run_migrations(conn, str(MIGRATIONS_DIR), int(time.time() * 1000))     # a new empty file gets the schema first
        n = seed_roster(conn)
    finally: conn.close()
    print('seed-roster: %d row(s) added, roster nodes 1 to 3 present' % n); return 0

def cmd_backup_verify(a):
    ok, detail = verify_backup(a.file); print(('backup-verify: OK ' if ok else 'backup-verify: FAILED ') + a.file + ('' if ok else ' (%s)' % detail)); return 0 if ok else 1

COMMANDS = {
    'seed-roster': (cmd_seed_roster, [('--db', {'required': True, 'help': 'database file to seed'})]),
    'backup-verify': (cmd_backup_verify, [('--file', {'required': True, 'help': 'backup file to check'})]),
    # P-next commands are added here (one line each)
}

def main(argv=None):
    p = argparse.ArgumentParser(prog='ppe_host.cli'); sub = p.add_subparsers(dest='command', required=True)
    for name, (_, flags) in COMMANDS.items():
        sp = sub.add_parser(name)
        for flag, kw in flags: sp.add_argument(flag, **kw)
    a = p.parse_args(argv)
    return COMMANDS[a.command][0](a)

if __name__ == '__main__': sys.exit(main())
`);
  put('host/tests/test_settings.py', String.raw`"""P11-2: settings loader and the two session hashes (design 1, Host configuration)."""
import json, pytest
from ppe_host.settings import (load_settings, settings_hash, constants_hash, canonical_json, SettingsError, HASH_EXCLUDED, DEFAULTS_PATH, REPO_ROOT)

DEFAULTS = json.loads(DEFAULTS_PATH.read_text(encoding='utf8'))
def home(tmp_path, local=None, secrets=None):
    (tmp_path / 'config').mkdir(exist_ok=True)
    if local is not None: (tmp_path / 'config' / 'settings.local.json').write_text(json.dumps(local), encoding='utf8')
    if secrets is not None: (tmp_path / 'config' / 'secrets.json').write_text(json.dumps(secrets), encoding='utf8')
    return tmp_path

def test_defaults_load_and_paths_resolve_against_ppe_home(tmp_path):
    s = load_settings(home(tmp_path)); assert s.values == DEFAULTS and len(s.values) == 35 and s.home == tmp_path
    assert s.path('db_path') == tmp_path / 'data/ppe.db' and s.path('backup_dir') == tmp_path / 'backups/' and s.secrets_path == tmp_path / 'config' / 'secrets.json'
    abs_dir = tmp_path / 'elsewhere'; assert load_settings(home(tmp_path, {'log_dir': str(abs_dir)})).path('log_dir') == abs_dir      # an absolute path is kept
    with pytest.raises(KeyError): s.path('sys_id')

def test_ppe_home_comes_from_the_environment_and_defaults_to_the_repository(tmp_path):
    assert load_settings(env={'PPE_HOME': str(tmp_path)}).home == tmp_path and load_settings(env={}).home == REPO_ROOT

def test_local_override_wins_unknown_keys_and_wrong_types_are_refused(tmp_path):
    s = load_settings(home(tmp_path, {'serial_port': 'COM7', 'bind_port': 8421, 'host_disk_min_gb': 2})); assert (s['serial_port'], s['bind_port'], s['host_disk_min_gb'], s['sys_id']) == ('COM7', 8421, 2, 1)
    for bad in ({'serial_prot': 'COM7'}, {'bind_port': '8421'}, {'co_rising_enabled': 1}, {'sys_id': True}, [1]):
        with pytest.raises(SettingsError): load_settings(home(tmp_path, bad))
    (tmp_path / 'config' / 'settings.local.json').write_text('{oops', encoding='utf8')
    with pytest.raises(SettingsError): load_settings(tmp_path)

def test_secrets_are_validated_and_never_shown(tmp_path):
    key, salt = '000102030405060708090a0b0c0d0e0f', 'ab' * 32
    s = load_settings(home(tmp_path, secrets={'cmac_key': key, 'server_salt': salt})); assert s.cmac_key() == bytes.fromhex(key) and s.server_salt() == bytes.fromhex(salt)
    assert key not in repr(s) and salt not in repr(s) and key not in json.dumps(s.values)
    for bad in ({}, {'cmac_key': key[:30]}, {'cmac_key': 'zz' * 16}, {'cmac_key': 5}):
        with pytest.raises(SettingsError) as e: load_settings(home(tmp_path, secrets=bad)).cmac_key()
        assert key not in str(e.value)
    with pytest.raises(SettingsError): load_settings(tmp_path / 'none').server_salt()

def test_settings_hash_ignores_connection_path_and_budget_keys_but_not_the_rest(tmp_path):
    base = DEFAULTS; h = settings_hash(base); assert len(h) == 64 and len(HASH_EXCLUDED) == 16 and set(HASH_EXCLUDED) <= set(base)
    for k in HASH_EXCLUDED:                                                                                           # 7 path keys and the nine 'Not in settings_hash' rows
        v = base[k]; assert settings_hash({**base, k: (v + 'x' if isinstance(v, str) else v + 1)}) == h, k
    for k in set(base) - set(HASH_EXCLUDED):
        v = base[k]; assert settings_hash({**base, k: (not v if isinstance(v, bool) else v + 'x' if isinstance(v, str) else v + 1)}) != h, k   # sys_id, commit_wait_ms, co_rising_enabled ...
    assert settings_hash(dict(reversed(list(base.items())))) == h                                                    # key order is irrelevant
    assert settings_hash(load_settings(home(tmp_path, {'serial_port': 'COM9'}))) == h                                # a re-plugged COM port does not end a shift

def test_constants_hash_ignores_formatting_and_follows_values(tmp_path):
    h = constants_hash(); d = json.loads((REPO_ROOT / 'shared' / 'constants.json').read_text(encoding='utf8'))
    a = tmp_path / 'a.json'; a.write_text(json.dumps(d, indent=4, sort_keys=False), encoding='utf8'); assert constants_hash(a) == h and len(h) == 64
    k = next(iter(d)); d[k] = d[k] + 1 if isinstance(d[k], (int, float)) else str(d[k]) + 'x'; a.write_text(json.dumps(d), encoding='utf8'); assert constants_hash(a) != h
    assert canonical_json({'b': 1, 'a': [1, 2]}) == b'{"a":[1,2],"b":1}'
`);
  put('host/tests/test_cli_backup.py', String.raw`"""P11-2: backup core and cli (design 2.3, 2.5, 2.6; Section 8 migration test)."""
import os, shutil, sqlite3, stat
from ppe_host import cli
from ppe_host.io.backup import online_backup, verify_backup, backup_before_migration, backup_name
from ppe_host.io.db_writer import connect_db, run_migrations, applied_versions
from test_db_schema import MIG, master

def seeded(tmp_path, name='live.db'):
    p = tmp_path / name; assert cli.main(['seed-roster', '--db', str(p)]) == 0; return p

def test_seed_roster_creates_the_schema_fills_nodes_1_to_3_and_is_safe_to_repeat(tmp_path, capsys):
    p = seeded(tmp_path); c = connect_db(p); assert c.execute('SELECT node_id, alias, active FROM roster ORDER BY node_id').fetchall() == [(1, 'FF-01', 1), (2, 'FF-02', 1), (3, 'FF-03', 1)]
    assert applied_versions(c) == [1] and cli.seed_roster(c) == 0 and c.execute('SELECT COUNT(*) FROM roster').fetchone()[0] == 3
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
`);
  append('docs/PROGRESS.md', '- Part 11-2 done: settings.py (load_settings with PPE_HOME, settings.local.json override that refuses unknown keys and wrong types, secrets.json cmac_key and server_salt validated and never shown; settings_hash over the merged settings without the 7 path keys and the 9 Not-in-settings_hash rows; constants_hash; canonical JSON), io/backup.py (online_backup through the sqlite3 backup API, verify_backup, backup_before_migration), cli.py (COMMANDS registry, seed-roster --db, backup-verify --file), host/tests/test_settings.py, host/tests/test_cli_backup.py; P11 is complete');
}
