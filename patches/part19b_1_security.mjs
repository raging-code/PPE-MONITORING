// patches/part19b_1_security.mjs  (run from repo root: node patches/part19b_1_security.mjs [--dry] [--force])
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
  replace('host/ppe_host/api/api_rest.py', String.raw`import logging
from typing import NamedTuple`, String.raw`import asyncio, logging
from typing import NamedTuple`);
  replace('host/ppe_host/api/api_rest.py', String.raw`from . import models as M
`, String.raw`from . import models as M, security as sec
`);
  replace('host/ppe_host/api/api_rest.py', String.raw`    def session_id(self) -> int: ...
    # P19-2. A method raises`, String.raw`    def session_id(self) -> int: ...
    def login_failed(self) -> Optional[float]: ...  # P19b: the delay for this failed login (retry_after_s), None for no delay
    def login_ok(self) -> None: ...  # P19b: a successful login resets the delay
    # P19-2. A method raises`);
  replace('host/ppe_host/api/api_rest.py', String.raw`router = APIRouter(prefix='/api')
def create_app(port, db_path):
`, String.raw`_sleep = asyncio.sleep  # the failed-login delay; tests replace it
router = APIRouter(prefix='/api')
def create_app(port, db_path, bind_port=8420):
`);
  replace('host/ppe_host/api/api_rest.py', String.raw`    app.state.port, app.state.db_path = port, db_path
    app.include_router(router)
`, String.raw`    app.state.port, app.state.db_path, app.state.bind_port = port, db_path, bind_port
    app.include_router(router)
    @app.middleware('http')
    async def _origin(request, call_next):  # P19b: Host and Origin on every call, before the token is looked at (design 4); a rejection is audited as ORIGIN_REJECTED
        if not sec.origin_ok(request.headers.get('origin'), request.headers.get('host'), bind_port):
            port.audit('ORIGIN_REJECTED'); return _reply(403, 'ORIGIN_REJECTED', 'origin or host not allowed')
        return await call_next(request)
`);
  replace('host/ppe_host/api/api_rest.py', String.raw`    if op is None: raise ApiError(401, 'UNAUTHENTICATED', 'missing, invalid or disabled token')
`, String.raw`    if op is None: request.app.state.port.audit('LOGIN_REJECTED'); raise ApiError(401, 'UNAUTHENTICATED', 'missing, invalid or disabled token')
`);
  replace('host/ppe_host/api/api_rest.py', String.raw`    if op is None: port.audit('LOGIN_REJECTED'); raise ApiError(401, 'UNAUTHENTICATED', 'invalid token')
    port.audit('LOGIN_OK', operator_id=op.operator_id)
`, String.raw`    if op is None:
        port.audit('LOGIN_REJECTED'); delay = port.login_failed()
        if delay: await _sleep(delay)  # slows guessing without locking a valid token out
        raise ApiError(401, 'UNAUTHENTICATED', 'invalid token', delay)
    port.login_ok(); port.audit('LOGIN_OK', operator_id=op.operator_id)
`);
  replace('host/tests/test_api_rest.py', String.raw`    def session_id(self): return 4
@pytest.fixture`, String.raw`    def session_id(self): return 4
    def login_failed(self): return None
    def login_ok(self): pass
@pytest.fixture`);
  replace('host/tests/test_api_rest.py', String.raw`return TestClient(R.create_app(port, db), raise_server_exceptions=False), port, c`, String.raw`return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port, c`);
  replace('host/tests/test_api_rest.py', String.raw`c = TestClient(R.create_app(FakePort(), 'x.db'), raise_server_exceptions=False)`, String.raw`c = TestClient(R.create_app(FakePort(), 'x.db'), base_url='http://127.0.0.1:8420', raise_server_exceptions=False)`);
  replace('host/tests/test_api_actions.py', String.raw`return TestClient(R.create_app(port, 'unused.db'), raise_server_exceptions=False), port`, String.raw`return TestClient(R.create_app(port, 'unused.db'), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port`);
  replace('host/tests/test_api_actions.py', String.raw`    assert port.calls == [] and port.audits == []
def test_the_five_routes`, String.raw`    assert port.calls == [] and {a[0] for a in port.audits} <= {'LOGIN_REJECTED'}      # a refused token is audited (P19b) and reaches nothing
def test_the_five_routes`);
  put('host/ppe_host/api/security.py', String.raw`"""api/security.py (P19b-1): operator tokens, server_salt, the failed-login delay and the Origin/Host rule (design 4, 4.1 and 3.8).
Tokens are secrets.token_urlsafe(24) and only their hex HMAC-SHA256, keyed with server_salt, is stored in operators.token_hash (never a plain SHA-256).
Tokens never expire (4.1). authenticate() reads the operators table on every call, so a rotated token or a disabled operator stops working at once.
The host's Port (P24) delegates authenticate, login_failed and login_ok to one Authenticator. WebSocket authentication (P20) reuses origin_ok and authenticate."""
import hashlib, hmac, json, os, re, secrets, threading
from pathlib import Path
from ..io.db_writer import connect_db
from ..settings import SettingsError

BACKOFF_BASE_S = 1.0   # first failed-login delay; it doubles up to login_backoff_cap_s (docs/adr/0008.md)
def new_token(): return secrets.token_urlsafe(24)
def hash_token(salt_hex, token): return hmac.new(bytes.fromhex(salt_hex), token.encode('utf8'), hashlib.sha256).hexdigest()

def load_or_create_salt(home, operators_exist):
    """The 64-hex server_salt of <home>/config/secrets.json. Created once, by whichever of the host or the create-operator CLI runs first, other keys kept.
    A missing salt while operators exist is an error and never replaced: a new salt would invalidate every stored token (design 4)."""
    p = Path(home) / 'config' / 'secrets.json'; data = json.loads(p.read_text('utf8')) if p.exists() else {}
    if not isinstance(data, dict): raise SettingsError('secrets.json must be a JSON object')
    if 'server_salt' in data:
        s = data['server_salt']
        if not (isinstance(s, str) and re.fullmatch(r'[0-9a-fA-F]{64}', s)): raise SettingsError('server_salt in config/secrets.json is not 64 hex characters')
        return s
    if operators_exist: raise SettingsError('server_salt is missing but operators exist: not creating a new one, because every stored token would stop working; restore config/secrets.json')
    data['server_salt'] = secrets.token_hex(32); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + '.tmp'); tmp.write_text(json.dumps(data, indent=2), 'utf8'); os.replace(tmp, p); return data['server_salt']

class Authenticator:
    def __init__(self, db_path, salt_hex, cap_s):
        self.db_path, self.salt, self.cap_s, self._fails, self._lock = db_path, salt_hex, float(cap_s), 0, threading.Lock()
    def authenticate(self, token):
        """The Operator of an active row whose hash matches, else None. Every row is compared (hmac.compare_digest), with no early exit."""
        from .api_rest import Operator
        h = hash_token(self.salt, token).encode('ascii'); found = None
        c = connect_db(self.db_path, readonly=True)
        try: rows = c.execute('SELECT operator_id, display_name, token_hash, active FROM operators').fetchall()
        finally: c.close()
        for oid, name, th, active in rows:
            if hmac.compare_digest(str(th).encode('utf8', 'replace'), h) and active == 1 and found is None: found = Operator(oid, name)
        return found
    def login_failed(self):
        """The delay for this failed login: BACKOFF_BASE_S, doubled for each further failure in a row, capped at login_backoff_cap_s. A valid token is never refused because of it."""
        with self._lock: self._fails += 1; return min(self.cap_s, BACKOFF_BASE_S * 2 ** (self._fails - 1))
    def login_ok(self):
        with self._lock: self._fails = 0

def allowed_origins(bind_port): return ('http://localhost:%d' % bind_port, 'http://127.0.0.1:%d' % bind_port)
def origin_ok(origin, host, bind_port):
    """Host must be exact. Origin must be on the allowlist when present; a browser omits it on a same-origin GET, so a missing Origin passes ('null' does not)."""
    return (host or '').lower() in ('localhost:%d' % bind_port, '127.0.0.1:%d' % bind_port) and (origin is None or origin in allowed_origins(bind_port))
`);
  put('host/tests/test_api_security.py', String.raw`"""P19b-1: token hashing, server_salt, the failed-login delay, disabled operators and the Origin/Host rule (design 4, 4.1, 8). The database is a real migrated file; the app runs the real routes."""
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
`);
  putB64('docs/adr/0008.md', 'IyBBRFIgMDAwODogc2VjdXJpdHkgb2YgdGhlIFJFU1QgbGF5ZXIgKFAxOWItMSkKClN0YXR1czogUHJvcG9zZWQgKGRlY2lkZWQgaW4gdGhlIFAxOWItMSBzZXNzaW9uOyBjb25maXJtIGF0IHRoZSBuZXh0IGRlc2lnbiByZXZpZXcpLgpEZXNpZ246IFJldiAzLjQ1IGlzIGZyb3plbi4gTm90aGluZyBpbiB0aGUgZnJhbWUsIHRoZSBtaWdyYXRpb24gb3IgYGNvbnN0YW50cy5qc29uYCBjaGFuZ2VzLgoKLSAqKlNwbGl0OioqIFAxOWIgaXMgUDE5Yi0xIChgYXBpL3NlY3VyaXR5LnB5YCwgdGhlIE9yaWdpbi9Ib3N0IHJ1bGUsIHRoZSBsb2dpbiBkZWxheSwgdGhlIHdpcmluZyBpbnRvIGBhcGlfcmVzdC5weWApIGFuZCBQMTliLTIgKHRoZSBDTEkgY29tbWFuZHMgYGNyZWF0ZS1vcGVyYXRvcmAsIGByb3RhdGUtdG9rZW5gLCBgZGlzYWJsZS1vcGVyYXRvcmAsIGBhY2sgLS1ub2RlYCkuIFdlYlNvY2tldCBhdXRoZW50aWNhdGlvbiBhbmQgdGhlIGNsb3NlIG9mIGFuIG9wZW4gc29ja2V0IGZvciBhIGRpc2FibGVkIG9wZXJhdG9yIGJlbG9uZyB0byBQMjAsIHdoaWNoIHJldXNlcyBgb3JpZ2luX29rYCBhbmQgYGF1dGhlbnRpY2F0ZWAuCi0gKipUb2tlbnM6KiogYHNlY3JldHMudG9rZW5fdXJsc2FmZSgyNClgOyBvbmx5IHRoZSBoZXggSE1BQy1TSEEyNTYga2V5ZWQgd2l0aCBgc2VydmVyX3NhbHRgIGlzIHN0b3JlZDsgYGF1dGhlbnRpY2F0ZWAgcmVhZHMgYG9wZXJhdG9yc2Agb24gZXZlcnkgY2FsbCBhbmQgY29tcGFyZXMgZXZlcnkgcm93IHdpdGggYGhtYWMuY29tcGFyZV9kaWdlc3RgLCBzbyByb3RhdGlvbiBhbmQgZGlzYWJsaW5nIGFjdCBvbiB0aGUgbmV4dCByZXF1ZXN0IGFuZCB0aGVyZSBpcyBubyBleHBpcnkuIEl0IHJ1bnMgb24gdGhlIGV2ZW50IGxvb3AgKG9uZSBzbWFsbCByZWFkLW9ubHkgcXVlcnkpLCBiZWNhdXNlIHRoZSBkZXBlbmRlbmN5IG9mIFAxOS0xIGRvZXMuCi0gKipzZXJ2ZXJfc2FsdDoqKiBgbG9hZF9vcl9jcmVhdGVfc2FsdGAgY3JlYXRlcyBpdCBvbmNlIGluIGBjb25maWcvc2VjcmV0cy5qc29uYCwga2VlcHMgdGhlIG90aGVyIGtleXMsIHdyaXRlcyB0aHJvdWdoIGEgdGVtcG9yYXJ5IGZpbGUgYW5kIGBvcy5yZXBsYWNlYCwgYW5kIHJlZnVzZXMgKG5ldmVyIHJlcGxhY2VzKSBhIG1pc3Npbmcgc2FsdCB3aGlsZSBvcGVyYXRvcnMgZXhpc3Qgb3IgYSBtYWxmb3JtZWQgb25lLgotICoqRmFpbGVkLWxvZ2luIGRlbGF5IChQcm9wb3NlZCBudW1iZXJzKToqKiB0aGUgZGVzaWduIGdpdmVzIHRoZSBjYXAgKGBsb2dpbl9iYWNrb2ZmX2NhcF9zYCA9IDUpIGFuZCB0aGUgd29yZCAiZXhwb25lbnRpYWwiIGJ1dCBub3QgdGhlIGZpcnN0IHN0ZXAuIFRoZSBmaXJzdCBmYWlsdXJlIHdhaXRzIDEgcyBhbmQgZWFjaCBmdXJ0aGVyIGZhaWx1cmUgaW4gYSByb3cgZG91YmxlcyBpdCB1cCB0byB0aGUgY2FwICgxLCAyLCA0LCA1LCA1KS4gVGhlIDQwMSBjYXJyaWVzIHRoYXQgdmFsdWUgYXMgYHJldHJ5X2FmdGVyX3NgIGFuZCB0aGUgcm91dGUgd2FpdHMgdGhhdCBsb25nIGJlZm9yZSBpdCBhbnN3ZXJzLCB3aGljaCBzbG93cyBndWVzc2luZy4gVGhlIGNvdW50ZXIgaXMgZ2xvYmFsIChvbmUgbGFwdG9wKSBhbmQgYSBzdWNjZXNzIHJlc2V0cyBpdDsgYSB2YWxpZCB0b2tlbiBpcyBuZXZlciByZWZ1c2VkIGJlY2F1c2Ugb2YgZWFybGllciBmYWlsdXJlcyAoZGVzaWduIDQ6IG5vIGxvY2tvdXQpLgotICoqT3JpZ2luIGFuZCBIb3N0OioqIGEgbWlkZGxld2FyZSBjaGVja3MgZXZlcnkgSFRUUCBjYWxsIGJlZm9yZSB0aGUgdG9rZW4uIEhvc3QgbXVzdCBlcXVhbCBgbG9jYWxob3N0OjxiaW5kX3BvcnQ+YCBvciBgMTI3LjAuMC4xOjxiaW5kX3BvcnQ+YDsgT3JpZ2luLCB3aGVuIHByZXNlbnQsIG11c3QgZXF1YWwgYGh0dHA6Ly9sb2NhbGhvc3Q6PGJpbmRfcG9ydD5gIG9yIGBodHRwOi8vMTI3LjAuMC4xOjxiaW5kX3BvcnQ+YC4gQSBtaXNzaW5nIE9yaWdpbiBwYXNzZXMsIGJlY2F1c2UgYSBicm93c2VyIG9taXRzIGl0IG9uIGEgc2FtZS1vcmlnaW4gR0VUIChhIGNyb3NzLXNpdGUgUE9TVCBhbHdheXMgY2FycmllcyBvbmUpLCBhbmQgYG51bGxgIGlzIHJlamVjdGVkLiBBIHJlamVjdGlvbiBpcyA0MDMgYE9SSUdJTl9SRUpFQ1RFRGAgYW5kIG9uZSBgT1JJR0lOX1JFSkVDVEVEYCBhdWRpdCByb3cuIGBjcmVhdGVfYXBwYCB0YWtlcyBgYmluZF9wb3J0YCAoZGVmYXVsdCA4NDIwKS4KLSAqKlRva2VuIGNoYW5uZWxzOioqIG9ubHkgdGhlIGBBdXRob3JpemF0aW9uOiBCZWFyZXJgIGhlYWRlciBpcyByZWFkOyBhIGNvb2tpZSBvciBhIHF1ZXJ5IHBhcmFtZXRlciBpcyBuZXZlciBhIHRva2VuLgotICoqQXVkaXQ6KiogZXZlcnkgNDAxIGZyb20gdGhlIGJlYXJlciBkZXBlbmRlbmN5IHdyaXRlcyBgTE9HSU5fUkVKRUNURURgIChkZXNpZ24gODogYSBkaXNhYmxlZCBvcGVyYXRvcidzIG5leHQgUkVTVCBjYWxsIGlzIGxvZ2dlZCkuIEEgZmxvb2Qgb2YgdW5hdXRoZW50aWNhdGVkIGNhbGxzIHRoZXJlZm9yZSB3cml0ZXMgYSByb3cgZWFjaDsgcmF0ZS1saW1pdGluZyB0aGF0IGlzIG5vdCBkZXNpZ25lZCBhbmQgaXMgbGVmdCBvcGVuLgotICoqVGVzdHMgdG91Y2hlZDoqKiBgdGVzdF9hcGlfcmVzdC5weWAgYW5kIGB0ZXN0X2FwaV9hY3Rpb25zLnB5YCBidWlsZCB0aGVpciBjbGllbnQgd2l0aCBgYmFzZV91cmw9J2h0dHA6Ly8xMjcuMC4wLjE6ODQyMCdgICh0aGUgSG9zdCBjaGVjayksIGB0ZXN0X2FwaV9yZXN0LnB5YCdzIGZha2UgcG9ydCBnYWlucyBgbG9naW5fZmFpbGVkYCBhbmQgYGxvZ2luX29rYCwgYW5kIG9uZSBhc3NlcnRpb24gb2YgYHRlc3RfYXBpX2FjdGlvbnMucHlgIG5vdyBhbGxvd3MgYExPR0lOX1JFSkVDVEVEYCByb3dzIGFmdGVyIGEgcmVmdXNlZCB0b2tlbi4K');
  append('docs/PROGRESS.md', '- Part 19b-1 done: api/security.py (token_urlsafe(24) and HMAC-SHA256 token hashes keyed with server_salt, load_or_create_salt in config/secrets.json that refuses a missing salt while operators exist, Authenticator with hmac.compare_digest over every row and no expiry, failed-login delay 1 s doubling to login_backoff_cap_s, exact Origin and Host allowlist), api_rest.py wiring (403 ORIGIN_REJECTED middleware before the token, LOGIN_REJECTED on every 401, login 401 carries retry_after_s and waits it, create_app bind_port, token only from the Authorization header), host/tests/test_api_security.py (35 tests), docs/adr/0008.md; the CLI create-operator, rotate-token, disable-operator and ack --node are P19b-2, WebSocket auth is P20');
}
