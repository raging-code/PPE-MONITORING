// patches/part11_1_db_writer.mjs  (run from repo root: node patches/part11_1_db_writer.mjs [--dry] [--force])
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
  put('host/ppe_host/io/db_writer.py', String.raw`"""io/db_writer.py (P11-1): connection factory, migration runner, event_seq init and the single SQLite writer (design 2.1, 2.10, Section 1 commit paragraph).
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
`);
  put('host/tests/test_db_schema.py', String.raw`"""P11-1: connection factory, migration runner, schema and index tests (design 2.1, Section 8 Rev 3.20 and 3.38). Roster rows are inserted directly: seed-roster is P11-2."""
import json, os, pathlib, sqlite3, pytest
from ppe_host.io.db_writer import connect_db, run_migrations, init_event_seq, applied_versions, DatabaseTooNewError

MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
CATALOG = pathlib.Path(__file__).resolve().parents[2] / 'shared' / 'alert_catalog.json'
def master(c): return sorted(c.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchall(), key=lambda r: (r[0], r[1]))
def new_db(tmp_path, name='t.db'):
    c = connect_db(tmp_path / name); run_migrations(c, str(MIG), 1000)
    c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03')]); return c
def session(c, sid=1, ended=None):
    c.execute('INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash, ended_ts, end_kind) VALUES (?, 1, \'LIVE\', \'b\', \'c\', \'s\', ?, ?)', (sid, ended, 'ENDED' if ended else None))
def frame(c, seq, node=1, verify='OK', **kw):
    f = dict(event_seq=seq, session_id=1, node_id=node, rx_ts=1, rx_mono=1, verify=verify, base_verify='OK', seq_class='fresh', raw_hex='00', backend_ms=0.1); f.update(kw)
    c.execute('INSERT INTO frames(%s) VALUES (%s)' % (','.join(f), ','.join('?' * len(f))), tuple(f.values()))
def alert(c, seq, typ='co_threshold', node=1, **kw):
    a = dict(event_seq=seq, session_id=1, node_id=node, type=typ, level='WARNING', raised_ts=1); a.update(kw)
    c.execute('INSERT INTO alerts(%s) VALUES (%s)' % (','.join(a), ','.join('?' * len(a))), tuple(a.values()))
def rejects(fn):
    with pytest.raises(sqlite3.IntegrityError): fn()

def test_schema_dump_equals_0001_sql(tmp_path):
    ref = sqlite3.connect(':memory:'); ref.executescript((MIG / '0001.sql').read_text(encoding='utf8'))
    c = new_db(tmp_path); assert master(c) == master(ref) and applied_versions(c) == [1]
    assert c.execute('SELECT description FROM schema_version').fetchone()[0].startswith('Migration 0001')

def test_roster_trigger_rejects_ok_frame_with_unknown_node_but_not_bad_mac(tmp_path):
    c = new_db(tmp_path); session(c); frame(c, 1, node=3)
    rejects(lambda: frame(c, 2, node=7)); frame(c, 3, node=7, verify='BAD_MAC')            # failing length, CRC or MAC frames are unaffected
    assert c.execute('PRAGMA foreign_key_check').fetchall() == []

def test_seed_counts_and_alert_types_equal_the_catalog(tmp_path):
    c = new_db(tmp_path); n = lambda t: c.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0]
    assert (n('alert_types'), n('audit_actions'), n('system_event_types')) == (25, 18, 29)
    assert {r[0] for r in c.execute('SELECT type FROM alert_types')} == {a['type'] for a in json.loads(CATALOG.read_text(encoding='utf8')) if a['owner'] == 'alerts'}   # banners (owner system_banner) are not alert rows

def test_fresh_and_upgraded_databases_have_the_same_schema_and_a_backup_hook_runs_once(tmp_path):
    d = tmp_path / 'm'; d.mkdir(); (d / '0001.sql').write_text((MIG / '0001.sql').read_text(encoding='utf8'), encoding='utf8')
    (d / '0002.sql').write_text('-- Migration 0002 test\nCREATE TABLE extra (x INTEGER);\n', encoding='utf8')
    a = connect_db(tmp_path / 'a.db'); calls = []; assert run_migrations(a, str(d), 1, lambda: calls.append(1)) == [1, 2] and calls == []   # fresh: nothing to back up
    b = connect_db(tmp_path / 'b.db'); (d / '0002.sql').rename(d / 'x'); run_migrations(b, str(d), 1); (d / 'x').rename(d / '0002.sql')
    assert run_migrations(b, str(d), 2, lambda: calls.append(1)) == [2] and calls == [1] and master(a) == master(b) and applied_versions(b) == [1, 2]
    assert run_migrations(b, str(d), 3, lambda: calls.append(1)) == [] and calls == [1]

def test_a_database_newer_than_the_code_is_refused_and_a_failed_migration_rolls_back(tmp_path):
    c = new_db(tmp_path); c.execute("INSERT INTO schema_version VALUES (9, 1, 'future')")
    with pytest.raises(DatabaseTooNewError): run_migrations(c, str(MIG), 1)
    d = tmp_path / 'm'; d.mkdir(); (d / '0001.sql').write_text('CREATE TABLE ok (x INTEGER);\nCREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_ts INTEGER NOT NULL, description TEXT NOT NULL);', encoding='utf8')
    (d / '0002.sql').write_text('CREATE TABLE half (x INTEGER);\nTHIS IS NOT SQL;', encoding='utf8')
    e = connect_db(tmp_path / 'e.db')
    (d / '0002.sql').rename(d / 'later'); run_migrations(e, str(d), 1); (d / 'later').rename(d / '0002.sql')
    with pytest.raises(sqlite3.Error): run_migrations(e, str(d), 2)
    assert applied_versions(e) == [1] and not e.execute("SELECT 1 FROM sqlite_master WHERE name='half'").fetchone() and not e.in_transaction

def test_open_session_index_second_open_rejected_close_plus_insert_in_one_transaction_accepted(tmp_path):
    c = new_db(tmp_path); session(c, 1); rejects(lambda: session(c, 2))
    c.execute('BEGIN'); c.execute("UPDATE sessions SET ended_ts=5, end_kind='ENDED' WHERE session_id=1"); session(c, 2); c.execute('COMMIT')
    assert c.execute('SELECT COUNT(*) FROM sessions WHERE ended_ts IS NULL').fetchone()[0] == 1

def test_open_alert_index_blocks_a_second_co_threshold_per_node_but_not_unauth_alert(tmp_path):
    c = new_db(tmp_path); session(c); alert(c, 1); rejects(lambda: alert(c, 2)); alert(c, 3, node=2)                  # other node is fine
    alert(c, 4, 'unauth_alert'); alert(c, 5, 'unauth_alert')                                                           # not in the unique index
    c.execute('UPDATE alerts SET cleared_ts=9 WHERE event_seq=1'); alert(c, 6)                                         # cleared: a new one may open
    assert 'idx_alerts_session_cleared' in {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}

def test_check_constraints_reject_bad_values(tmp_path):
    c = new_db(tmp_path); session(c)
    rejects(lambda: frame(c, 1, node_level='BANANA')); rejects(lambda: frame(c, 2, base_verify='XYZ')); rejects(lambda: frame(c, 3, node=None))
    rejects(lambda: frame(c, 4, co_over_range=2)); rejects(lambda: c.execute("UPDATE sessions SET monitoring_active=2"))
    rejects(lambda: c.execute("UPDATE sessions SET ended_ts=5")); rejects(lambda: c.execute("UPDATE sessions SET end_kind='ENDED'"))
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'a', 'h', 1, 1)")
    c.execute("INSERT INTO episodes(session_id, node_id, kind, opened_ts, state) VALUES (1, 1, 'MAN_DOWN', 1, 'OPEN')")
    rejects(lambda: c.execute("UPDATE episodes SET state='RESOLVED'"))                                                  # no resolved_ts, reason or resolver

def test_init_event_seq_is_one_plus_the_maximum_over_all_six_columns(tmp_path):
    c = new_db(tmp_path); session(c); assert init_event_seq(c) == 1
    frame(c, 5); alert(c, 7, cleared_event_seq=40, cleared_ts=2); assert init_event_seq(c) == 41                      # cleared_event_seq counts
    c.execute("INSERT INTO system_events(session_id, event_seq, ts, kind) VALUES (1, 90, 1, 'HOST_START')"); assert init_event_seq(c) == 91
    c.execute("INSERT INTO advisory_summaries(session_id, event_seq, ts, node_id, window_s, risk, reasons, action, source, quality) VALUES (1, 120, 1, 1, 60, 'NOMINAL', 'r', 'a', 'table', 'high')"); assert init_event_seq(c) == 121

def test_connect_db_pragmas_on_every_connection(tmp_path):
    c = new_db(tmp_path); g = lambda k: c.execute('PRAGMA ' + k).fetchone()[0]
    assert (g('foreign_keys'), g('busy_timeout'), g('journal_mode'), g('synchronous')) == (1, 5000, 'wal', 2)
    r = connect_db(tmp_path / 't.db', readonly=True); assert r.execute('PRAGMA foreign_keys').fetchone()[0] == 1 and r.execute('PRAGMA busy_timeout').fetchone()[0] == 5000
    with pytest.raises(sqlite3.OperationalError): r.execute('DELETE FROM roster')
    n = connect_db(tmp_path / 'n.db', synchronous='NORMAL'); assert n.execute('PRAGMA synchronous').fetchone()[0] == 1
`);
  put('host/tests/test_db_writer.py', String.raw`"""P11-1: DBWriter behaviour (design 2.1, 2.10, Section 1 commit paragraph, Rev 3.28 and 3.36). The disk stall is real: a second connection holds the write lock."""
import time, pytest
from ppe_host.clock import FakeClock
from ppe_host.io.db_writer import DBWriter, Unit, Stmt, Ref, connect_db, init_event_seq
from test_db_schema import new_db, session

FRAME = 'INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, 1, ?, 1, 1, \'OK\', \'OK\', \'fresh\', \'00\', 0.1)'
ALERT = 'INSERT INTO alerts(event_seq, session_id, frame_id, node_id, type, level, raised_ts) VALUES (?, 1, ?, ?, ?, \'WARNING\', 1)'
AUDIT = 'INSERT INTO audit_events(session_id, event_seq, ts, action) VALUES (1, ?, 1, \'ACK_ALERT\')'
def frame_u(seq, node=1, **kw): return Unit(seq, [Stmt(FRAME, (seq, node), tag='frame')], **kw)
def seqs(c, t='frames'): return [r[0] for r in c.execute('SELECT event_seq FROM %s ORDER BY event_seq' % t)]
@pytest.fixture
def db(tmp_path):
    c = new_db(tmp_path); session(c); return c, tmp_path / 't.db'
def writer(path, **kw): return DBWriter(path, kw.pop('clock', FakeClock(0, 0)), retry_sleep_s=0.005, busy_timeout_ms=20, **kw)

def test_units_commit_in_event_seq_order_and_a_ref_carries_the_frame_id(db):
    c, path = db; w = writer(path).start()
    u1 = w.submit(Unit(1, [Stmt(FRAME, (1, 1), tag='frame'), Stmt(ALERT, (2, Ref('frame'), 1, 'co_threshold'))]))
    u2 = w.submit(frame_u(3)); assert w.wait(u2, 2000) and u1.done.is_set()
    assert seqs(c) == [1, 3] and c.execute('SELECT frame_id FROM alerts').fetchone()[0] == c.execute('SELECT frame_id FROM frames WHERE event_seq=1').fetchone()[0]
    with pytest.raises(ValueError): w.submit(frame_u(3))                                                              # never out of order, never reused
    w.stop()

def test_a_disk_stall_retries_the_head_in_place_and_the_backlog_drains_in_order(db):
    c, path = db; w = writer(path).start(); blocker = connect_db(path); blocker.execute('BEGIN IMMEDIATE')           # another connection holds the write lock
    us = [w.submit(frame_u(i, **({'durable': True} if i == 2 else {}))) for i in (1, 2, 3, 4)]
    assert not w.wait(us[0], 150) and w.logging_fault and w.pending() == 4 and seqs(c) == []                        # unpersisted: the caller flags its alert
    blocker.execute('ROLLBACK'); assert w.wait(us[-1], 3000)
    assert seqs(c) == [1, 2, 3, 4] and not w.logging_fault and c.execute('PRAGMA foreign_key_check').fetchall() == [] and w.counters['write_rejected'] == 0
    w.stop()

def test_a_constraint_failure_is_not_retried_rows_commit_one_by_one_and_the_alert_gets_a_null_frame_id(db):
    c, path = db; faults = []; clock = FakeClock(0, 0); w = writer(path, clock=clock, on_logging_fault=lambda t, m: faults.append((t, m))).start()
    bad = w.submit(Unit(1, [Stmt(FRAME, (1, 7), tag='frame'), Stmt(ALERT, (2, Ref('frame'), 1, 'co_threshold')), Stmt(AUDIT, (3,))]))   # node 7 is not in the roster
    assert w.wait(bad, 2000) and bad.rejected == 1 and w.counters['write_rejected'] == 1 and w.logging_fault
    assert seqs(c) == [] and seqs(c, 'alerts') == [2] and c.execute('SELECT frame_id FROM alerts').fetchone()[0] is None and seqs(c, 'audit_events') == [3]
    assert faults == [('frames', 'frame node_id not in roster')]
    w.wait(w.submit(Unit(4, [Stmt(FRAME, (4, 7))])), 2000); assert len(faults) == 1                                  # same message inside one minute: counted, not logged again
    clock.advance(61000); w.wait(w.submit(Unit(5, [Stmt(FRAME, (5, 7))])), 2000); assert len(faults) == 2 and w.counters['write_rejected'] == 3
    ok = w.submit(frame_u(6)); assert w.wait(ok, 2000) and not w.logging_fault and seqs(c) == [6]                    # the next clean unit clears LOGGING FAULT
    w.stop()

def test_a_full_queue_drops_the_oldest_droppable_unit_first_never_the_head_and_never_an_alert_unit(db):
    c, path = db; w = writer(path, queue_max=3)                                                                      # not started: the queue only fills
    a, d1, d2 = w.submit(frame_u(1, droppable=True)), w.submit(frame_u(2, droppable=True)), w.submit(frame_u(3))
    w.submit(frame_u(4)); assert w.counters['retry_buffer_dropped'] == 1 and [u.event_seq for u in w._q] == [1, 3, 4] and w.logging_fault   # head (1) kept, oldest other droppable (2) went
    w.submit(frame_u(5)); w.submit(frame_u(6)); assert w.counters['queue_overflow'] == 2 and w.pending() == 5 and w.counters['retry_buffer_dropped'] == 1   # nothing droppable: kept and counted
    w.start(); assert w.wait(w._q[-1], 3000); w.stop()
    assert seqs(c) == [1, 3, 4, 5, 6] and len(set(seqs(c))) == 5                                                      # gaps are fine, duplicates are not

def test_event_seq_stays_unique_and_increasing_after_a_forced_overflow(db):
    c, path = db; w = writer(path, queue_max=2); nxt = init_event_seq(c); last = None
    for _ in range(10): last = w.submit(frame_u(nxt, droppable=True)); nxt += 1
    w.start(); assert w.wait(last, 3000); w.stop(); got = seqs(c)
    assert got == sorted(set(got)) and got[-1] == 10 and w.counters['retry_buffer_dropped'] == 8 and init_event_seq(c) == 11

def test_operator_units_commit_with_synchronous_full_then_set_it_back(db):
    c, path = db; calls = []
    class W(DBWriter):
        def _set_sync(self, mode): calls.append(mode); super()._set_sync(mode)
    w = W(path, FakeClock(0, 0), synchronous='NORMAL', retry_sleep_s=0.005).start()
    u = w.submit(frame_u(1)); assert w.wait(u, 2000) and calls == []
    u = w.submit(Unit(2, [Stmt(AUDIT, (2,))], durable=True)); assert w.wait(u, 2000) and calls == ['FULL', 'NORMAL']
    w.stop()

def test_stop_drains_the_queue_and_the_writer_thread_ends(db):
    c, path = db; w = writer(path).start(); [w.submit(frame_u(i)) for i in range(1, 51)]; w.stop()
    assert seqs(c) == list(range(1, 51)) and not w._thread.is_alive()
`);
  append('docs/PROGRESS.md', '- Part 11-1 done: io/db_writer.py (connect_db factory with the 2.1 pragmas, run_migrations with a before_apply backup hook and a refusal of a newer database, init_event_seq over the six columns, DBWriter: one bounded ordered queue, retry in place for transient errors, one-by-one fallback for constraint errors with write_rejected and a rate-limited LOGGING_FAULT callback, oldest droppable unit dropped first, synchronous=FULL for operator units), host/tests/test_db_schema.py, host/tests/test_db_writer.py; settings loader, backup core, cli, hashes and seed-roster are P11-2');
}
