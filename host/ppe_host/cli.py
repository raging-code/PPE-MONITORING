"""cli.py (P11-2): offline maintenance commands. A command is one entry in COMMANDS: name -> (function(args) -> exit code, [(flag, argparse kwargs)]).
Later parts add commands with replace on the marker line inside COMMANDS. Run: python -m ppe_host.cli <command> ..."""
import argparse
import sys
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
}

# ---- P19b-2: operator commands (design 2.8 and 4). Offline: their audit rows have session_id NULL and event_seq 0, as 2.3 says for CLI actions.
# The token is printed once, never stored (only its HMAC) and never logged. cli ack --node needs the running host and is not here (docs/adr/0009.md). ----
import sqlite3, time
from .settings import SettingsError, load_settings
OPERATOR_FLAGS = [('--home', {'help': 'PPE_HOME (default: the PPE_HOME variable, else the repository folder)'}), ('--db', {'help': 'database file (default: db_path of the settings)'})]
def _open(a, create):
    s = load_settings(a.home); db = Path(a.db) if a.db else s.path('db_path')
    if not create and not db.exists(): raise SettingsError('database file not found: %s' % db)
    db.parent.mkdir(parents=True, exist_ok=True); conn = connect_db(db)
    if not applied_versions(conn):
        if not create: conn.close(); raise SettingsError('database has no schema: %s' % db)
        run_migrations(conn, str(MIGRATIONS_DIR), int(time.time() * 1000))
    return s.home, conn
def _write_with_audit(conn, action, write):
    """One transaction: write() changes operators and returns the operator_id; then the audit row (session_id NULL, event_seq 0, operator_id NULL, reason names the operator)."""
    conn.execute('BEGIN IMMEDIATE')
    try:
        oid = write(); conn.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, reason) VALUES (NULL, 0, ?, NULL, ?, ?)', (int(time.time() * 1000), action, 'operator_id %d' % oid)); conn.execute('COMMIT'); return oid
    except BaseException: conn.execute('ROLLBACK'); raise
def _fail(cmd, msg): print('%s: %s' % (cmd, msg), file=sys.stderr); return 1
def _salt(home, conn):
    from .api import security as sec
    return sec.load_or_create_salt(home, conn.execute('SELECT COUNT(*) FROM operators').fetchone()[0] > 0)

def cmd_create_operator(a):
    from .api import security as sec
    name = (a.name or '').strip()
    if not name: return _fail('create-operator', '--name must not be empty')
    try:
        home, conn = _open(a, True)
        try:
            salt, token, now = _salt(home, conn), sec.new_token(), int(time.time() * 1000)
            def write(): return conn.execute('INSERT INTO operators(display_name, token_hash, active, created_ts, token_issued_ts) VALUES (?, ?, 1, ?, ?)', (name, sec.hash_token(salt, token), now, now)).lastrowid
            oid = _write_with_audit(conn, 'OPERATOR_ADDED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('create-operator', str(e))
    except sqlite3.IntegrityError: return _fail('create-operator', 'an operator named %r already exists' % name)
    print('create-operator: operator_id %d (%s)\nTOKEN (shown once, only its hash is stored): %s' % (oid, name, token)); return 0

def _existing(a, cmd):
    """(home, conn, row) of the operator --operator-id, or an exit code."""
    home, conn = _open(a, False)
    row = conn.execute('SELECT display_name, active FROM operators WHERE operator_id = ?', (a.operator_id,)).fetchone()
    if row is None: conn.close(); raise SettingsError('no operator with operator_id %d' % a.operator_id)
    return home, conn, row
def cmd_rotate_token(a):
    from .api import security as sec
    try:
        home, conn, (name, active) = _existing(a, 'rotate-token')
        try:
            if not active: raise SettingsError('operator %d (%s) is disabled; a disabled operator gets no new token' % (a.operator_id, name))
            salt, token, now = _salt(home, conn), sec.new_token(), int(time.time() * 1000)
            def write(): conn.execute('UPDATE operators SET token_hash = ?, token_issued_ts = ? WHERE operator_id = ?', (sec.hash_token(salt, token), now, a.operator_id)); return a.operator_id
            _write_with_audit(conn, 'TOKEN_ROTATED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('rotate-token', str(e))
    print('rotate-token: operator_id %d (%s), the old token no longer works\nTOKEN (shown once, only its hash is stored): %s' % (a.operator_id, name, token)); return 0
def cmd_disable_operator(a):
    try:
        home, conn, (name, active) = _existing(a, 'disable-operator')
        try:
            if active:
                def write(): conn.execute('UPDATE operators SET active = 0 WHERE operator_id = ?', (a.operator_id,)); return a.operator_id
                _write_with_audit(conn, 'OPERATOR_DISABLED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('disable-operator', str(e))
    print('disable-operator: operator_id %d (%s) %s' % (a.operator_id, name, 'is disabled' if active else 'was already disabled, nothing changed')); return 0

COMMANDS.update({
    'create-operator': (cmd_create_operator, [('--name', {'required': True, 'help': 'display name shown in the audit log'})] + OPERATOR_FLAGS),
    'rotate-token': (cmd_rotate_token, [('--operator-id', {'type': int, 'required': True})] + OPERATOR_FLAGS),
    'disable-operator': (cmd_disable_operator, [('--operator-id', {'type': int, 'required': True})] + OPERATOR_FLAGS),
})
# ---- P23b: test-alarm, the shift speaker check of design 3.12 (offline; plays the siren, the beep and the host chime) ----
def cmd_test_alarm(a):
    from .io import audio_watchdog as aw
    ok, msg = aw.run_test_alarm(aw.WinsoundBackend(), a.seconds)
    print('test-alarm: ' + msg, file=sys.stdout if ok else sys.stderr); return 0 if ok else 1
COMMANDS['test-alarm'] = (cmd_test_alarm, [('--seconds', {'type': int, 'default': 3, 'help': 'how long the siren plays'})])
# ---- P26-2: purge-session (design 2.8, 2.11; ADR 0039). Offline only. Exit codes: 0 purged, 1 refused or not found (nothing recorded), 2 refused with an audit row (open alert or episode, foreign key) or a copy that could not be purged ----
def cmd_purge_session(a):
    from .services import purge as P
    from .main import LOCK_NAME, Lockfile                       # imported here: main imports this module
    cmd, sid = 'purge-session', a.session_id
    try: s = load_settings(a.home); db = Path(a.db) if a.db else s.path('db_path')
    except SettingsError as e: return _fail(cmd, str(e))
    lock = s.home / LOCK_NAME
    if Lockfile.holder_alive(lock): return _fail(cmd, 'the host is running (lockfile %s): stop it first' % lock)
    if not db.exists(): return _fail(cmd, 'database file not found: %s' % db)
    export_dir = Path(a.export_dir) if a.export_dir else s.home / 'exports'; backup_dir = Path(a.backup_dir) if a.backup_dir else s.path('backup_dir')
    try:
        conn = connect_db(db)
        try: present = P.session_row(conn, sid) is not None
        finally: conn.close()
    except sqlite3.Error as e: return _fail(cmd, 'cannot read %s: %s' % (db, e))
    done, failed, removed = [], [], 0
    if present:
        try: counts = P.purge_live(db, sid)
        except P.Refused as e:
            if e.audit:
                try: P.write_refusal(db, sid, e.message)
                except sqlite3.Error as w: print('%s: the refusal could not be recorded: %s' % (cmd, w), file=sys.stderr)
            return _fail(cmd, 'refused: ' + e.message) if e.code == 1 else (print('%s: refused: %s' % (cmd, e.message), file=sys.stderr) or 2)
        except sqlite3.Error as e: return _fail(cmd, 'the purge failed and was rolled back: %s: %s' % (type(e).__name__, e))
        removed += 1; done.append('live database %s: %d frame(s), %d alert(s), %d episode(s), %d audit row(s) deleted, compacted' % (db, counts['frames'], counts['alerts'], counts['episodes'], counts['audit_events']))
    else: print('%s: session %d is not in %s (already purged?); sweeping the copies and exports' % (cmd, sid, db))
    explicit = [Path(d) for d in (a.usb_dir or [])]
    for d, files in P.copies([backup_dir] + explicit, db):
        if files is None:
            if d in explicit: failed.append('%s does not exist (drive not connected?)' % d)
            continue
        for f in files:
            st, detail = P.purge_copy(f, sid)
            if st == 'purged': removed += 1; done.append('copy %s: purged (%s)' % (f, detail))
            elif st == 'failed': failed.append('copy %s: %s' % (f, detail))
            elif st == 'skipped': done.append('copy %s: skipped (%s)' % (f, detail))
    try: gone, whole = P.sweep_exports(export_dir, sid)
    except OSError as e: gone, whole = [], []; failed.append('exports: %s' % e)
    if gone: removed += 1; done.append('exports: deleted %s' % ', '.join(gone))
    if whole: print('%s: warning: whole-database exports in %s may still hold session %d: %s' % (cmd, export_dir, sid, ', '.join(whole)), file=sys.stderr)
    if not removed and not failed: return _fail(cmd, 'session %d was found in no database, backup or export' % sid)
    if not present and removed:
        try: P.audit_row(db, str(sid))
        except sqlite3.Error as w: failed.append('the audit row could not be written: %s' % w)
    for line in done: print('%s: %s' % (cmd, line))
    for line in failed: print('%s: FAILED %s' % (cmd, line), file=sys.stderr)
    print('%s: session %d %s' % (cmd, sid, 'purged, but not everywhere: run it again after fixing the above' if failed else 'purged')); return 2 if failed else 0
COMMANDS['purge-session'] = (cmd_purge_session, [('--session-id', {'type': int, 'required': True, 'help': 'the closed session to delete'}), ('--export-dir', {'help': 'folder with session_<id>_*.csv (default: exports/ in PPE_HOME)'}),
    ('--backup-dir', {'help': 'local backups (default: backup_dir of the settings)'}), ('--usb-dir', {'action': 'append', 'help': 'a backup folder on an external drive; repeat for more'})] + OPERATOR_FLAGS)
def main(argv=None):
    p = argparse.ArgumentParser(prog='ppe_host.cli'); sub = p.add_subparsers(dest='command', required=True)
    for name, (_, flags) in COMMANDS.items():
        sp = sub.add_parser(name)
        for flag, kw in flags: sp.add_argument(flag, **kw)
    a = p.parse_args(argv)
    return COMMANDS[a.command][0](a)

if __name__ == '__main__': sys.exit(main())
