"""P28-4a (ADR 0056): POST /api/login with display name + PIN, and POST /api/logout, through the real routes. The port is a small one over a real migrated database, real scrypt, the real Authenticator and a fake clock;
the host's own port (host_port.py) is tested in test_host_port_pin.py. Requirements: REQ-SEC-002, REQ-SEC-004, REQ-SEC-005."""
import pathlib
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M, pin_auth as P, security as S
from ppe_host.io.db_writer import connect_db, run_migrations

MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
SALT, T0, HOUR = 'cd' * 32, 2_000_000, 3600 * 1000
PIN = '482913'
KEYS_PIN = {'operator_id', 'display_name', 'session_id', 'session_token', 'expires_ts'}

class ConnPort:
    """What host_port.HostPort does through the writer queue, done directly on a connection."""
    def __init__(self, db, clock):
        self.audits, self.db, self.clock = [], db, clock; self.auth = S.Authenticator(db, SALT, 5, now_ms=lambda: clock[0])
    def _run(self, fn, *a):      # the routes call these in a worker thread, so each call opens its own connection
        c = connect_db(self.db)
        try: return fn(c, *a)
        finally: c.close()
    def authenticate(self, t): return self.auth.authenticate(t)
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, reason))
    def session_id(self): return 4
    def login_failed(self): return self.auth.login_failed()
    def login_ok(self): self.auth.login_ok()
    def pin_login(self, name, pin): return self._run(P.pin_login, name, pin, self.clock[0])
    def start_login_session(self, oid, remember): t, e, _ = self._run(P.create_session, SALT, oid, remember, self.clock[0]); return t, e
    def logout(self, token): return self._run(P.revoke_session, SALT, token, self.clock[0])

@pytest.fixture
def rig(tmp_path, monkeypatch):
    sleeps = []
    async def fake_sleep(s): sleeps.append(s)
    monkeypatch.setattr(R, '_sleep', fake_sleep)
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(MIG), 1000)
    for oid, name, tok, active in ((1, 'Ana', 'tok-ana', 1), (2, 'Cy', 'tok-cy', 0)):
        c.execute('INSERT INTO operators(operator_id, display_name, token_hash, active, created_ts, token_issued_ts) VALUES (?, ?, ?, ?, 0, 0)', (oid, name, S.hash_token(SALT, tok), active))
        P.set_pin(c, oid, PIN, 1)
    clock = [T0]; port = ConnPort(db, clock)
    return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port, c, clock, sleeps
def pin_login(client, name='Ana', pin=PIN, **kw): return client.post('/api/login', json=dict(display_name=name, pin=pin, **kw))
def bearer(t): return {'Authorization': 'Bearer ' + t}
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b

def test_pin_login_returns_a_session_token_that_works_and_logs_login_ok(rig):
    client, port, c, clock, _ = rig; r = pin_login(client, remember=True); b = r.json()
    assert r.status_code == 200 and set(b) == KEYS_PIN and (b['operator_id'], b['display_name'], b['session_id'], b['expires_ts']) == (1, 'Ana', 4, T0 + 12 * HOUR)
    assert port.audits == [('LOGIN_OK', 1, 'pin')] and c.execute('SELECT remember FROM login_sessions').fetchall() == [(1,)]
    assert client.get('/api/events', headers=bearer(b['session_token'])).status_code == 200      # the session token is a bearer token like any other
    assert PIN not in r.text and b['session_token'] not in str(c.execute('SELECT * FROM login_sessions').fetchall())      # neither the PIN nor the token is stored

def test_remember_is_off_by_default(rig):
    client, port, c, clock, _ = rig; assert pin_login(client).status_code == 200
    assert c.execute('SELECT remember FROM login_sessions').fetchall() == [(0,)]

def test_a_wrong_pin_an_unknown_name_and_a_disabled_operator_get_the_same_401_with_a_growing_delay(rig):
    client, port, c, clock, sleeps = rig
    for name, pin in (('Ana', '000001'), ('Nobody', PIN), ('Cy', PIN), ('Ana', '12')):
        r = pin_login(client, name, pin); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED' and envelope(r)['detail'] == 'invalid name or PIN'
    assert sleeps == [1.0, 2.0, 4.0, 5.0] and [a[0] for a in port.audits] == ['LOGIN_REJECTED'] * 4 and all(a[1:] == (None, 'pin') for a in port.audits)
    assert c.execute('SELECT COUNT(*) FROM login_sessions').fetchone()[0] == 0

def test_the_fifth_wrong_pin_locks_the_pin_form_for_15_minutes_and_the_operator_token_still_works(rig):
    client, port, c, clock, sleeps = rig
    for i in range(4): assert envelope(pin_login(client, pin='000001'))['retry_after_s'] == min(5.0, 2.0 ** i)
    r = pin_login(client, pin='000001'); assert r.status_code == 401 and envelope(r)['retry_after_s'] == 900 and 'locked' in envelope(r)['detail']
    assert [a[0] for a in port.audits].count('LOGIN_LOCKED') == 1 and ('LOGIN_LOCKED', 1, 'pin') in port.audits
    r = pin_login(client); assert r.status_code == 401 and envelope(r)['retry_after_s'] == 900      # even the right PIN is refused while locked
    assert [a[0] for a in port.audits].count('LOGIN_LOCKED') == 1 and len(sleeps) == 4      # a locked answer adds no delay and no second LOGIN_LOCKED
    assert client.post('/api/login', json={'token': 'tok-ana'}).status_code == 200      # break-glass: the long token is never locked
    clock[0] += 15 * 60 * 1000 + 1; assert pin_login(client).status_code == 200      # the lock clears itself

def test_a_good_pin_resets_the_failure_count(rig):
    client, port, c, clock, _ = rig
    for _ in range(4): pin_login(client, pin='000001')
    assert pin_login(client).status_code == 200
    for _ in range(4): assert pin_login(client, pin='000001').status_code == 401 and c.execute('SELECT pin_locked_until FROM operators WHERE operator_id = 1').fetchone()[0] is None

def test_the_token_form_is_unchanged_and_mixed_or_missing_fields_are_422_without_echoing_a_pin(rig):
    client, port, c, clock, _ = rig
    r = client.post('/api/login', json={'token': 'tok-ana'}); assert r.status_code == 200 and r.json() == {'operator_id': 1, 'display_name': 'Ana', 'session_id': 4}
    for body in ({}, {'display_name': 'Ana'}, {'pin': PIN}, {'token': 'tok-ana', 'display_name': 'Ana', 'pin': PIN}, {'display_name': 'Ana', 'pin': PIN, 'extra': 1}, {'display_name': 'Ana', 'pin': ''}):
        r = client.post('/api/login', json=body); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and PIN not in r.text, body

def test_logout_revokes_the_session_and_the_token_stops_working(rig):
    client, port, c, clock, _ = rig; tok = pin_login(client).json()['session_token']; port.audits.clear()
    r = client.post('/api/logout', headers=bearer(tok)); assert r.status_code == 200 and r.json() == {'logged_out': True} and port.audits == [('LOGOUT', 1, 'session')]
    assert client.get('/api/events', headers=bearer(tok)).status_code == 401 and c.execute('SELECT revoked_ts FROM login_sessions').fetchone()[0] == T0
    assert client.post('/api/logout', headers=bearer(tok)).status_code == 401      # the token is already dead

def test_logout_with_the_operator_token_changes_nothing_and_still_answers_200(rig):
    client, port, c, clock, _ = rig
    r = client.post('/api/logout', headers=bearer('tok-ana')); assert r.status_code == 200 and r.json() == {'logged_out': False} and port.audits == [('LOGOUT', 1, 'operator token')]
    assert client.get('/api/events', headers=bearer('tok-ana')).status_code == 200
    assert client.post('/api/logout').status_code == 401

def test_a_session_expires_after_12_hours(rig):
    client, port, c, clock, _ = rig; tok = pin_login(client).json()['session_token']
    clock[0] = T0 + 12 * HOUR - 1; assert client.get('/api/events', headers=bearer(tok)).status_code == 200
    clock[0] = T0 + 12 * HOUR + 1; assert client.get('/api/events', headers=bearer(tok)).status_code == 401

def test_two_logins_make_two_independent_sessions(rig):
    client, port, c, clock, _ = rig; a, b = (pin_login(client).json()['session_token'] for _ in range(2)); assert a != b
    client.post('/api/logout', headers=bearer(a)); assert client.get('/api/events', headers=bearer(a)).status_code == 401 and client.get('/api/events', headers=bearer(b)).status_code == 200
