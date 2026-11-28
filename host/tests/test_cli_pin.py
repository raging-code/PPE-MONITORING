"""P28-4b (ADR 0056): cli set-pin, and the login sessions that rotate-token and disable-operator end. Real migrated database, real scrypt, a temporary PPE_HOME. Requirements: REQ-SEC-002, REQ-SEC-004, REQ-SEC-005."""
import json
import pytest
from ppe_host import cli
from ppe_host.api import pin_auth as P, security as S
from ppe_host.io.db_writer import connect_db, init_event_seq

@pytest.fixture
def env(tmp_path):
    home, db = tmp_path / 'home', tmp_path / 'ops.db'; return home, db
def run(env, *args):
    home, db = env; return cli.main(list(args) + ['--home', str(home), '--db', str(db)])
def salt(env): return json.loads((env[0] / 'config' / 'secrets.json').read_text())['server_salt']
def rows(env, sql, *p): c = connect_db(env[1], readonly=True); r = c.execute(sql, p).fetchall(); c.close(); return r
def pin_of(capsys):
    out = capsys.readouterr().out; assert 'shown once' in out; return out.split('PIN (shown once, only its hash is stored): ')[1].strip()
def token_of(capsys): return capsys.readouterr().out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()
def two_operators(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); ta = token_of(capsys); run(env, 'create-operator', '--name', 'Ben'); tb = token_of(capsys); return ta, tb
def login(env, oid, now=1000):
    c = connect_db(env[1]); t, e, _ = P.create_session(c, salt(env), oid, False, now); c.close(); return t
def auth(env, tok, now=1000): return S.Authenticator(env[1], salt(env), 5, now_ms=lambda: now).authenticate(tok)

def test_set_pin_prints_a_random_pin_once_and_stores_only_its_scrypt_hash(env, capsys):
    two_operators(env, capsys); assert run(env, 'set-pin', '--operator-id', '1') == 0; pin = pin_of(capsys)
    assert S.valid_pin(pin) and len(pin) == 6
    h, s, set_ts = rows(env, 'SELECT pin_hash, pin_salt, pin_set_ts FROM operators WHERE operator_id = 1')[0]
    assert S.verify_pin(pin, h, s) and pin not in h + s and set_ts > 0 and rows(env, 'SELECT pin_hash FROM operators WHERE operator_id = 2') == [(None,)]
    c = connect_db(env[1]); r = P.pin_login(c, 'Ana', pin, 5); assert r.status == 'ok' and r.operator.operator_id == 1
def test_set_pin_audits_pin_set_offline_with_session_null_and_event_seq_0_and_never_writes_the_pin(env, capsys):
    two_operators(env, capsys); run(env, 'set-pin', '--operator-id', '1'); pin = pin_of(capsys)
    a = rows(env, "SELECT session_id, event_seq, operator_id, action, reason FROM audit_events WHERE action = 'PIN_SET'")
    assert a == [(None, 0, None, 'PIN_SET', 'operator_id 1')] and init_event_seq(connect_db(env[1], readonly=True)) == 1
    assert pin not in str(rows(env, 'SELECT * FROM audit_events')) and pin not in (env[0] / 'config' / 'secrets.json').read_text()
def test_every_set_pin_gives_a_new_pin_and_the_old_one_stops_working(env, capsys):
    two_operators(env, capsys); run(env, 'set-pin', '--operator-id', '1'); p1 = pin_of(capsys); run(env, 'set-pin', '--operator-id', '1'); p2 = pin_of(capsys)
    c = connect_db(env[1]); assert p1 != p2 and P.pin_login(c, 'Ana', p2, 5).status == 'ok' and P.pin_login(c, 'Ana', p1, 5).status == 'rejected'
def test_length_sets_the_number_of_digits_and_a_length_outside_6_to_12_changes_nothing(env, capsys):
    two_operators(env, capsys); assert run(env, 'set-pin', '--operator-id', '1', '--length', '10') == 0 and len(pin_of(capsys)) == 10
    for n in ('5', '13', '0'): assert run(env, 'set-pin', '--operator-id', '1', '--length', n) == 1
    assert 'PIN' not in capsys.readouterr().out and len(rows(env, "SELECT * FROM audit_events WHERE action = 'PIN_SET'")) == 1
def test_set_pin_clears_the_lock_and_the_failure_count_and_ends_the_login_sessions_of_that_operator_only(env, capsys):
    two_operators(env, capsys); c = connect_db(env[1]); c.execute('UPDATE operators SET pin_fails = 3, pin_locked_until = 99999999999 WHERE operator_id = 1'); c.close()
    a, b = login(env, 1), login(env, 2); assert auth(env, a) and auth(env, b)
    run(env, 'set-pin', '--operator-id', '1'); out = capsys.readouterr().out
    assert rows(env, 'SELECT pin_fails, pin_locked_until FROM operators WHERE operator_id = 1') == [(0, None)] and auth(env, a) is None and auth(env, b) is not None and '1 login session(s) ended' in out
def test_prompt_takes_a_typed_pin_twice_and_does_not_print_it(env, capsys, monkeypatch):
    two_operators(env, capsys); import getpass; answers = iter(['482913', '482913']); monkeypatch.setattr(getpass, 'getpass', lambda prompt='': next(answers))
    assert run(env, 'set-pin', '--operator-id', '1', '--prompt') == 0; out = capsys.readouterr().out; assert '482913' not in out and 'PIN set' in out
    c = connect_db(env[1]); assert P.pin_login(c, 'Ana', '482913', 5).status == 'ok'
def test_prompt_refuses_two_different_or_invalid_pins_and_changes_nothing(env, capsys, monkeypatch):
    two_operators(env, capsys); import getpass
    for pair in (['482913', '482914'], ['123', '123'], ['12345a', '12345a']):
        answers = iter(pair); monkeypatch.setattr(getpass, 'getpass', lambda prompt='', a=answers: next(a))
        assert run(env, 'set-pin', '--operator-id', '1', '--prompt') == 1
    assert rows(env, 'SELECT pin_hash FROM operators WHERE operator_id = 1') == [(None,)] and rows(env, "SELECT * FROM audit_events WHERE action = 'PIN_SET'") == []
def test_set_pin_for_an_unknown_or_a_disabled_operator_fails_and_changes_nothing(env, capsys):
    two_operators(env, capsys); run(env, 'disable-operator', '--operator-id', '2'); capsys.readouterr()
    assert run(env, 'set-pin', '--operator-id', '9') == 1 and run(env, 'set-pin', '--operator-id', '2') == 1
    cap = capsys.readouterr(); assert 'PIN (shown' not in cap.out and 'disabled' in cap.err and rows(env, "SELECT * FROM audit_events WHERE action = 'PIN_SET'") == []
def test_rotate_token_ends_every_login_session_of_that_operator(env, capsys):
    two_operators(env, capsys); a1, a2, b = login(env, 1), login(env, 1), login(env, 2)
    assert run(env, 'rotate-token', '--operator-id', '1') == 0; out = capsys.readouterr().out
    assert auth(env, a1) is None and auth(env, a2) is None and auth(env, b) is not None and '2 login session(s) ended' in out and token_of_text(out)
def token_of_text(out): return out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()
def test_rotate_token_without_sessions_prints_no_session_line(env, capsys):
    two_operators(env, capsys); run(env, 'rotate-token', '--operator-id', '1'); assert 'login session' not in capsys.readouterr().out
def test_disable_operator_revokes_the_login_sessions_in_the_database(env, capsys):
    two_operators(env, capsys); a, b = login(env, 1), login(env, 2); assert run(env, 'disable-operator', '--operator-id', '1') == 0
    assert auth(env, a) is None and auth(env, b) is not None
    assert [r[0] is not None for r in rows(env, 'SELECT revoked_ts FROM login_sessions ORDER BY operator_id')] == [True, False]
