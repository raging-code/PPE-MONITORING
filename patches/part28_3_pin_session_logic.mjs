// patches/part28_3_pin_session_logic.mjs  (run from repo root: node patches/part28_3_pin_session_logic.mjs [--dry] [--force])
// P28 Part 3 (ADR 0056): PIN and login-session logic. Needs part28_1 and part28_2 applied first. Not wired yet: no endpoint, CLI, setting or audit row (P28-4).
// New: host/ppe_host/api/pin_auth.py, host/tests/test_pin_auth.py.
// Edited (single-line anchors): host/ppe_host/api/security.py (valid_pin, hash_pin, verify_pin, the session check in authenticate(), an optional now_ms clock),
//   docs/adr/0056.md (the delay stays global; progress and notes), docs/design/s04.md (one phrase), docs/PROGRESS.md (one bullet appended).
// Safe to run twice. CRLF files keep their CRLF. --dry writes nothing.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), FORCE = process.argv.includes('--force');
const abs = (p) => path.join(ROOT, p), plan = [];
const put = (p, content) => plan.push({ op: 'put', p, content });
const replace = (p, o, n) => plan.push({ op: 'replace', p, o, n });
const append = (p, text) => plan.push({ op: 'append', p, text });
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toEol = (t, e) => t.replace(/\r\n/g, '\n').replace(/\n/g, e);
const lf = (s) => s.replace(/\r\n/g, '\n');
function apply() {
  const state = new Map(), log = [];
  const get = (p) => (state.has(p) ? state.get(p) : fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && lf(cur) !== lf(s.content) && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : lf(cur) === lf(s.content) ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) throw new Error(`MISSING file: ${s.p} (run the earlier parts first, and run from the repo root)`);
    else if (s.op === 'replace') {
      const e = eolOf(cur), o = toEol(s.o, e), n = toEol(s.n, e), c = cur.split(o).length - 1;
      if (cur.includes(n)) log.push(`skip      ${s.p} (already applied)`);
      else if (c === 1) { state.set(s.p, cur.replace(o, () => n)); log.push(`edit      ${s.p}`); }
      else throw new Error(`ANCHOR found ${c} times in ${s.p}: ${s.o.slice(0, 70)}`);
    } else if (s.op === 'append') {
      const e = eolOf(cur), t = toEol(s.text, e);
      if (cur.includes(t.trim())) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : e) + t); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\ndone'));
}

// ---- 1. security.py: PIN hashing, the PIN rule, and the session check inside authenticate() (single-line anchors)
const SEC = 'host/ppe_host/api/security.py';
replace(SEC, 'import hashlib, hmac, json, os, re, secrets, threading', 'import hashlib, hmac, json, os, re, secrets, threading, time');
replace(SEC, 'Tokens never expire (4.1). authenticate() reads the operators table on every call, so a rotated token or a disabled operator stops working at once.',
  'Tokens never expire (4.1). authenticate() reads the operators table on every call, so a rotated token or a disabled operator stops working at once.\nLogin sessions (ADR 0056, P28-3) do expire: authenticate() also reads login_sessions on every call (not revoked, not expired, operator active). PINs are salted scrypt hashes (hash_pin, verify_pin); the write side of the PIN login is api/pin_auth.py.');
replace(SEC, "def hash_token(salt_hex, token): return hmac.new(bytes.fromhex(salt_hex), token.encode('utf8'), hashlib.sha256).hexdigest()",
`def hash_token(salt_hex, token): return hmac.new(bytes.fromhex(salt_hex), token.encode('utf8'), hashlib.sha256).hexdigest()

DEFAULT_SESSION_HOURS = 12   # login session lifetime (ADR 0056, decision 1); the session_hours setting is added in P28-4
PIN_RE = re.compile(r'[0-9]{6,12}')
SCRYPT = dict(n=16384, r=8, p=1, dklen=32)   # about 16 MB and 50 ms per check
SESSION_SQL = 'SELECT o.operator_id, o.display_name, s.token_hash FROM login_sessions s JOIN operators o ON o.operator_id = s.operator_id WHERE s.revoked_ts IS NULL AND s.expires_ts > ? AND o.active = 1'
def valid_pin(pin): return isinstance(pin, str) and PIN_RE.fullmatch(pin) is not None   # ASCII digits only, 6 to 12 of them
def hash_pin(pin, salt_hex=None):
    """(hash_hex, salt_hex): scrypt of the PIN with a 16-byte random salt (a new one unless salt_hex is given). The PIN is never stored (design 4.2)."""
    salt_hex = salt_hex or secrets.token_hex(16); return hashlib.scrypt(pin.encode('utf8'), salt=bytes.fromhex(salt_hex), **SCRYPT).hex(), salt_hex
def verify_pin(pin, hash_hex, salt_hex):
    try: return hmac.compare_digest(hash_pin(pin, salt_hex)[0].encode('ascii'), str(hash_hex).encode('utf8', 'replace'))
    except (ValueError, TypeError): return False`);
replace(SEC, '    def __init__(self, db_path, salt_hex, cap_s):', '    def __init__(self, db_path, salt_hex, cap_s, now_ms=None):');
replace(SEC, '        self.db_path, self.salt, self.cap_s, self._fails, self._lock = db_path, salt_hex, float(cap_s), 0, threading.Lock()',
  '        self.db_path, self.salt, self.cap_s, self._fails, self._lock = db_path, salt_hex, float(cap_s), 0, threading.Lock(); self._now = now_ms or (lambda: int(time.time() * 1000))');
replace(SEC, "        try: rows = c.execute('SELECT operator_id, display_name, token_hash, active FROM operators').fetchall()",
`        try:
            rows = c.execute('SELECT operator_id, display_name, token_hash, active FROM operators').fetchall()
            rows += [(o, n, t, 1) for o, n, t in c.execute(SESSION_SQL, (int(self._now()),)).fetchall()]   # live login sessions of active operators (ADR 0056)`);

// ---- 2. new module and its tests
put('host/ppe_host/api/pin_auth.py', `"""api/pin_auth.py (P28-3, ADR 0056): the write side of the PIN login: set a PIN, check a PIN with the per-operator lock, make and revoke login sessions.
Plain functions on a writable connection (connect_db) and an explicit now_ms; nothing here opens a socket, reads settings or writes audit_events (P28-4 wires that: the route writes LOGIN_OK, LOGIN_REJECTED, LOGIN_LOCKED and LOGOUT through the port).
The scrypt check runs outside the write transaction, so a login does not hold the database lock for its ~50 ms. The lock is per operator and only for the PIN form; an operator token is never locked (design 4, Failed logins).
A login for an unknown name, an operator without a PIN, a wrong PIN or a disabled operator is the same 'rejected' answer and spends one scrypt check each. A locked answer does reveal that the name exists, which a station login screen shows anyway."""
import functools
from typing import NamedTuple, Optional
from . import security as sec

LOCK_AFTER = 5                  # consecutive wrong PINs of one operator before the lock (ADR 0056, decision 3)
LOCK_MS = 15 * 60 * 1000        # the lock clears itself after 15 minutes

class PinResult(NamedTuple):
    status: str                  # 'ok', 'rejected' or 'locked'
    operator: Optional[object]   # the Operator (api_rest) when status is 'ok'
    operator_id: Optional[int]   # known operator (for the audit row), None for an unknown name
    retry_after_s: Optional[int] # seconds left of the lock when status is 'locked'
    newly_locked: bool           # True only on the failure that starts the lock (write LOGIN_LOCKED once)

@functools.lru_cache(maxsize=1)
def _dummy(): return sec.hash_pin('000000', 'ab' * 16)

def _spend():
    """One scrypt check that always fails, so an unknown name costs the same time as a known one."""
    h, s = _dummy(); sec.verify_pin('999999', h, s)

def set_pin(conn, operator_id, pin, now_ms):
    """Store a new PIN for an operator (scrypt hash and a new salt), clear its failure count and lock, and revoke every login session of it. ValueError for a PIN that is not 6 to 12 digits; LookupError for an unknown operator. Nothing is changed in either case."""
    if not sec.valid_pin(pin): raise ValueError('a PIN is 6 to 12 digits')
    h, s = sec.hash_pin(pin); conn.execute('BEGIN IMMEDIATE')
    try:
        if conn.execute('UPDATE operators SET pin_hash = ?, pin_salt = ?, pin_fails = 0, pin_locked_until = NULL, pin_set_ts = ? WHERE operator_id = ?', (h, s, int(now_ms), operator_id)).rowcount != 1:
            raise LookupError('no operator %r' % (operator_id,))
        conn.execute('UPDATE login_sessions SET revoked_ts = ? WHERE operator_id = ? AND revoked_ts IS NULL', (int(now_ms), operator_id)); conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction: conn.execute('ROLLBACK')
        raise

def pin_login(conn, display_name, pin, now_ms):
    """Check display name + PIN. 'ok' resets the operator's failure count. A wrong PIN of an active operator that has a PIN counts; the LOCK_AFTER-th in a row starts a LOCK_MS lock (and resets the count, so the lock clears itself to a fresh count).
    While locked even the right PIN is refused, without a scrypt check. Failures of an unknown name, of an operator without a PIN or of a disabled operator are not counted."""
    from .api_rest import Operator
    now = int(now_ms); row = conn.execute('SELECT operator_id, display_name, active, pin_hash, pin_salt, pin_locked_until FROM operators WHERE display_name = ?', (display_name,)).fetchone() if isinstance(display_name, str) else None
    if row is None: _spend(); return PinResult('rejected', None, None, None, False)
    oid, name, active, ph, ps, locked_until = row
    if locked_until is not None and locked_until > now: return PinResult('locked', None, oid, -(-(locked_until - now) // 1000), False)
    if ph is None or ps is None: _spend(); return PinResult('rejected', None, oid, None, False)
    good = sec.valid_pin(pin) and sec.verify_pin(pin, ph, ps)
    if good and active == 1:
        conn.execute('UPDATE operators SET pin_fails = 0, pin_locked_until = NULL WHERE operator_id = ?', (oid,)); return PinResult('ok', Operator(oid, name), oid, None, False)
    if active != 1: return PinResult('rejected', None, oid, None, False)
    conn.execute('BEGIN IMMEDIATE')
    try:
        conn.execute('UPDATE operators SET pin_fails = pin_fails + 1 WHERE operator_id = ?', (oid,)); fails = conn.execute('SELECT pin_fails FROM operators WHERE operator_id = ?', (oid,)).fetchone()[0]
        if fails >= LOCK_AFTER: conn.execute('UPDATE operators SET pin_fails = 0, pin_locked_until = ? WHERE operator_id = ?', (now + LOCK_MS, oid))
        conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction: conn.execute('ROLLBACK')
        raise
    return PinResult('locked', None, oid, LOCK_MS // 1000, True) if fails >= LOCK_AFTER else PinResult('rejected', None, oid, None, False)

def create_session(conn, salt_hex, operator_id, remember, now_ms, hours=sec.DEFAULT_SESSION_HOURS):
    """A login session for an operator who just passed pin_login: (token, expires_ts, login_session_id). Only the HMAC of the token is stored."""
    token = sec.new_token(); created = int(now_ms); expires = created + int(float(hours) * 3600 * 1000)
    cur = conn.execute('INSERT INTO login_sessions(operator_id, token_hash, created_ts, expires_ts, remember) VALUES (?, ?, ?, ?, ?)', (operator_id, sec.hash_token(salt_hex, token), created, expires, 1 if remember else 0))
    return token, expires, cur.lastrowid

def revoke_session(conn, salt_hex, token, now_ms):
    """Log out: revoke the session this token belongs to. True if one was revoked, False for an operator token, an unknown token or a session already revoked."""
    return conn.execute('UPDATE login_sessions SET revoked_ts = ? WHERE token_hash = ? AND revoked_ts IS NULL', (int(now_ms), sec.hash_token(salt_hex, token))).rowcount == 1

def revoke_operator_sessions(conn, operator_id, now_ms):
    """Revoke every open login session of an operator (rotate-token and disable-operator call this in P28-4). Returns how many."""
    return conn.execute('UPDATE login_sessions SET revoked_ts = ? WHERE operator_id = ? AND revoked_ts IS NULL', (int(now_ms), operator_id)).rowcount
`);
put('host/tests/test_pin_auth.py', `"""P28-3 (ADR 0056): PIN hashing, the per-operator lock, login sessions and Authenticator.authenticate() with a session token. Real migrated database, real scrypt, fake clock. Requirements: REQ-SEC-002, REQ-SEC-004, REQ-SEC-005."""
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
    for bad in ('12345', '1234567890123', '12345a', ' 123456', '123456\\n', '12 456', '', None, 123456, '\\uff11\\uff12\\uff13\\uff14\\uff15\\uff16'): assert not S.valid_pin(bad)

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
`);

// ---- 3. docs: the retry_after_s delay stays global (it must not reveal which names exist), ADR notes, progress
replace('docs/adr/0056.md', "per operator, `pin_fails` counts consecutive failures; the answer carries `retry_after_s` with a delay that doubles from 1 s to a cap of 5 s (the same backoff as today);",
  "the answer carries `retry_after_s` from the same global backoff as today (1 s doubling to a cap of 5 s, one counter for every login form, so it says nothing about which names exist); per operator, `pin_fails` counts consecutive failures;");
replace('docs/design/s04.md', 'the delay grows per operator and a lock clears itself', 'the delay is the global backoff and a per-operator lock clears itself');
replace('docs/adr/0056.md', '- **Progress.** P28-1 and P28-2 done (Migration 0003 and its tests). P28-3 to P28-6 not done.',
`- **Progress.** P28-1, P28-2 and P28-3 done (Migration 0003; PIN and session logic). P28-4 to P28-6 not done.
- **P28-3 notes.** The write side is host/ppe_host/api/pin_auth.py (set_pin, pin_login, create_session, revoke_session, revoke_operator_sessions): plain functions on a writable connection, no audit rows (the P28-4 route writes them through the port). Hashing, the PIN rule and the session check are in api/security.py. The scrypt check runs outside the write transaction. The lock resets pin_fails to 0 when it starts; a wrong PIN of a disabled operator or of an operator without a PIN is not counted. The session_hours setting is added in P28-4 with the wiring; until then security.DEFAULT_SESSION_HOURS (12) is the value, and Authenticator takes an optional now_ms clock.`);
append('docs/PROGRESS.md', '- Part 28-3 done (ADR 0056): PIN and session logic. api/security.py gains valid_pin (6 to 12 ASCII digits), hash_pin and verify_pin (salted scrypt) and authenticate() also accepts a live login session (not revoked, not expired, operator active; Authenticator takes an optional now_ms clock). New api/pin_auth.py: set_pin (also revokes the operator sessions), pin_login (per-operator lock: the 5th wrong PIN in a row locks for 15 minutes, which clears itself; the operator token is never locked), create_session, revoke_session, revoke_operator_sessions. host/tests/test_pin_auth.py (15 tests, real scrypt and migrated database, fake clock). Not wired: no endpoint, CLI, setting or audit row yet (P28-4). retry_after_s stays the one global backoff. P28-4 to P28-6 not done.\n');

apply();
