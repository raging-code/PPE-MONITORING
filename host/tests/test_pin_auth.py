"""P28-3 (ADR 0056): PIN hashing, the per-operator lock, login sessions and Authenticator.authenticate() with a session token. Real migrated database, real scrypt, fake clock. Requirements: REQ-SEC-002, REQ-SEC-004, REQ-SEC-005."""
import pathlib
import pytest
from ppe_host.api import pin_auth as P, security as S
from ppe_host.io.db_writer import connect_db, run_migrations

MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
SALT = 'ab' * 32
T0 = 1_000_000
HOUR = 3600 * 1000

@pytest.fixture
def rig(tmp_path):
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(MIG), 1000)
    for oid, name, tok, active in ((1, 'Ana', 'tok-ana', 1), (2, 'Ben', 'tok-ben', 1), (3, 'Cy', 'tok-cy', 0)):
        c.execute('INSERT INTO operators(operator_id, display_name, token_hash, active, created_ts, token_issued_ts) VALUES (?, ?, ?, ?, 0, 0)', (oid, name, S.hash_token(SALT, tok), active))
    clock = [T0]; auth = S.Authenticator(db, SALT, 5, now_ms=lambda: clock[0]); return c, auth, clock
def row(c, oid): return c.execute('SELECT pin_hash, pin_salt, pin_fails, pin_locked_until, pin_set_ts FROM operators WHERE operator_id = ?', (oid,)).fetchone()
def names(op): return None if op is None else (op.operator_id, op.display_name)

def test_valid_pin_is_6_to_12_ascii_digits_only():
    for ok in ('123456', '000000', '123456789012'): assert S.valid_pin(ok)
    for bad in ('12345', '1234567890123', '12345a', ' 123456', '123456\n', '12 456', '', None, 123456, '\uff11\uff12\uff13\uff14\uff15\uff16'): assert not S.valid_pin(bad)

def test_hash_pin_is_salted_scrypt_and_verify_pin_checks_it():
    h1, s1 = S.hash_pin('482913'); h2, s2 = S.hash_pin('482913')
    assert len(h1) == 64 and len(s1) == 32 and s1 != s2 and h1 != h2 and '482913' not in h1 + s1
    assert S.verify_pin('482913', h1, s1) and not S.verify_pin('482914', h1, s1) and not S.verify_pin('482913', h1, s2) and not S.verify_pin('482913', 'zz', s1)

def test_set_pin_stores_only_hash_and_salt_clears_lock_and_revokes_sessions(rig):
    c, auth, clock = rig; tok, _, _ = P.create_session(c, SALT, 1, False, T0); c.execute('UPDATE operators SET pin_fails = 3, pin_locked_until = ? WHERE operator_id = 1', (T0 + 99,))
    P.set_pin(c, 1, '482913', T0 + 5); h, s, fails, locked, ts = row(c, 1)
    assert S.verify_pin('482913', h, s) and (fails, locked, ts) == (0, None, T0 + 5) and '482913' not in repr(c.execute('SELECT * FROM operators').fetchall())
    assert auth.authenticate(tok) is None and row(c, 2)[:2] == (None, None)       # Ana's session is gone, Ben is untouched

def test_set_pin_refuses_a_bad_pin_or_unknown_operator_and_changes_nothing(rig):
    c, _, _ = rig; P.set_pin(c, 1, '482913', T0); before = row(c, 1)
    for bad in ('1234', 'abcdef', None):
        with pytest.raises(ValueError): P.set_pin(c, 1, bad, T0 + 1)
    with pytest.raises(LookupError): P.set_pin(c, 99, '482913', T0 + 1)
    assert row(c, 1) == before and not c.in_transaction

def test_correct_pin_logs_in_and_resets_the_failure_count(rig):
    c, _, _ = rig; P.set_pin(c, 1, '482913', T0); c.execute('UPDATE operators SET pin_fails = 2 WHERE operator_id = 1')
    r = P.pin_login(c, 'Ana', '482913', T0); assert (r.status, names(r.operator), r.operator_id, r.retry_after_s, r.newly_locked) == ('ok', (1, 'Ana'), 1, None, False) and row(c, 1)[2] == 0

def test_every_kind_of_failure_is_the_same_rejected_answer(rig):
    c, _, _ = rig; P.set_pin(c, 1, '482913', T0); P.set_pin(c, 3, '482913', T0)       # Cy is disabled; Ben has no PIN
    cases = [('Ana', '000000'), ('Ana', 'abc'), ('Ana', None), ('Nobody', '482913'), ('Ben', '482913'), ('Cy', '482913'), (None, '482913'), ('ana', '482913')]
    for name, pin in cases:
        r = P.pin_login(c, name, pin, T0); assert (r.status, r.operator, r.retry_after_s, r.newly_locked) == ('rejected', None, None, False), (name, pin)
    assert row(c, 2)[2] == 0 and row(c, 3)[2] == 0 and row(c, 1)[2] == 3        # only Ana's three wrong PINs counted (000000, abc, None)

def test_fifth_wrong_pin_locks_for_15_minutes_then_it_clears_itself(rig):
    c, _, _ = rig; P.set_pin(c, 1, '482913', T0)
    for i in range(4): r = P.pin_login(c, 'Ana', '000000', T0 + i); assert r.status == 'rejected' and row(c, 1)[2] == i + 1
    r = P.pin_login(c, 'Ana', '000000', T0 + 10); assert (r.status, r.retry_after_s, r.newly_locked, r.operator_id) == ('locked', 900, True, 1)
    assert row(c, 1)[2:4] == (0, T0 + 10 + 15 * 60 * 1000)
    r = P.pin_login(c, 'Ana', '482913', T0 + 10 + 1000); assert (r.status, r.operator, r.newly_locked, r.retry_after_s) == ('locked', None, False, 899)    # the right PIN is refused while locked
    r = P.pin_login(c, 'Ana', '000000', T0 + 10 + 2000); assert r.status == 'locked' and r.newly_locked is False and row(c, 1)[3] == T0 + 10 + 900_000    # more wrong tries do not extend it
    r = P.pin_login(c, 'Ana', '482913', T0 + 10 + 900_000); assert (r.status, names(r.operator)) == ('ok', (1, 'Ana')) and row(c, 1)[2:4] == (0, None)

def test_a_success_resets_the_count_and_the_lock_is_per_operator(rig):
    c, _, _ = rig; P.set_pin(c, 1, '482913', T0); P.set_pin(c, 2, '715204', T0)
    for _ in range(3): P.pin_login(c, 'Ana', '000000', T0)
    assert P.pin_login(c, 'Ana', '482913', T0).status == 'ok'
    for _ in range(3): assert P.pin_login(c, 'Ana', '000000', T0).status == 'rejected'       # 3 + 3 with a success between: no lock
    for _ in range(5): P.pin_login(c, 'Ben', '000000', T0)
    assert P.pin_login(c, 'Ben', '715204', T0).status == 'locked' and P.pin_login(c, 'Ana', '482913', T0).status == 'ok'

def test_the_operator_token_still_works_while_the_pin_is_locked(rig):
    c, auth, _ = rig; P.set_pin(c, 1, '482913', T0)
    for _ in range(5): P.pin_login(c, 'Ana', '000000', T0)
    assert P.pin_login(c, 'Ana', '482913', T0 + 1).status == 'locked' and names(auth.authenticate('tok-ana')) == (1, 'Ana')       # break-glass (design 4: a lock must not blind the commander)

def test_session_token_authenticates_until_it_expires_and_only_its_hash_is_stored(rig):
    c, auth, clock = rig; tok, exp, sid = P.create_session(c, SALT, 1, True, T0); assert exp == T0 + 12 * HOUR and tok != 'tok-ana'
    stored = c.execute('SELECT operator_id, token_hash, created_ts, expires_ts, remember, revoked_ts FROM login_sessions WHERE login_session_id = ?', (sid,)).fetchone()
    assert stored == (1, S.hash_token(SALT, tok), T0, exp, 1, None) and tok not in repr(c.execute('SELECT * FROM login_sessions').fetchall())
    for t, ok in ((T0, True), (exp - 1, True), (exp, False), (exp + HOUR, False)): clock[0] = t; assert (names(auth.authenticate(tok)) == (1, 'Ana')) is ok
    clock[0] = T0; assert names(auth.authenticate('tok-ana')) == (1, 'Ana') and auth.authenticate('tok-ben') is not None and auth.authenticate('nope') is None   # operator tokens never expire

def test_session_hours_and_remember_are_stored(rig):
    c, auth, clock = rig; tok, exp, sid = P.create_session(c, SALT, 2, False, T0, hours=1.5); assert exp == T0 + 90 * 60 * 1000
    assert c.execute('SELECT remember FROM login_sessions WHERE login_session_id = ?', (sid,)).fetchone() == (0,) and names(auth.authenticate(tok)) == (2, 'Ben')

def test_logout_revokes_only_that_session(rig):
    c, auth, clock = rig; a, _, _ = P.create_session(c, SALT, 1, False, T0); b, _, _ = P.create_session(c, SALT, 1, False, T0); d, _, _ = P.create_session(c, SALT, 2, False, T0)
    assert P.revoke_session(c, SALT, a, T0 + 5) is True and auth.authenticate(a) is None and names(auth.authenticate(b)) == (1, 'Ana') and names(auth.authenticate(d)) == (2, 'Ben')
    assert P.revoke_session(c, SALT, a, T0 + 6) is False and P.revoke_session(c, SALT, 'tok-ana', T0 + 6) is False and P.revoke_session(c, SALT, 'nope', T0 + 6) is False
    assert c.execute('SELECT revoked_ts FROM login_sessions WHERE revoked_ts IS NOT NULL').fetchall() == [(T0 + 5,)]       # the first revoke time is kept

def test_disabling_an_operator_stops_its_sessions_at_once_and_revoke_operator_sessions_counts(rig):
    c, auth, clock = rig; a, _, _ = P.create_session(c, SALT, 1, False, T0); b, _, _ = P.create_session(c, SALT, 1, False, T0); d, _, _ = P.create_session(c, SALT, 2, False, T0)
    c.execute('UPDATE operators SET active = 0 WHERE operator_id = 1'); assert auth.authenticate(a) is None and auth.authenticate(b) is None and auth.authenticate('tok-ana') is None and names(auth.authenticate(d)) == (2, 'Ben')
    c.execute('UPDATE operators SET active = 1 WHERE operator_id = 1'); assert P.revoke_operator_sessions(c, 1, T0 + 1) == 2 and P.revoke_operator_sessions(c, 1, T0 + 2) == 0 and auth.authenticate(a) is None and names(auth.authenticate(d)) == (2, 'Ben')

def test_a_session_token_hashed_with_another_salt_is_refused(rig):
    c, auth, _ = rig; tok, _, _ = P.create_session(c, 'cd' * 32, 1, False, T0); assert auth.authenticate(tok) is None

def test_authenticator_without_a_clock_uses_the_wall_clock(rig):
    c, _, _ = rig; db = c.execute('PRAGMA database_list').fetchone()[2]; import time
    real = S.Authenticator(db, SALT, 5); tok, _, _ = P.create_session(c, SALT, 1, False, int(time.time() * 1000)); assert names(real.authenticate(tok)) == (1, 'Ana')
