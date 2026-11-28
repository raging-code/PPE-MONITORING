"""S8-6 (ADR 0075): End shift ends every open jacket assignment inside the same atomic unit that closes the session, so the next shift starts with nobody on a jacket.
Real database, writer and FakeClock, through HostPort.end_session. Covered: the assignments end at the close time, nothing is deleted, the END_SHIFT row lists the ended jackets (ids only),
a shift with no assignments ends nothing, a rolled-back End shift ends nothing, a person can be put on a jacket again afterwards, and the history stays for the export.
Requirements: REQ-SES-002."""
import json
from ppe_host.services import firefighters as F, firefighter_export as FX
from test_sessions import eport, err, rows
from test_ingest import send
from test_gv_bytes import pack
from test_effect_rows import wait
from test_firefighter_export import parse

def person(c, clock, name, node=None):
    fid, _ = F.add_firefighter(c, clock.wall_ms(), full_name=name, age_years=30, height_cm=180, weight_kg=80, resting_hr=60, smoker=False, consent=True, consent_form_version='v1', consent_witness='W')
    if node is not None: F.assign(c, clock.wall_ms(), node, fid)
    return fid
def open_rows(c): return [(r['node_id'], r['firefighter_id']) for r in rows(c, 'SELECT node_id, firefighter_id FROM firefighter_assignments WHERE end_ts IS NULL ORDER BY node_id')]

def test_end_shift_ends_every_open_assignment_at_the_close_time_and_deletes_nothing(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); a = person(c, clock, 'Sam One', 1); b = person(c, clock, 'Pat Two', 2); assert open_rows(c) == [(1, a), (2, b)]
    clock.advance(5000); p.end_session(1, 1)
    s = rows(c, 'SELECT ended_ts FROM sessions WHERE session_id = 1')[0]['ended_ts']
    x = rows(c, 'SELECT node_id, firefighter_id, start_ts, end_ts FROM firefighter_assignments ORDER BY node_id')
    assert open_rows(c) == [] and len(x) == 2 and all(r['end_ts'] == s and r['end_ts'] >= r['start_ts'] for r in x)       # ended at the moment the session closed, rows kept
    assert rows(c, 'SELECT COUNT(*) AS n FROM firefighters')[0]['n'] == 2 and all(r['active'] == 1 for r in rows(c, 'SELECT active FROM firefighters'))   # the people stay active, only the jackets end
    w.stop()

def test_the_end_shift_row_lists_the_ended_jackets_by_id_and_never_a_name(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); a = person(c, clock, 'Sam One', 1); b = person(c, clock, 'Pat Two', 3); p.end_session(1, 1)
    r = rows(c, "SELECT reason FROM audit_events WHERE action = 'END_SHIFT'")[0]['reason']
    assert json.loads(r)['ended_assignments'] == [[1, a], [3, b]] and 'Sam' not in r and 'Pat' not in r and 'FFR' not in r; w.stop()

def test_a_shift_with_nobody_on_a_jacket_ends_nothing_and_still_closes(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); person(c, clock, 'Sam One'); res = p.end_session(1, 1)
    assert res.new_session_id == 2 and rows(c, 'SELECT * FROM firefighter_assignments') == []
    assert json.loads(rows(c, "SELECT reason FROM audit_events WHERE action = 'END_SHIFT'")[0]['reason'])['ended_assignments'] == []; w.stop()

def test_a_conflicting_end_shift_ends_no_assignment(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); person(c, clock, 'Sam One', 1); p.end_session(1, 1)
    person_b = person(c, clock, 'Pat Two', 2)
    assert err(lambda: p.end_session(1, 1)) == (409, 'STATE_CONFLICT') and open_rows(c) == [(2, person_b)]; w.stop()      # the second click (old session id) touches nothing

def test_after_end_shift_the_same_person_can_be_put_on_a_jacket_again_and_the_old_row_keeps_the_history(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); a = person(c, clock, 'Sam One', 1); clock.advance(1000); p.end_session(1, 1); clock.advance(1000)
    assert F.assign(c, clock.wall_ms(), 1, a) == 'assigned' and open_rows(c) == [(1, a)]
    assert len(rows(c, 'SELECT * FROM firefighter_assignments WHERE firefighter_id = %d' % a)) == 2; w.stop()

def test_a_reading_before_the_end_stays_with_the_person_and_a_reading_after_it_belongs_to_nobody_until_someone_is_put_on(tmp_path):
    c, w, clock, ing, p = eport(tmp_path); a = person(c, clock, 'Sam One', 1); p.start_monitoring(1, 'n')
    r = send(ing, clock, pack(seq=1, flags=0)); wait(w, r.unit); clock.advance(1000); p.end_session(1, 1)   # a reading in the very millisecond of the close goes to the next shift (the export's hand-over rule)
    r2 = send(ing, clock, pack(seq=2, flags=0)); wait(w, r2.unit)
    _, out = parse(FX.iter_csv(tmp_path / 't.db')); assert [(x['session_id'], x['firefighter']) for x in out] == [('1', 'FFR-01'), ('2', '')]
    clock.advance(1000); F.assign(c, clock.wall_ms(), 1, a); r3 = send(ing, clock, pack(seq=3, flags=0)); wait(w, r3.unit)
    _, out = parse(FX.iter_csv(tmp_path / 't.db')); assert [x['firefighter'] for x in out] == ['FFR-01', '', 'FFR-01']; w.stop()
