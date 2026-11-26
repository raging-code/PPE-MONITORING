"""api/security.py (P19b-1): operator tokens, server_salt, the failed-login delay and the Origin/Host rule (design 4, 4.1 and 3.8).
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
