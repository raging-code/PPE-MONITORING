"""cli.py (P11-2): offline maintenance commands. A command is one entry in COMMANDS: name -> (function(args) -> exit code, [(flag, argparse kwargs)]).
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
