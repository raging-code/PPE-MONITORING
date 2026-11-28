"""api/pin_auth.py (P28-3, planners P28-4a; ADR 0056): the write side of the PIN login: set a PIN, check a PIN with the per-operator lock, make and revoke login sessions.
Each decision is a pure planner that returns a result and the statements to run: plan_login, plan_set_pin, plan_session, revoke_stmt. The running host sends those statements through Ingest.write (one ordered writer queue,
design 1; HostPort.pin_login, start_login_session and logout), the offline CLI runs them on its own connection, and the conn functions below (pin_login, set_pin, create_session, revoke_session, revoke_operator_sessions) run them on a connection for tests.
Nothing here opens a socket, reads settings or writes audit_events (the route and the CLI write LOGIN_OK, LOGIN_REJECTED, LOGIN_LOCKED, LOGOUT and PIN_SET).
The scrypt check runs before any write, so a login does not hold the database for its ~50 ms. The failure count and the lock are changed by one atomic UPDATE, so two logins at once cannot lose a count; if two wrong PINs race on the 5th failure, the lock still starts but only one answer
(or neither) says 'locked'. The lock is per operator and only for the PIN form; an operator token is never locked (design 4, Failed logins).
A login for an unknown name, an operator without a PIN, a wrong PIN or a disabled operator is the same 'rejected' answer and spends one scrypt check each. A locked answer does reveal that the name exists, which a station login screen shows anyway."""
import functools
from typing import NamedTuple, Optional
from . import security as sec

LOCK_AFTER = 5                  # consecutive wrong PINs of one operator before the lock (ADR 0056, decision 3)
LOCK_MS = 15 * 60 * 1000        # the lock clears itself after 15 minutes
LOGIN_SQL = 'SELECT operator_id, display_name, active, pin_hash, pin_salt, pin_locked_until, pin_fails FROM operators WHERE display_name = ?'
OK_SQL = 'UPDATE operators SET pin_fails = 0, pin_locked_until = NULL WHERE operator_id = ?'
FAIL_SQL = 'UPDATE operators SET pin_fails = CASE WHEN pin_fails + 1 >= ? THEN 0 ELSE pin_fails + 1 END, pin_locked_until = CASE WHEN pin_fails + 1 >= ? THEN ? ELSE pin_locked_until END WHERE operator_id = ?'
SET_PIN_SQL = 'UPDATE operators SET pin_hash = ?, pin_salt = ?, pin_fails = 0, pin_locked_until = NULL, pin_set_ts = ? WHERE operator_id = ?'
INSERT_SESSION_SQL = 'INSERT INTO login_sessions(operator_id, token_hash, created_ts, expires_ts, remember) VALUES (?, ?, ?, ?, ?)'
REVOKE_ONE_SQL = 'UPDATE login_sessions SET revoked_ts = ? WHERE token_hash = ? AND revoked_ts IS NULL'
REVOKE_ALL_SQL = 'UPDATE login_sessions SET revoked_ts = ? WHERE operator_id = ? AND revoked_ts IS NULL'

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

def plan_login(row, pin, now_ms):
    """(PinResult, [(sql, params), ...]) for display name + PIN. row is the LOGIN_SQL row of the name, or None for an unknown name.
    'ok' resets the operator's failure count. A wrong PIN of an active operator that has a PIN counts; the LOCK_AFTER-th in a row starts a LOCK_MS lock (and resets the count, so the lock clears itself to a fresh count).
    While locked even the right PIN is refused, without a scrypt check. Failures of an unknown name, of an operator without a PIN or of a disabled operator are not counted and plan no statement."""
    from .api_rest import Operator
    now = int(now_ms)
    if row is None: _spend(); return PinResult('rejected', None, None, None, False), []
    oid, name, active, ph, ps, locked_until, fails = row
    if locked_until is not None and locked_until > now: return PinResult('locked', None, oid, -(-(locked_until - now) // 1000), False), []
    if ph is None or ps is None: _spend(); return PinResult('rejected', None, oid, None, False), []
    good = sec.valid_pin(pin) and sec.verify_pin(pin, ph, ps)
    if good and active == 1: return PinResult('ok', Operator(oid, name), oid, None, False), [(OK_SQL, (oid,))]
    if active != 1: return PinResult('rejected', None, oid, None, False), []
    count = (FAIL_SQL, (LOCK_AFTER, LOCK_AFTER, now + LOCK_MS, oid))
    if fails + 1 >= LOCK_AFTER: return PinResult('locked', None, oid, LOCK_MS // 1000, True), [count]
    return PinResult('rejected', None, oid, None, False), [count]

def plan_set_pin(operator_id, pin, now_ms):
    """The statements that store a new PIN (scrypt hash and a new salt), clear the failure count and the lock, and revoke every login session of the operator. ValueError for a PIN that is not 6 to 12 digits."""
    if not sec.valid_pin(pin): raise ValueError('a PIN is 6 to 12 digits')
    h, s = sec.hash_pin(pin); now = int(now_ms)
    return [(SET_PIN_SQL, (h, s, now, operator_id)), (REVOKE_ALL_SQL, (now, operator_id))]

def plan_session(salt_hex, operator_id, remember, now_ms, hours=sec.DEFAULT_SESSION_HOURS):
    """(token, expires_ts, (sql, params)): a login session for an operator who just passed plan_login. Only the HMAC of the token is stored."""
    token = sec.new_token(); created = int(now_ms); expires = created + int(float(hours) * 3600 * 1000)
    return token, expires, (INSERT_SESSION_SQL, (operator_id, sec.hash_token(salt_hex, token), created, expires, 1 if remember else 0))

def revoke_stmt(salt_hex, token, now_ms):
    """The statement that logs one session out (the one this token belongs to)."""
    return (REVOKE_ONE_SQL, (int(now_ms), sec.hash_token(salt_hex, token)))

# ---- the same decisions on a writable connection (tests, offline tools) ----
def run(conn, stmts):
    """Run planned statements in one transaction."""
    if not stmts: return
    conn.execute('BEGIN IMMEDIATE')
    try:
        for sql, params in stmts: conn.execute(sql, params)
        conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction: conn.execute('ROLLBACK')
        raise

def pin_login(conn, display_name, pin, now_ms):
    row = conn.execute(LOGIN_SQL, (display_name,)).fetchone() if isinstance(display_name, str) else None
    res, stmts = plan_login(row, pin, now_ms); run(conn, stmts); return res

def set_pin(conn, operator_id, pin, now_ms):
    """ValueError for a bad PIN, LookupError for an unknown operator; nothing is changed in either case."""
    first, second = plan_set_pin(operator_id, pin, now_ms); conn.execute('BEGIN IMMEDIATE')
    try:
        if conn.execute(*first).rowcount != 1: raise LookupError('no operator %r' % (operator_id,))
        conn.execute(*second); conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction: conn.execute('ROLLBACK')
        raise

def create_session(conn, salt_hex, operator_id, remember, now_ms, hours=sec.DEFAULT_SESSION_HOURS):
    """(token, expires_ts, login_session_id)."""
    token, expires, stmt = plan_session(salt_hex, operator_id, remember, now_ms, hours); return token, expires, conn.execute(*stmt).lastrowid

def revoke_session(conn, salt_hex, token, now_ms):
    """True if a session was revoked, False for an operator token, an unknown token or a session already revoked."""
    return conn.execute(*revoke_stmt(salt_hex, token, now_ms)).rowcount == 1

def revoke_operator_sessions(conn, operator_id, now_ms):
    """Revoke every open login session of an operator. Returns how many."""
    return conn.execute(REVOKE_ALL_SQL, (int(now_ms), operator_id)).rowcount
