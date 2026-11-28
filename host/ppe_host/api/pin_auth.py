"""api/pin_auth.py (P28-3, ADR 0056): the write side of the PIN login: set a PIN, check a PIN with the per-operator lock, make and revoke login sessions.
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
