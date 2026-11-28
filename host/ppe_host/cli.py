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
# The token is printed once, never stored (only its HMAC) and never logged. cli ack --node needs the running host and is at the end of this file (P24-5c, ADR 0048; ADR 0009 explains why it is not an offline command). ----
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
    from .api import pin_auth, security as sec
    try:
        home, conn, (name, active) = _existing(a, 'rotate-token')
        try:
            if not active: raise SettingsError('operator %d (%s) is disabled; a disabled operator gets no new token' % (a.operator_id, name))
            salt, token, now = _salt(home, conn), sec.new_token(), int(time.time() * 1000)
            ended = []      # P28-4b: the login sessions of the operator end with the old token
            def write(): conn.execute('UPDATE operators SET token_hash = ?, token_issued_ts = ? WHERE operator_id = ?', (sec.hash_token(salt, token), now, a.operator_id)); ended.append(pin_auth.revoke_operator_sessions(conn, a.operator_id, now)); return a.operator_id
            _write_with_audit(conn, 'TOKEN_ROTATED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('rotate-token', str(e))
    print('rotate-token: operator_id %d (%s), the old token no longer works\n%sTOKEN (shown once, only its hash is stored): %s' % (a.operator_id, name, '%d login session(s) ended\n' % ended[0] if ended[0] else '', token)); return 0
def cmd_disable_operator(a):
    from .api import pin_auth
    try:
        home, conn, (name, active) = _existing(a, 'disable-operator')
        try:
            if active:
                def write(): conn.execute('UPDATE operators SET active = 0 WHERE operator_id = ?', (a.operator_id,)); pin_auth.revoke_operator_sessions(conn, a.operator_id, int(time.time() * 1000)); return a.operator_id      # P28-4b: and its login sessions
                _write_with_audit(conn, 'OPERATOR_DISABLED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('disable-operator', str(e))
    print('disable-operator: operator_id %d (%s) %s' % (a.operator_id, name, 'is disabled' if active else 'was already disabled, nothing changed')); return 0

def cmd_set_pin(a):
    """P28-4b (ADR 0056): set or reset the PIN of an operator. The PIN is random (--length digits, 6 by default) and shown once, or typed twice and hidden with --prompt. It is never an argument, never logged and never stored: only its scrypt hash is.
    The failure count and the lock are cleared, the operator's login sessions end, and PIN_SET is written (offline row: session_id NULL, event_seq 0)."""
    import secrets
    from .api import pin_auth, security as sec
    cmd = 'set-pin'
    try:
        if a.prompt:
            import getpass
            pin = getpass.getpass('new PIN (6 to 12 digits): ')
            if getpass.getpass('repeat the PIN: ') != pin: raise SettingsError('the two PINs differ; nothing changed')
        else:
            if not 6 <= a.length <= 12: raise SettingsError('--length must be 6 to 12')
            pin = ''.join(secrets.choice('0123456789') for _ in range(a.length))
        if not sec.valid_pin(pin): raise SettingsError('a PIN is 6 to 12 digits; nothing changed')
        home, conn, (name, active) = _existing(a, cmd)
        try:
            if not active: raise SettingsError('operator %d (%s) is disabled; a disabled operator gets no PIN' % (a.operator_id, name))
            now, ended = int(time.time() * 1000), []
            def write():
                first, second = pin_auth.plan_set_pin(a.operator_id, pin, now); conn.execute(*first); ended.append(conn.execute(*second).rowcount); return a.operator_id
            _write_with_audit(conn, 'PIN_SET', write)
        finally: conn.close()
    except SettingsError as e: return _fail(cmd, str(e))
    note = '%d login session(s) ended\n' % ended[0] if ended[0] else ''
    print('set-pin: operator_id %d (%s)\n%s' % (a.operator_id, name, note) + ('PIN set (typed by you, not shown)' if a.prompt else 'PIN (shown once, only its hash is stored): %s' % pin)); return 0

COMMANDS.update({
    'set-pin': (cmd_set_pin, [('--operator-id', {'type': int, 'required': True}), ('--length', {'type': int, 'default': 6, 'help': 'digits of the random PIN, 6 to 12'}), ('--prompt', {'action': 'store_true', 'help': 'type the PIN twice (hidden) instead of a random one'})] + OPERATOR_FLAGS),
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
    from .io import backup as B
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
    drive = B.second_drive_dir(s)                                                         # the second drive of the settings is always swept (ADR 0040); a missing drive is exit 2
    if drive is not None and drive not in explicit: explicit.append(drive)
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
# ---- P24-5b: doctor, the pre-shift check of design 1 (ADR 0047). Changes nothing. Exit 0 when no check failed, 1 when one did ----
def cmd_doctor(a):
    from .services import doctor as D
    lines, ok = D.format_rows(D.run_checks(a.home, a.db))
    print('\n'.join(lines)); return 0 if ok else 1
COMMANDS['doctor'] = (cmd_doctor, list(OPERATOR_FLAGS))
# ---- P28-7: purge-login-sessions (ADR 0056). Offline only (the host writes login_sessions). Exit 0 done or nothing to do, 1 refused or cannot run ----
def cmd_purge_login_sessions(a):
    from .services import login_purge as L
    from .main import LOCK_NAME, Lockfile                       # imported here: main imports this module
    cmd = 'purge-login-sessions'
    try: s = load_settings(a.home); db = Path(a.db) if a.db else s.path('db_path')
    except SettingsError as e: return _fail(cmd, str(e))
    if a.older_than_days < 0: return _fail(cmd, '--older-than-days must be 0 or more')
    lock = s.home / LOCK_NAME
    if Lockfile.holder_alive(lock): return _fail(cmd, 'the host is running (lockfile %s): stop it first' % lock)
    if not db.exists(): return _fail(cmd, 'database file not found: %s' % db)
    try: n, kept = L.purge_old(db, int(time.time() * 1000), a.older_than_days, a.dry_run)
    except LookupError as e: return _fail(cmd, str(e))
    except sqlite3.Error as e: return _fail(cmd, 'failed and rolled back: %s: %s' % (type(e).__name__, e))
    print('%s: %s %d login session(s) dead for more than %d day(s); %d row(s) remain%s' % (cmd, 'would delete' if a.dry_run else 'deleted', n, a.older_than_days, kept, ' (dry run, nothing changed)' if a.dry_run else '')); return 0
COMMANDS['purge-login-sessions'] = (cmd_purge_login_sessions, [('--older-than-days', {'type': int, 'default': 30, 'help': 'delete sessions that have been expired or revoked for more than this many days (default 30; live sessions are never deleted)'}),
    ('--dry-run', {'action': 'store_true', 'help': 'count only, change nothing'})] + OPERATOR_FLAGS)
# ---- P24-5c: ack --node N, the CLI stop test of design 8 (ADR 0048). Needs the running host: it calls POST /api/alerts/{id}/ack for each open alert of the node, with the token in PPE_TOKEN ----
def cmd_ack(a):
    import os
    from .services import ack_node as K
    try: s = load_settings(a.home); db = Path(a.db) if a.db else s.path('db_path' if a.mode == 'LIVE' else 'test_db_path')       # the database of the running host: the host uses test_db_path in every mode but LIVE
    except SettingsError as e: return _fail('ack', str(e))
    code, out, err = K.run_ack(db, a.node, os.environ.get(K.TOKEN_VAR, '').strip(), K.base_url(s))
    for line in out: print(line)
    for line in err: print(line, file=sys.stderr)
    return code
COMMANDS['ack'] = (cmd_ack, [('--node', {'type': int, 'required': True, 'help': 'node id whose open alerts are acknowledged (the operator token is read from the PPE_TOKEN variable)'}),
    ('--mode', {'choices': ['LIVE', 'SIMULATOR', 'REPLAY'], 'default': 'LIVE', 'help': 'the mode the host was started with (python -m ppe_host.main --mode); it decides which database the host writes'})] + OPERATOR_FLAGS)
# ---- S8-1 (ADR 0070): who wears the PPE (offline; firefighter profiles with consent, the node assignment, the roster on/off switch) ----
def _ff_run(a, cmd, fn):
    from .services import firefighters as ffs
    try:
        home, conn = _open(a, False)
        try: return fn(ffs, conn, int(time.time() * 1000))
        finally: conn.close()
    except (SettingsError, ffs.FirefighterError) as e: return _fail(cmd, str(e))
def cmd_add_firefighter(a):
    def go(ffs, conn, now):
        fid, alias = ffs.add_firefighter(conn, now, full_name=a.name, age_years=a.age, height_cm=a.height_cm, weight_kg=a.weight_kg, resting_hr=a.resting_hr, smoker=a.smoker == 'yes', consent=a.consent,
                                         consent_form_version=a.consent_form_version, consent_witness=a.consent_witness, consent_date=a.consent_date, sex=a.sex, max_hr=a.max_hr, years_service=a.years_service)
        print('add-firefighter: firefighter_id %d, alias %s (the name is stored for the Settings screen and is not shown anywhere else)' % (fid, alias)); return 0
    return _ff_run(a, 'add-firefighter', go)
def cmd_list_firefighters(a):
    def go(ffs, conn, now):
        rows = ffs.list_firefighters(conn, a.show_names)
        if not rows: print('list-firefighters: none'); return 0
        for r in rows: print(' '.join('%s=%s' % (k, '' if v is None else v) for k, v in r.items()))
        return 0
    return _ff_run(a, 'list-firefighters', go)
def cmd_assign_firefighter(a):
    def go(ffs, conn, now):
        r = ffs.assign(conn, now, a.node, a.firefighter_id); print('assign-firefighter: node %d, %s' % (a.node, r)); return 0
    return _ff_run(a, 'assign-firefighter', go)
def cmd_set_roster(a):
    def go(ffs, conn, now):
        r = ffs.set_roster_active(conn, now, a.node, a.active); print('set-roster: node %d active=%d, %s (takes effect at the next host start)' % (a.node, a.active, r)); return 0
    return _ff_run(a, 'set-roster', go)
COMMANDS.update({
    'add-firefighter': (cmd_add_firefighter, [('--name', {'required': True, 'help': 'full name, stored for the Settings screen only; the alias FFR-NN is what everything else shows'}), ('--age', {'type': int, 'required': True}), ('--height-cm', {'type': int, 'required': True}),
        ('--weight-kg', {'type': float, 'required': True}), ('--resting-hr', {'type': int, 'required': True, 'help': 'resting heart rate in beats per minute'}), ('--smoker', {'choices': ['yes', 'no'], 'required': True}),
        ('--sex', {'choices': ['F', 'M', 'X']}), ('--max-hr', {'type': int, 'help': 'measured maximum heart rate (optional)'}), ('--years-service', {'type': float, 'help': 'years as a firefighter (optional)'}),
        ('--consent', {'action': 'store_true', 'help': 'the person has agreed; required'}), ('--consent-date', {'help': 'YYYY-MM-DD (default today)'}), ('--consent-form-version', {'required': True}), ('--consent-witness', {'required': True})] + OPERATOR_FLAGS),
    'list-firefighters': (cmd_list_firefighters, [('--show-names', {'action': 'store_true', 'help': 'also print the full names'})] + OPERATOR_FLAGS),
    'assign-firefighter': (cmd_assign_firefighter, [('--node', {'type': int, 'required': True}), ('--firefighter-id', {'type': int, 'help': 'leave out to end the node\'s assignment'})] + OPERATOR_FLAGS),
    'set-roster': (cmd_set_roster, [('--node', {'type': int, 'required': True}), ('--active', {'type': int, 'choices': [0, 1], 'required': True})] + OPERATOR_FLAGS),
})
def main(argv=None):
    p = argparse.ArgumentParser(prog='ppe_host.cli'); sub = p.add_subparsers(dest='command', required=True)
    for name, (_, flags) in COMMANDS.items():
        sp = sub.add_parser(name)
        for flag, kw in flags: sp.add_argument(flag, **kw)
    a = p.parse_args(argv)
    return COMMANDS[a.command][0](a)

if __name__ == '__main__': sys.exit(main())
