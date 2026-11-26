"""io/db_writer.py (P11-1): connection factory, migration runner, event_seq init and the single SQLite writer (design 2.1, 2.10, Section 1 commit paragraph).
A Unit is the set of rows that commit together (a frame row, the alert rows it raises, an episode change). event_seq is allocated by the caller
when it enqueues; units commit strictly in that order. Transient SQLite errors retry the head unit in place. Deterministic errors (constraint or
binding) are never retried: the unit is rolled back and its rows commit one by one, a failing row is skipped and counted in write_rejected."""
import os, re, sqlite3, threading, time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

WRITER_QUEUE_MAX = 500   # design 2.10 ("max 500 units"); no settings key exists, so it is a module constant (like ADR 0001)
SEQ_COLUMNS = (('frames', 'event_seq'), ('alerts', 'event_seq'), ('alerts', 'cleared_event_seq'), ('audit_events', 'event_seq'),
               ('system_events', 'event_seq'), ('advisory_summaries', 'event_seq'))
DETERMINISTIC = (sqlite3.IntegrityError, sqlite3.DataError, sqlite3.ProgrammingError, sqlite3.InterfaceError)
TRANSIENT_NAMES = ('SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_FULL')

class DatabaseTooNewError(RuntimeError): pass

def connect_db(path, readonly=False, busy_timeout_ms=5000, synchronous='FULL', check_same_thread=True):
    """Every connection: foreign_keys=ON and busy_timeout. A writer connection also gets WAL and the synchronous mode (2.1)."""
    if readonly:
        conn = sqlite3.connect('file:%s?mode=ro' % str(path).replace('\\', '/'), uri=True, isolation_level=None, check_same_thread=check_same_thread)
    else:
        conn = sqlite3.connect(str(path), isolation_level=None, check_same_thread=check_same_thread)
    conn.execute('PRAGMA foreign_keys=ON'); conn.execute('PRAGMA busy_timeout=%d' % int(busy_timeout_ms))
    if not readonly:
        conn.execute('PRAGMA journal_mode=WAL'); conn.execute('PRAGMA synchronous=%s' % synchronous)
    return conn

def migration_files(migrations_dir):
    return sorted((int(m.group(1)), os.path.join(migrations_dir, f)) for f in os.listdir(migrations_dir) if (m := re.fullmatch(r'(\d{4})\.sql', f)))

def applied_versions(conn):
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone(): return []
    return [r[0] for r in conn.execute('SELECT version FROM schema_version ORDER BY version')]

def run_migrations(conn, migrations_dir, now_ms, before_apply: Optional[Callable[[], None]] = None):
    """Apply every pending NNNN.sql in order, each in one transaction with its schema_version row. before_apply() (the online backup, P11-2) runs once,
    only when an existing database has something pending. A database newer than the code is refused. Returns the versions applied."""
    files, done = migration_files(migrations_dir), applied_versions(conn)
    if done and max(done) > max(v for v, _ in files): raise DatabaseTooNewError('database schema %d is newer than the code (%d)' % (max(done), max(v for v, _ in files)))
    todo = [(v, p) for v, p in files if v not in done]
    if todo and done and before_apply: before_apply()
    for v, p in todo:
        sql = open(p, encoding='utf8').read(); desc = sql.splitlines()[0].lstrip('- ').strip()[:200].replace("'", "''")
        try: conn.executescript('BEGIN;\n%s\nINSERT INTO schema_version(version, applied_ts, description) VALUES (%d, %d, \'%s\');\nCOMMIT;' % (sql, v, int(now_ms), desc))
        except Exception:
            if conn.in_transaction: conn.execute('ROLLBACK')
            raise
    return [v for v, _ in todo]

def init_event_seq(conn):
    """1 + the maximum over all six event_seq columns of the whole database (2.1)."""
    return 1 + max(conn.execute('SELECT COALESCE(MAX(%s), 0) FROM %s' % (c, t)).fetchone()[0] for t, c in SEQ_COLUMNS)

@dataclass(frozen=True)
class Ref:
    """A parameter filled in by the writer with the id an earlier statement of the same unit produced ('frame', 'episode'); NULL if that row was rejected."""
    tag: str

@dataclass
class Stmt:
    sql: str
    params: tuple = ()
    tag: Optional[str] = None      # remember cursor.lastrowid under this tag for later Ref(tag) parameters

@dataclass
class Unit:
    event_seq: int
    stmts: list
    droppable: bool = False        # routine or diagnostic frame unit: the only kind a full queue drops (2.10)
    durable: bool = False          # operator action: committed with synchronous=FULL whatever the default
    rejected: int = 0              # rows skipped by the deterministic-failure rule; the caller keeps its alert live with unpersisted=1
    fallback: bool = False         # set once the unit is committed row by row; a later retry resumes there
    _ids: dict = field(default_factory=dict, repr=False)
    _next: int = 0
    done: threading.Event = field(default_factory=threading.Event)

class DBWriter:
    def __init__(self, path, clock, queue_max=WRITER_QUEUE_MAX, synchronous='FULL', busy_timeout_ms=5000, retry_sleep_s=0.05, on_logging_fault=None):
        self.conn = connect_db(path, busy_timeout_ms=busy_timeout_ms, synchronous=synchronous, check_same_thread=False)
        self.clock, self.queue_max, self.sync, self.retry_sleep_s, self.on_logging_fault = clock, queue_max, synchronous, retry_sleep_s, on_logging_fault
        self.counters = {'write_rejected': 0, 'retry_buffer_dropped': 0, 'queue_overflow': 0, 'commits': 0}
        self.logging_fault, self.last_error = False, None
        self._q, self._cv, self._stop, self._last_seq, self._fault_log = deque(), threading.Condition(), False, 0, {}
        self._thread = threading.Thread(target=self._run, name='DBWriterThread', daemon=True)

    def start(self): self._thread.start(); return self

    def submit(self, unit: Unit):
        """Called on the event loop. A full queue drops the oldest droppable unit (counted); if none is droppable the unit is still kept and the overflow is counted."""
        with self._cv:
            if unit.event_seq <= self._last_seq: raise ValueError('event_seq must increase: %d after %d' % (unit.event_seq, self._last_seq))
            self._last_seq = unit.event_seq
            if len(self._q) >= self.queue_max:
                victim = next((u for i, u in enumerate(self._q) if i > 0 and u.droppable), None)   # the head may be mid-commit: never dropped
                if victim is not None: self._q.remove(victim); self.counters['retry_buffer_dropped'] += 1
                else: self.counters['queue_overflow'] += 1
                self.logging_fault = True
            self._q.append(unit); self._cv.notify()
        return unit

    def wait(self, unit, timeout_ms):
        """True if the unit committed within timeout_ms (commit_wait_ms). False means: broadcast the alert with unpersisted=1."""
        return unit.done.wait(timeout_ms / 1000.0)

    def pending(self):
        with self._cv: return len(self._q)

    def stop(self, drain=True, timeout_s=10):
        with self._cv:
            if not drain: self._q.clear()
            self._stop = True; self._cv.notify_all()
        self._thread.join(timeout_s); self.conn.close()

    def _run(self):
        while True:
            with self._cv:
                while not self._q and not self._stop: self._cv.wait(0.2)
                if not self._q: return
                unit = self._q[0]                     # stays at the head until it has been handled: nothing overtakes it
            if self._handle(unit):
                with self._cv:
                    if self._q and self._q[0] is unit: self._q.popleft()
                unit.done.set()
            else: time.sleep(self.retry_sleep_s)      # transient fault: the same head unit is retried in place

    def _handle(self, unit):
        try:
            if unit.fallback: self._commit_rows(unit)
            else: self._commit(unit)
            return True
        except sqlite3.Error as e:
            if not unit.fallback and (isinstance(e, DETERMINISTIC) or not self._transient(e)):
                unit.fallback = True; return self._handle(unit)
            self.logging_fault, self.last_error = True, str(e); return False

    @staticmethod
    def _transient(e):
        name = getattr(e, 'sqlite_errorname', '') or ''
        return name.startswith(TRANSIENT_NAMES) or bool(re.search(r'locked|busy|disk i/o|disk is full|database or disk is full', str(e), re.I))

    def _set_sync(self, mode): self.conn.execute('PRAGMA synchronous=%s' % mode)

    def _commit(self, unit):
        ids, raised = {}, False
        if unit.durable and self.sync != 'FULL': self._set_sync('FULL'); raised = True
        try:
            self.conn.execute('BEGIN IMMEDIATE')
            try:
                for s in unit.stmts: self._exec(s, ids)
                self.conn.execute('COMMIT')
            except BaseException:
                if self.conn.in_transaction: self.conn.execute('ROLLBACK')
                raise
        finally:
            if raised: self._set_sync(self.sync)
        unit._ids = ids                           # P24-3a: the ids of the tagged rows (alert:<event_seq>, episode:<event_seq>, frame) for whoever broadcasts the unit
        self.counters['commits'] += 1
        if not unit.rejected: self.logging_fault = False; self.last_error = None

    def _exec(self, s, ids):
        cur = self.conn.execute(s.sql, tuple((ids.get(p.tag) if isinstance(p, Ref) else p) for p in s.params))
        if s.tag: ids[s.tag] = cur.lastrowid

    def _commit_rows(self, unit):
        """Deterministic failure (Rev 3.36): never retried, never blocks the queue. Rows commit one by one in the original order; a failing row is skipped."""
        while unit._next < len(unit.stmts):
            s = unit.stmts[unit._next]
            if unit.durable and self.sync != 'FULL': self._set_sync('FULL')
            try:
                self.conn.execute('BEGIN IMMEDIATE')
                try: self._exec(s, unit._ids); self.conn.execute('COMMIT')
                except BaseException:
                    if self.conn.in_transaction: self.conn.execute('ROLLBACK')
                    raise
            except sqlite3.Error as e:
                if not isinstance(e, DETERMINISTIC) and self._transient(e): raise    # disk stall during the fallback: retried in place, resuming at this row
                unit.rejected += 1; self.counters['write_rejected'] += 1; self.logging_fault, self.last_error = True, str(e); self._note_fault(s, e)
            finally:
                if unit.durable and self.sync != 'FULL': self._set_sync(self.sync)
            unit._next += 1
        self.counters['commits'] += 1

    def _note_fault(self, s, e):
        """One LOGGING_FAULT per distinct SQLite message per minute: the callback gets (table, message) and writes the system event."""
        m = re.search(r'(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE)\s+(\w+)', s.sql, re.I); table, msg, now = (m.group(1) if m else '?'), str(e), self.clock.mono_ms()
        if now - self._fault_log.get(msg, -10**12) >= 60000:
            self._fault_log[msg] = now
            if self.on_logging_fault: self.on_logging_fault(table, msg)

# ---- P19c-2: SCBA corrections re-applied from audit_events (design 2.10) ----
_FRAME_OK = "verify = 'OK' AND seq_class IN ('fresh', 'reboot')"   # a duplicate or suspect frame neither sets nor changes the SCBA state
_SCBA_BITS = '(((id_mode >> 3) & 1) * 2 + ((status3 >> 3) & 1))'    # id_mode bit 3 (SCBA ON) and status3 bit 3 (scba_expired)
def load_scba_corrections(conn):
    """{node_id: (recorded_ts, operator display name)}: the latest SCBA_CORRECTION of each node from any session, kept until a later verified frame of that node
    differs from the node's SCBA bits at the time of the correction (the last frame at or before it, or the first frame after it if there is none). Read-only."""
    out = {}
    for node, ts, name in conn.execute("SELECT a.node_id, a.ts, COALESCE(o.display_name, '') FROM audit_events a LEFT JOIN operators o ON o.operator_id = a.operator_id "
                                       "WHERE a.action = 'SCBA_CORRECTION' AND a.node_id IS NOT NULL AND a.audit_id = (SELECT MAX(b.audit_id) FROM audit_events b "
                                       "WHERE b.action = 'SCBA_CORRECTION' AND b.node_id = a.node_id)").fetchall():
        base = conn.execute('SELECT %s FROM frames WHERE node_id = ? AND rx_ts <= ? AND %s ORDER BY rx_ts DESC, frame_id DESC LIMIT 1' % (_SCBA_BITS, _FRAME_OK), (node, ts)).fetchone()
        if base is None: base = conn.execute('SELECT %s FROM frames WHERE node_id = ? AND rx_ts > ? AND %s ORDER BY rx_ts, frame_id LIMIT 1' % (_SCBA_BITS, _FRAME_OK), (node, ts)).fetchone()
        if base is not None and conn.execute('SELECT 1 FROM frames WHERE node_id = ? AND rx_ts > ? AND %s AND %s != ? LIMIT 1' % (_FRAME_OK, _SCBA_BITS), (node, ts, base[0])).fetchone(): continue
        out[node] = (ts, name)
    return out
