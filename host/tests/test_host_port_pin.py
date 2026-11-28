"""P28-4a (ADR 0056): HostPort.pin_login, start_login_session and logout through the real writer queue (Ingest.write), the way the running host does them. Real DBWriter, database, scrypt, Authenticator and FakeClock.
Requirements: REQ-SEC-002, REQ-SEC-004, REQ-SEC-005."""
from ppe_host.api import pin_auth as P, security as sec
from ppe_host.host_port import HostPort
from test_effect_rows import op
from test_host_port import S, SALT, settle
from test_ingest import rig, rows

PIN, HOUR = '482913', 3600 * 1000
def hp(tmp_path):
    c, w, clock, ing = rig(tmp_path); op(c, 1); op(c, 2)
    c.execute('UPDATE operators SET display_name = ?, token_hash = ? WHERE operator_id = 1', ('Ana', sec.hash_token(SALT, 'tok-ana')))
    for stmt in P.plan_set_pin(1, PIN, ing.clock.wall_ms()): c.execute(*stmt)
    return c, w, ing, HostPort(ing, tmp_path / 't.db', S, sec.Authenticator(tmp_path / 't.db', SALT, 5, now_ms=ing.clock.wall_ms))
def fails(c): return tuple(c.execute('SELECT pin_fails, pin_locked_until FROM operators WHERE operator_id = 1').fetchone())

def test_pin_login_counts_wrong_pins_through_the_writer_and_the_fifth_starts_the_lock(tmp_path):
    c, w, ing, p = hp(tmp_path); now = ing.clock.wall_ms()
    assert p.pin_login('Ana', PIN).status == 'ok' and p.pin_login('Nobody', PIN).status == 'rejected' and fails(c) == (0, None)
    for i in range(4): assert p.pin_login('Ana', '000001').status == 'rejected' and fails(c) == (i + 1, None)      # committed before the answer, no settle needed
    r = p.pin_login('Ana', '000001'); assert (r.status, r.newly_locked, r.retry_after_s) == ('locked', True, 900) and fails(c) == (0, now + 15 * 60 * 1000)
    r = p.pin_login('Ana', PIN); assert (r.status, r.newly_locked) == ('locked', False)
    ing.clock.advance(15 * 60 * 1000 + 1); assert p.pin_login('Ana', PIN).status == 'ok' and fails(c) == (0, None)
    w.stop()

def test_a_login_session_is_committed_before_the_token_is_returned_and_logout_revokes_it(tmp_path):
    c, w, ing, p = hp(tmp_path); now = ing.clock.wall_ms(); token, expires = p.start_login_session(1, True)
    assert expires == now + 12 * HOUR and p.authenticate(token).operator_id == 1      # the very next request with the token is accepted
    assert [tuple(x) for x in c.execute('SELECT operator_id, remember, expires_ts, revoked_ts FROM login_sessions').fetchall()] == [(1, 1, expires, None)] and token not in str(c.execute('SELECT * FROM login_sessions').fetchall())
    assert p.logout('tok-ana') is False and p.authenticate('tok-ana').operator_id == 1 and p.logout('nope') is False      # an operator token or an unknown token has nothing to revoke
    assert p.logout(token) is True and p.authenticate(token) is None and p.logout(token) is False
    assert c.execute('SELECT revoked_ts FROM login_sessions').fetchone()[0] == now; w.stop()

def test_a_session_expires_by_the_host_clock(tmp_path):
    c, w, ing, p = hp(tmp_path); token, expires = p.start_login_session(1, False)
    ing.clock.advance(12 * HOUR - 1); assert p.authenticate(token) is not None
    ing.clock.advance(2); assert p.authenticate(token) is None; w.stop()

def test_the_new_audit_actions_are_accepted_by_the_writer(tmp_path):
    c, w, ing, p = hp(tmp_path); p.audit('LOGIN_LOCKED', operator_id=1, reason='pin'); p.audit('LOGOUT', operator_id=1, reason='session'); p.audit('LOGIN_OK', operator_id=1, reason='pin'); settle(w, ing)
    assert [x['action'] for x in rows(c, 'SELECT action FROM audit_events ORDER BY event_seq')] == ['LOGIN_LOCKED', 'LOGOUT', 'LOGIN_OK'] and w.counters['write_rejected'] == 0; w.stop()
def test_the_session_length_follows_the_session_hours_setting(tmp_path):
    c, w, ing, p = hp(tmp_path); now = ing.clock.wall_ms(); p.settings = {**S, 'session_hours': 2}
    token, expires = p.start_login_session(1, False); assert expires == now + 2 * HOUR
    ing.clock.advance(2 * HOUR - 1); assert p.authenticate(token) is not None
    ing.clock.advance(2); assert p.authenticate(token) is None; w.stop()
