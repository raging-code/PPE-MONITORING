"""S8-4 (ADR 0073): services/firefighter_export.py and GET /api/firefighters/readings.csv. Each verified, non-duplicate frame is joined to the alias of the firefighter who wore its node at rx_ts:
the hand-over instant, an unassigned stretch, a swap of two jackets, a person set inactive, overlapping history after a clock step, the alias only (never the name), formula protection, the session filter,
500-row chunks and the route (token, Origin, CSV_EXPORT audit row with its reason, file name). Requirements: REQ-API-001, REQ-API-002."""
import csv, io
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R
from ppe_host.services import firefighter_export as FX, firefighters as F
from test_db_schema import frame, new_db, session
from test_api_endpoint_table import GOOD, EVIL, Port

NOW = 1_800_000_000_000
BASE = dict(age_years=34, height_cm=180, weight_kg=82.5, resting_hr=58, smoker=False, consent=True, consent_form_version='v1', consent_witness='Witness One')
SAM, PAT = 'Sam Example', 'Pat Other'

def parse(chunks):
    text = b''.join(chunks).decode('utf-8'); rows = list(csv.reader(io.StringIO(text, newline=''))); return rows[0], [dict(zip(rows[0], r)) for r in rows[1:]]

def db_with_people(tmp_path):
    """Two people (FFR-01 Sam, FFR-02 Pat). Session 1 is closed, session 2 is open. Nobody is assigned yet."""
    c = new_db(tmp_path); session(c, 1, ended=9000); session(c, 2)
    F.add_firefighter(c, NOW, full_name=SAM, **BASE); F.add_firefighter(c, NOW, full_name=PAT, **BASE)
    return c, tmp_path / 't.db'

def who(rows): return [(int(r['event_seq']), r['firefighter']) for r in rows]

def test_a_reading_gets_the_firefighter_who_wore_the_node_then_and_the_hand_over_instant_goes_to_the_new_wearer(tmp_path):
    c, db = db_with_people(tmp_path)
    F.assign(c, 1000, 1, 1); F.assign(c, 2000, 1, 2)                       # node 1: Sam from 1000, Pat from 2000
    for seq, ts in [(1, 999), (2, 1000), (3, 1999), (4, 2000), (5, 2500)]: frame(c, seq, 1, rx_ts=ts)
    head, rows = parse(FX.iter_csv(db))
    assert who(rows) == [(1, ''), (2, 'FFR-01'), (3, 'FFR-01'), (4, 'FFR-02'), (5, 'FFR-02')]      # before the first jacket: empty, never guessed

def test_two_people_swapping_jackets_keep_their_own_readings(tmp_path):
    c, db = db_with_people(tmp_path)
    F.assign(c, 1000, 1, 1); F.assign(c, 1000, 2, 2)
    frame(c, 1, 1, rx_ts=1500); frame(c, 2, 2, rx_ts=1500)
    F.assign(c, 3000, 1, None); F.assign(c, 3000, 2, None); F.assign(c, 3000, 1, 2); F.assign(c, 3000, 2, 1)       # they swap at 3000
    frame(c, 3, 1, rx_ts=3500); frame(c, 4, 2, rx_ts=3500)
    _, rows = parse(FX.iter_csv(db)); assert who(rows) == [(1, 'FFR-01'), (2, 'FFR-02'), (3, 'FFR-02'), (4, 'FFR-01')]

def test_a_node_nobody_wears_and_a_node_of_someone_else_are_not_mixed_up(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    frame(c, 1, 1, rx_ts=1500); frame(c, 2, 2, rx_ts=1500); frame(c, 3, 3, rx_ts=1500)
    _, rows = parse(FX.iter_csv(db)); assert who(rows) == [(1, 'FFR-01'), (2, ''), (3, '')]

def test_setting_a_firefighter_inactive_keeps_the_old_readings_and_ends_the_new_ones(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    frame(c, 1, 1, rx_ts=1500)
    outcome, stmts, _, _ = F.plan_set_active(c, 1, False, 2000)
    assert outcome == 'changed'; F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
    frame(c, 2, 1, rx_ts=2500)
    _, rows = parse(FX.iter_csv(db)); assert who(rows) == [(1, 'FFR-01'), (2, '')]

def test_overlapping_assignments_after_a_clock_step_still_give_one_row_per_reading(tmp_path):
    c, db = db_with_people(tmp_path)
    c.execute('INSERT INTO firefighter_assignments(node_id, firefighter_id, start_ts, end_ts) VALUES (1, 1, 1000, 5000)')      # a clock that went back: two rows cover 3000
    c.execute('INSERT INTO firefighter_assignments(node_id, firefighter_id, start_ts, end_ts) VALUES (1, 2, 2000, NULL)')
    frame(c, 1, 1, rx_ts=1500); frame(c, 2, 1, rx_ts=3000)
    _, rows = parse(FX.iter_csv(db)); assert who(rows) == [(1, 'FFR-01'), (2, 'FFR-02')]      # the one that started last wins; no row is doubled

def test_only_verified_non_duplicate_frames_are_in_the_file(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    frame(c, 1, 1, rx_ts=1500); frame(c, 2, 1, rx_ts=1501, seq_class='duplicate'); frame(c, 3, None, rx_ts=1502, verify='BAD_MAC'); frame(c, 4, 1, rx_ts=1503, seq_class='suspect')
    _, rows = parse(FX.iter_csv(db)); assert [int(r['event_seq']) for r in rows] == [1, 4]

def test_the_columns_decoded_values_and_the_alias_only(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    frame(c, 1, 1, rx_ts=1500, co_x10=123, temp_x100=2512, hum=40, hr=88, motion_x100=105, bat=77, flags=0x04, id_mode=0x49, final_level='WARNING', reasons='co >= 35')
    head, rows = parse(FX.iter_csv(db)); r = rows[0]
    assert head == list(FX.COLUMNS) and head[:5] == ['session_id', 'event_seq', 'rx_ts', 'firefighter', 'node_id']
    assert (r['session_id'], r['rx_ts'], r['firefighter'], r['node_id'], r['co_ppm'], r['temp_c'], r['hum_pct'], r['hr'], r['motion_g'], r['bat_pct'], r['scba_on'], r['mandown'], r['final_level'], r['reasons']) == \
           ('1', '1500', 'FFR-01', '1', '12.3', '25.12', '40', '88', '1.05', '77', '1', '1', 'WARNING', 'co >= 35')
    text = b''.join(FX.iter_csv(db)).decode(); assert SAM not in text and PAT not in text and 'raw_hex' not in text and 'age' not in head and 'weight_kg' not in head

def test_a_text_that_could_be_a_formula_gets_a_leading_apostrophe_and_numbers_stay_plain(tmp_path):
    c, db = db_with_people(tmp_path); frame(c, 1, 1, rx_ts=1500, reasons='=HYPERLINK("http://x","y")', temp_x100=-505)
    _, rows = parse(FX.iter_csv(db)); assert rows[0]['reasons'].startswith("'=") and rows[0]['temp_c'] == '-5.05' and rows[0]['hr'] == ''      # a missing value is an empty field

def test_the_session_filter_and_an_unknown_session_and_the_order(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    frame(c, 2, 1, rx_ts=1600, session_id=2); frame(c, 7, 1, rx_ts=1500, session_id=1); frame(c, 3, 1, rx_ts=1400, session_id=1)
    _, allrows = parse(FX.iter_csv(db)); assert [(r['session_id'], r['event_seq']) for r in allrows] == [('1', '3'), ('1', '7'), ('2', '2')]
    _, s2 = parse(FX.iter_csv(db, 2)); assert [r['session_id'] for r in s2] == ['2']
    chunks = list(FX.iter_csv(db, 99)); head, rows = parse(chunks); assert rows == [] and head[0] == 'session_id' and len(chunks) == 1

def test_the_file_is_read_in_500_row_chunks_and_a_closed_generator_releases_the_connection(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    c.executemany("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, 1, 1, ?, ?, 'OK', 'OK', 'fresh', '00', 0.1)", [(i, 1000 + i, i) for i in range(1, 1202)])
    chunks = list(FX.iter_csv(db)); assert len(chunks) == 3 and [b.count(b'\r\n') for b in chunks] == [501, 500, 201]
    _, rows = parse(chunks); assert len(rows) == 1201 and {r['firefighter'] for r in rows} == {'FFR-01'}
    it = FX.iter_csv(db); next(it); it.close(); c.execute('PRAGMA wal_checkpoint(TRUNCATE)')

# ---- the route ----
@pytest.fixture
def rig(tmp_path, monkeypatch):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1); frame(c, 1, 1, rx_ts=1500); frame(c, 5, 1, rx_ts=1600, session_id=2)
    monkeypatch.setattr(R, '_now_ms', lambda: 1_700_000_000_000); port = Port(); port.audits_full = []; orig = port.audit
    port.audit = lambda action, operator_id=None, node_id=None, episode_id=None, reason=None: (port.audits_full.append((action, operator_id, reason)), orig(action))[1]
    return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port

def test_the_route_streams_text_csv_with_a_file_name_and_audits_csv_export_with_a_reason(rig):
    client, port = rig; r = client.get('/api/firefighters/readings.csv', headers=GOOD)
    assert r.status_code == 200 and r.headers['content-type'].startswith('text/csv') and r.headers['cache-control'] == 'no-store'
    assert r.headers['content-disposition'] == 'attachment; filename="firefighter_readings_all_20231114T221320Z.csv"' and r.text.startswith('session_id,event_seq,rx_ts,firefighter,node_id')
    assert port.audits_full == [('CSV_EXPORT', 1, 'firefighter readings, all')] and SAM not in r.text and SAM not in str(port.audits_full)
    r = client.get('/api/firefighters/readings.csv', params={'session_id': 2}, headers=GOOD)
    assert r.headers['content-disposition'].startswith('attachment; filename="firefighter_readings_session_2_') and port.audits_full[-1] == ('CSV_EXPORT', 1, 'firefighter readings, session 2')
    _, rows = parse([r.content]); assert who(rows) == [(5, 'FFR-01')]

def test_the_route_needs_a_token_and_a_good_origin_and_checks_the_query(rig):
    client, port = rig; url = '/api/firefighters/readings.csv'
    r = client.get(url); assert r.status_code == 401 and r.json()['error_code'] == 'UNAUTHENTICATED' and 'CSV_EXPORT' not in port.audits
    r = client.get(url, headers={**GOOD, 'Origin': EVIL}); assert r.status_code == 403 and 'CSV_EXPORT' not in port.audits and 'ORIGIN_REJECTED' in port.audits
    assert client.get(url, params={'session_id': 'x'}, headers=GOOD).status_code == 422 and client.get(url, params={'session_id': -1}, headers=GOOD).status_code == 422
    assert not any(a[0] == 'CSV_EXPORT' for a in port.audits_full)      # a refused request writes no export row

def test_the_full_export_is_unchanged_and_has_no_firefighter_column(rig):
    client, _ = rig; r = client.get('/api/export.csv', headers=GOOD)
    assert r.status_code == 200 and 'firefighter' not in r.text.splitlines()[0] and 'FFR-01' not in r.text
