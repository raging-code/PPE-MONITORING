"""P11-1: DBWriter behaviour (design 2.1, 2.10, Section 1 commit paragraph, Rev 3.28 and 3.36). The disk stall is real: a second connection holds the write lock."""
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
