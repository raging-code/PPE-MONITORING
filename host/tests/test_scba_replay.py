"""P19c-2: the latest SCBA correction of each node is re-applied from audit_events after a restart (design 2.10, 8 "SCBA_CORRECTION replay test"). Real migrated database."""
import pathlib
import pytest
from ppe_host.io.db_writer import connect_db, load_scba_corrections, run_migrations
MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
class Db:
    def __init__(self, path):
        self.path, self.c, self.seq = path, connect_db(path), 0
        run_migrations(self.c, str(MIG), 1000)
        self.c.executemany('INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (?, ?, \'h\', 0, 0)', [(1, 'Ana'), (2, 'Ben')])
        self.c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03')])
        self.session(1)
    def session(self, sid):
        if sid > 1: self.c.execute("UPDATE sessions SET ended_ts = 1, end_kind = 'ENDED' WHERE ended_ts IS NULL")
        self.c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (?, 0, 'LIVE', 'b', 'c', 's')", (sid,)); self.sid = sid
    def frame(self, node, ts, scba=0, expired=0, verify='OK', seq_class='fresh'):
        self.seq += 1
        self.c.execute("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, id_mode, status3, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'OK', ?, '00', 0)",
                       (self.seq, self.sid, node, ts, 0x40 | node | (scba << 3), expired << 3, verify, seq_class))
    def correct(self, node, ts, op=1):
        self.seq += 1; self.c.execute("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id, reason) VALUES (?, ?, ?, ?, 'SCBA_CORRECTION', ?, 'n')", (self.sid, self.seq, ts, op, node))
    def load(self):
        r = connect_db(self.path, readonly=True)
        try: return load_scba_corrections(r)
        finally: r.close()
@pytest.fixture
def db(tmp_path): return Db(tmp_path / 't.db')

def test_no_correction_gives_an_empty_result(db): db.frame(1, 10); assert db.load() == {}
def test_the_latest_correction_of_each_node_wins_and_carries_the_operator_name(db):
    db.frame(1, 5); db.frame(2, 5); db.correct(1, 10, 1); db.correct(2, 11, 2); db.correct(1, 20, 2)
    assert db.load() == {1: (20, 'Ben'), 2: (11, 'Ben')}
def test_it_survives_end_shift_and_a_restart_across_sessions(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.session(2); db.frame(1, 30, scba=1); db.frame(1, 40, scba=1)
    assert db.load() == {1: (10, 'Ana')}
def test_a_later_frame_that_changes_the_scba_bit_ends_the_correction(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=1); assert 1 in db.load()
    db.frame(1, 14, scba=0); assert db.load() == {}
def test_a_later_frame_that_changes_the_scba_expired_bit_ends_the_correction(db):
    db.frame(1, 5, scba=1, expired=0); db.correct(1, 10); db.frame(1, 12, scba=1, expired=1); assert db.load() == {}
def test_a_change_that_goes_back_does_not_bring_the_correction_back(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0); db.frame(1, 14, scba=1); assert db.load() == {}
def test_a_frame_before_the_correction_and_a_frame_of_another_node_do_not_end_it(db):
    db.frame(1, 3, scba=0); db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(2, 12, scba=0); db.frame(2, 14, scba=1); assert db.load() == {1: (10, 'Ana')}
def test_a_frame_at_the_same_time_as_the_correction_is_the_baseline(db):
    db.frame(1, 10, scba=1); db.correct(1, 10); db.frame(1, 11, scba=1); assert db.load() == {1: (10, 'Ana')}
@pytest.mark.parametrize('verify,seq_class', [('BAD_MAC', 'fresh'), ('BAD_CRC', 'fresh'), ('OK', 'duplicate'), ('OK', 'suspect')])
def test_an_unverified_duplicate_or_suspect_frame_never_ends_the_correction(db, verify, seq_class):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0, verify=verify, seq_class=seq_class); assert db.load() == {1: (10, 'Ana')}
def test_a_reboot_frame_counts_as_a_frame(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0, seq_class='reboot'); assert db.load() == {}
def test_with_no_earlier_frame_the_first_later_frame_is_the_baseline(db):
    db.correct(1, 10); assert db.load() == {1: (10, 'Ana')}
    db.frame(1, 12, scba=1); db.frame(1, 14, scba=1); assert db.load() == {1: (10, 'Ana')}
    db.frame(1, 16, scba=0); assert db.load() == {}
def test_a_newer_correction_after_the_change_applies_again(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0); assert db.load() == {}
    db.correct(1, 20, 2); db.frame(1, 22, scba=0); assert db.load() == {1: (20, 'Ben')}
def test_loading_is_read_only_and_touches_no_alert(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); before = [db.c.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0] for t in ('alerts', 'audit_events', 'frames')]
    assert db.load() == {1: (10, 'Ana')} and [db.c.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0] for t in ('alerts', 'audit_events', 'frames')] == before
