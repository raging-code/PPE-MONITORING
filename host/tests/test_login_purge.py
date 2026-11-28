"""P28-7 (ADR 0056): cli purge-login-sessions. Real migrated database in a temporary PPE_HOME; the host lockfile is this very process. Requirements: REQ-SEC-002, REQ-SEC-005."""
import json, os
import pytest
from ppe_host import cli
from ppe_host.io.db_writer import connect_db
from ppe_host.main import LOCK_NAME, process_start
from ppe_host.services import login_purge as L

DAY = L.DAY_MS
NOW = 1_000 * DAY                                        # a fixed "now" for the service; the CLI uses the real clock, so its tests use rows far in the past or future

@pytest.fixture
def env(tmp_path):
    home, db = tmp_path / 'home', tmp_path / 'ops.db'
    assert cli.main(['create-operator', '--name', 'Ana', '--home', str(home), '--db', str(db)]) == 0
    return home, db

def run(env, *args):
    home, db = env; return cli.main(['purge-login-sessions'] + list(args) + ['--home', str(home), '--db', str(db)])

def add(db, n, created, expires, revoked=None, operator=1):
    c = connect_db(db); c.execute('INSERT INTO login_sessions(operator_id, token_hash, created_ts, expires_ts, remember, revoked_ts) VALUES (?, ?, ?, ?, 0, ?)', (operator, 'h%d' % n, created, expires, revoked)); c.commit(); c.close()

def hashes(db):
    c = connect_db(db, readonly=True); r = sorted(x[0] for x in c.execute('SELECT token_hash FROM login_sessions')); c.close(); return r

def test_the_service_deletes_only_sessions_dead_longer_than_the_days(env):
    _, db = env
    add(db, 1, 1 * DAY, 2 * DAY)                         # expired on day 2: dead for 998 days
    add(db, 2, 900 * DAY, 901 * DAY)                     # expired on day 901: dead for 99 days
    add(db, 3, 960 * DAY, 970 * DAY)                     # expired on day 970: dead for 30 days exactly: kept (not MORE than 30)
    add(db, 4, 990 * DAY, 999 * DAY + 1)                 # expired a moment before now + 1: dead for less than a day
    n, kept = L.purge_old(db, NOW, 30); assert (n, kept) == (2, 2) and hashes(db) == ['h3', 'h4']

def test_a_session_revoked_early_is_dead_from_the_revocation_not_from_its_expiry(env):
    _, db = env
    add(db, 1, 1 * DAY, 2000 * DAY, revoked=10 * DAY)    # would expire far in the future, but was logged out on day 10
    add(db, 2, 1 * DAY, 5 * DAY, revoked=999 * DAY)      # expired on day 5, "revoked" later: dead since day 5 (the earlier of the two)
    n, kept = L.purge_old(db, NOW, 30); assert (n, kept) == (2, 0)

def test_a_live_session_is_never_deleted_even_with_zero_days(env):
    _, db = env
    add(db, 1, 999 * DAY, 1001 * DAY)                    # not revoked, expires after now
    add(db, 2, 1 * DAY, 2 * DAY)
    n, kept = L.purge_old(db, NOW, 0); assert (n, kept) == (1, 1) and hashes(db) == ['h1']

def test_dry_run_counts_and_changes_nothing(env):
    _, db = env; add(db, 1, 1 * DAY, 2 * DAY); add(db, 2, 1 * DAY, 3 * DAY)
    assert L.purge_old(db, NOW, 30, dry_run=True) == (2, 2) and hashes(db) == ['h1', 'h2']

def test_a_negative_number_of_days_is_refused(env):
    with pytest.raises(ValueError): L.purge_old(env[1], NOW, -1)

def test_the_command_deletes_old_rows_prints_the_count_and_leaves_the_operator_and_the_audit_rows(env, capsys):
    home, db = env; add(db, 1, 1 * DAY, 2 * DAY); add(db, 2, 1 * DAY, 3 * DAY)
    c = connect_db(db, readonly=True); ops, audits = c.execute('SELECT COUNT(*) FROM operators').fetchone()[0], c.execute('SELECT COUNT(*) FROM audit_events').fetchone()[0]; c.close()
    capsys.readouterr(); assert run(env) == 0
    assert 'deleted 2 login session(s) dead for more than 30 day(s); 0 row(s) remain' in capsys.readouterr().out and hashes(db) == []
    c = connect_db(db, readonly=True); assert (c.execute('SELECT COUNT(*) FROM operators').fetchone()[0], c.execute('SELECT COUNT(*) FROM audit_events').fetchone()[0]) == (ops, audits); c.close()

def test_the_command_keeps_a_session_that_has_not_been_dead_long_enough(env, capsys):
    import time
    _, db = env; now = int(time.time() * 1000)
    add(db, 1, now - 5 * DAY, now - 4 * DAY); add(db, 2, now + 1000, now + 2000)
    assert run(env, '--older-than-days', '30') == 0 and hashes(db) == ['h1', 'h2']
    capsys.readouterr(); assert run(env, '--older-than-days', '1') == 0 and hashes(db) == ['h2'] and 'deleted 1 login session(s)' in capsys.readouterr().out

def test_the_command_dry_run_says_would_delete_and_changes_nothing(env, capsys):
    _, db = env; add(db, 1, 1 * DAY, 2 * DAY); capsys.readouterr()
    assert run(env, '--dry-run') == 0; out = capsys.readouterr().out
    assert 'would delete 1 login session(s)' in out and 'dry run, nothing changed' in out and hashes(db) == ['h1']

def test_a_live_host_lockfile_refuses_the_command_and_a_stale_one_does_not(env, capsys):
    home, db = env; add(db, 1, 1 * DAY, 2 * DAY); tok = process_start(os.getpid())
    if tok is None: pytest.skip('no process table on this platform')
    (home / LOCK_NAME).write_text(json.dumps({'pid': os.getpid(), 'start': tok})); capsys.readouterr()
    assert run(env) == 1 and 'the host is running' in capsys.readouterr().err and hashes(db) == ['h1']
    (home / LOCK_NAME).write_text(json.dumps({'pid': os.getpid(), 'start': -1})); assert run(env) == 0 and hashes(db) == []

def test_a_negative_days_value_a_missing_database_and_a_missing_table_exit_1(env, capsys, tmp_path):
    assert run(env, '--older-than-days', '-1') == 1 and '0 or more' in capsys.readouterr().err
    home = env[0]; assert cli.main(['purge-login-sessions', '--home', str(home), '--db', str(tmp_path / 'none.db')]) == 1 and 'not found' in capsys.readouterr().err
    old = tmp_path / 'old.db'; c = connect_db(old); c.execute('CREATE TABLE t(x)'); c.commit(); c.close()
    assert cli.main(['purge-login-sessions', '--home', str(home), '--db', str(old)]) == 1 and 'no login_sessions table' in capsys.readouterr().err
