"""P19b-1: token hashing, server_salt, the failed-login delay, disabled operators and the Origin/Host rule (design 4, 4.1, 8). The database is a real migrated file; the app runs the real routes."""
import hashlib, json, pathlib
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M, security as S
from ppe_host.io.db_writer import connect_db, run_migrations
from ppe_host.settings import SettingsError
MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
SALT = 'ab' * 32
URL = 'http://127.0.0.1:8420'
class RealPort:
    def __init__(self, auth): self.auth, self.audits = auth, []
    def authenticate(self, token): return self.auth.authenticate(token)
    def login_failed(self): return self.auth.login_failed()
    def login_ok(self): self.auth.login_ok()
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id))
    def session_id(self): return 4
@pytest.fixture
def rig(tmp_path, monkeypatch):
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(MIG), 1000)
    for oid, name, tok, active in ((1, 'Ana', 'tok-ana', 1), (2, 'Ben', 'tok-ben', 1), (3, 'Cy', 'tok-cy', 0)):
        c.execute('INSERT INTO operators(operator_id, display_name, token_hash, active, created_ts, token_issued_ts) VALUES (?, ?, ?, ?, 0, 0)', (oid, name, S.hash_token(SALT, tok), active))
    sleeps = []; 
    async def fake_sleep(s): sleeps.append(s)
    monkeypatch.setattr(R, '_sleep', fake_sleep)
    port = RealPort(S.Authenticator(db, SALT, 5)); return TestClient(R.create_app(port, db), base_url=URL, raise_server_exceptions=False), port, c, sleeps
def bearer(t): return {'Authorization': 'Bearer ' + t}
def envelope(r): b = r.json(); M.ErrorEnvelope(**b); return b

def test_token_hash_is_an_hmac_sha256_keyed_with_the_salt_and_never_a_plain_hash():
    h = S.hash_token(SALT, 'abc'); assert len(h) == 64 and int(h, 16) >= 0 and h == S.hash_token(SALT, 'abc')
    assert h != hashlib.sha256(b'abc').hexdigest() and h != S.hash_token('cd' * 32, 'abc') and h != S.hash_token(SALT, 'abd')
def test_new_tokens_are_192_bit_urlsafe_and_distinct():
    a, b = S.new_token(), S.new_token(); assert a != b and len(a) == 32 and all(ch.isalnum() or ch in '-_' for ch in a)

def test_salt_is_created_once_keeps_other_keys_and_is_64_hex(tmp_path):
    p = tmp_path / 'config' / 'secrets.json'; assert S.load_or_create_salt(tmp_path, False) and len(json.loads(p.read_text())['server_salt']) == 64
    s = S.load_or_create_salt(tmp_path, True); assert s == json.loads(p.read_text())['server_salt']        # a second run, with operators now existing, reuses it
    p.write_text(json.dumps({'cmac_key': '11' * 16, 'server_salt': s})); before = p.read_text(); assert S.load_or_create_salt(tmp_path, True) == s and p.read_text() == before
def test_salt_creation_keeps_the_cmac_key(tmp_path):
    p = tmp_path / 'config' / 'secrets.json'; p.parent.mkdir(); p.write_text(json.dumps({'cmac_key': '11' * 16}))
    S.load_or_create_salt(tmp_path, False); d = json.loads(p.read_text()); assert d['cmac_key'] == '11' * 16 and len(d['server_salt']) == 64
def test_a_missing_salt_while_operators_exist_is_refused_and_nothing_is_written(tmp_path):
    with pytest.raises(SettingsError): S.load_or_create_salt(tmp_path, True)
    assert not (tmp_path / 'config' / 'secrets.json').exists()
@pytest.mark.parametrize('bad', ['', 'zz' * 32, 'ab' * 31, 5])
def test_a_malformed_salt_is_an_error_not_a_new_salt(tmp_path, bad):
    p = tmp_path / 'config' / 'secrets.json'; p.parent.mkdir(); p.write_text(json.dumps({'server_salt': bad}))
    with pytest.raises(SettingsError): S.load_or_create_salt(tmp_path, False)

def test_authenticate_accepts_active_operators_only_and_never_expires(rig):
    _, port, c, _ = rig; a = port.auth
    assert a.authenticate('tok-ana') == R.Operator(1, 'Ana') and a.authenticate('tok-ben') == R.Operator(2, 'Ben')     # token_issued_ts is 0 (1970): no expiry
    assert a.authenticate('tok-cy') is None and a.authenticate('nope') is None and a.authenticate('') is None
    assert c.execute('SELECT COUNT(*) FROM operators WHERE token_hash IN (?, ?)', ('tok-ana', 'tok-ben')).fetchone()[0] == 0      # only hashes are stored
def test_rotate_and_disable_take_effect_on_the_next_call_and_spare_the_others(rig):
    _, port, c, _ = rig; a = port.auth
    c.execute('UPDATE operators SET token_hash = ? WHERE operator_id = 1', (S.hash_token(SALT, 'new-ana'),))
    assert a.authenticate('tok-ana') is None and a.authenticate('new-ana') == R.Operator(1, 'Ana') and a.authenticate('tok-ben') is not None
    c.execute('UPDATE operators SET active = 0 WHERE operator_id = 2'); assert a.authenticate('tok-ben') is None and a.authenticate('new-ana') is not None

def test_login_delay_doubles_up_to_the_cap_and_a_success_resets_it():
    a = S.Authenticator('x.db', SALT, 5); assert [a.login_failed() for _ in range(5)] == [1.0, 2.0, 4.0, 5.0, 5.0]
    a.login_ok(); assert a.login_failed() == 1.0
    assert S.Authenticator('x.db', SALT, 2).login_failed() == 1.0
def test_failed_login_answers_401_with_the_current_delay_and_waits_it(rig):
    client, port, _, sleeps = rig
    for want in (1.0, 2.0, 4.0):
        r = client.post('/api/login', json={'token': 'nope'}); assert r.status_code == 401 and envelope(r)['retry_after_s'] == want
    assert sleeps == [1.0, 2.0, 4.0] and [a[0] for a in port.audits] == ['LOGIN_REJECTED'] * 3
def test_a_valid_token_is_never_locked_out_by_earlier_failures_and_resets_the_delay(rig):
    client, port, _, sleeps = rig
    for _ in range(3): client.post('/api/login', json={'token': 'nope'})
    r = client.post('/api/login', json={'token': 'tok-ana'}); assert r.status_code == 200 and r.json()['display_name'] == 'Ana'
    assert client.post('/api/login', json={'token': 'nope'}).json()['retry_after_s'] == 1.0 and sleeps[-1] == 1.0
def test_disabled_operator_is_rejected_on_login_and_rest_and_login_rejected_is_audited(rig):
    client, port, _, _ = rig
    assert client.post('/api/login', json={'token': 'tok-cy'}).status_code == 401
    r = client.get('/api/events', headers=bearer('tok-cy')); assert r.status_code == 401 and envelope(r)['retry_after_s'] is None
    assert [a[0] for a in port.audits] == ['LOGIN_REJECTED', 'LOGIN_REJECTED'] and client.get('/api/events', headers=bearer('tok-ana')).status_code == 200
def test_old_token_is_401_after_rotation_and_the_new_one_works_with_no_expiry_banner(rig):
    client, _, c, _ = rig; assert client.get('/api/events', headers=bearer('tok-ana')).status_code == 200
    c.execute('UPDATE operators SET token_hash = ?, token_issued_ts = 1 WHERE operator_id = 1', (S.hash_token(SALT, 'rot'),))
    assert client.get('/api/events', headers=bearer('tok-ana')).status_code == 401 and client.get('/api/events', headers=bearer('rot')).status_code == 200
def test_a_token_sent_as_a_cookie_or_in_the_query_is_not_accepted(rig):
    client, _, _, _ = rig
    assert client.get('/api/events', headers={'Cookie': 'token=tok-ana'}).status_code == 401 and client.get('/api/events?token=tok-ana').status_code == 401

@pytest.mark.parametrize('origin,host,ok', [(None, '127.0.0.1:8420', True), ('http://127.0.0.1:8420', '127.0.0.1:8420', True), ('http://localhost:8420', 'localhost:8420', True),
    ('http://localhost:8420', 'LOCALHOST:8420', True), ('http://evil.example', '127.0.0.1:8420', False), ('null', '127.0.0.1:8420', False), ('', '127.0.0.1:8420', False),
    ('http://127.0.0.1:8421', '127.0.0.1:8420', False), ('https://127.0.0.1:8420', '127.0.0.1:8420', False), (None, 'evil.example', False), (None, '127.0.0.1:8421', False),
    (None, '127.0.0.1', False), (None, None, False), ('http://127.0.0.1:8420/', '127.0.0.1:8420', False)])
def test_origin_ok_is_an_exact_allowlist(origin, host, ok): assert S.origin_ok(origin, host, 8420) is ok
def test_origin_ok_follows_the_configured_port(): assert S.origin_ok('http://localhost:9000', 'localhost:9000', 9000) and not S.origin_ok('http://localhost:8420', 'localhost:8420', 9000)
def test_a_foreign_origin_is_403_origin_rejected_before_the_token_and_audited(rig):
    client, port, _, _ = rig
    for method, url in (('get', '/api/events'), ('post', '/api/login'), ('post', '/api/session/start'), ('get', '/api/nothing')):
        r = getattr(client, method)(url, headers={**bearer('tok-ana'), 'Origin': 'http://evil.example'}); assert r.status_code == 403 and envelope(r) == {'error_code': 'ORIGIN_REJECTED', 'detail': 'origin or host not allowed', 'retry_after_s': None}
    assert [a[0] for a in port.audits] == ['ORIGIN_REJECTED'] * 4        # no LOGIN_OK, no LOGIN_REJECTED: the request never reached the token check
def test_a_wrong_host_is_403_and_the_allowed_origins_pass(rig):
    client, port, _, _ = rig
    assert client.get('/api/events', headers={**bearer('tok-ana'), 'Host': 'evil.example'}).status_code == 403
    for o, h in ((URL, '127.0.0.1:8420'), ('http://localhost:8420', 'localhost:8420')): assert client.get('/api/events', headers={**bearer('tok-ana'), 'Origin': o, 'Host': h}).status_code == 200
def test_create_app_takes_the_bind_port(tmp_path):
    c = TestClient(R.create_app(RealPort(S.Authenticator('x.db', SALT, 5)), 'x.db', bind_port=9000), base_url='http://127.0.0.1:9000', raise_server_exceptions=False)
    assert c.get('/api/nothing').status_code == 404 and c.get('/api/nothing', headers={'Origin': URL}).status_code == 403
