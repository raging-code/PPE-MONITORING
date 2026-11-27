"""P26-1 (ADR 0038): services/csv_export.py and GET /api/export.csv. The export of v_full_log: all six record types in strict event_seq order, decoded telemetry and raw_hex on frame rows,
no base_health, no keys or tokens, no audit row whose session_id is NULL; formula protection (leading apostrophe for =, +, -, @, tab and CR, raw_hex always); plain numbers (negative RSSI); the per-session filter
(the cleared row of an alert that outlives its session stays with the session that raised it); 500-row chunks; the route (token and Origin, CSV_EXPORT audit row, text/csv, file name, read-only)."""
import csv, io, time
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R
from ppe_host.services import csv_export as CE
from test_db_schema import alert, frame, new_db, session
from test_api_endpoint_table import GOOD, EVIL, Port

HEX = '01001234E5' + '00' * 18            # digits and an E: a spreadsheet reads 01001234E5... as a number

def sysrow(c, sid, seq, kind, detail, ts=1): c.execute('INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (?, ?, ?, ?, ?)', (sid, seq, ts, kind, detail))
def auditrow(c, sid, seq, action, ts=1, reason=None): c.execute('INSERT INTO audit_events(session_id, event_seq, ts, action, reason) VALUES (?, ?, ?, ?, ?)', (sid, seq, ts, action, reason))

def parse(chunks):
    text = b''.join(chunks).decode('utf-8'); rows = list(csv.reader(io.StringIO(text, newline=''))); return rows[0], [dict(zip(rows[0], r)) for r in rows[1:]]

def full(tmp_path):
    """Two sessions. Session 1 (closed) raised a co_threshold alert at event_seq 10 that session 2 cleared at 45. Every record type, a negative RSSI, hostile text, base_health and a NULL-session audit row."""
    c = new_db(tmp_path); session(c, 1, ended=500); session(c, 2)
    frame(c, 5, 1, rx_ts=50, co_x10=123, temp_x100=2512, rssi=-68.5, snr=9.25, raw_hex=HEX, flags=0x04, id_mode=0x49, bat=77)
    alert(c, 10, raised_ts=100, cleared_ts=450, cleared_event_seq=45, reasons='co >= 35')
    frame(c, 20, 1, rx_ts=200, raw_hex='AB')
    auditrow(c, 1, 30, 'ACK_ALERT', ts=300, reason='=HYPERLINK("http://x","y")')
    sysrow(c, 1, 40, 'HOST_START', '+1 -2 @3', ts=400)
    c.execute("INSERT INTO advisory_summaries(session_id, event_seq, ts, node_id, window_s, risk, reasons, action, source, quality) VALUES (1, 41, 410, 1, 60, 'NOMINAL', 'all quiet', 'none', 'table', 'high')")
    sysrow(c, 2, 46, 'COUNTERS', '\tcell', ts=460); sysrow(c, 2, 47, 'COUNTERS', '\rcr', ts=470)
    c.execute('INSERT INTO base_health(session_id, ts, uptime_ms, bat_pct, rx_ok, rx_bad_len, rx_bad_crc, rx_bad_mac) VALUES (2, 480, 1, 90, 1, 0, 0, 0)')
    c.execute("INSERT INTO audit_events(session_id, event_seq, ts, action, reason) VALUES (NULL, 48, 490, 'SESSION_PURGED', '9')")
    return c, tmp_path / 't.db'

def test_all_six_record_types_in_strict_event_seq_order_and_an_alert_clear_comes_after_the_events_between(tmp_path):
    c, db = full(tmp_path); head, rows = parse(CE.iter_csv(db))
    assert head[:9] == ['session_id', 'event_seq', 'log_ts', 'record_type', 'node_id', 'level', 'code', 'detail', 'operator_id'] and head[-1] == 'raw_hex'
    assert {r['record_type'] for r in rows} == {'frame', 'alert_raised', 'alert_cleared', 'audit', 'system', 'advisory'}
    seqs = [int(r['event_seq']) for r in rows]; assert seqs == sorted(seqs) == [5, 10, 20, 30, 40, 41, 45, 46, 47]
    assert [r['record_type'] for r in rows].index('alert_raised') < [r['record_type'] for r in rows].index('audit') < [r['record_type'] for r in rows].index('alert_cleared')

def test_base_health_and_audit_rows_without_a_session_are_not_exported_and_no_secret_column_exists(tmp_path):
    c, db = full(tmp_path); head, rows = parse(CE.iter_csv(db)); text = '\n'.join(','.join(r.values()) for r in rows)
    assert 'SESSION_PURGED' not in text and not any(r['code'] == 'SESSION_PURGED' for r in rows)
    assert not any(h in head for h in ('uptime_ms', 'rx_ok', 'bat_pct_base', 'token', 'token_hash', 'cmac_key', 'key', 'server_salt'))
    assert len(rows) == 9                                                               # the base_health row (event-less) and the NULL-session audit row add nothing

def test_a_frame_row_carries_the_decoded_telemetry_and_raw_hex(tmp_path):
    c, db = full(tmp_path); _, rows = parse(CE.iter_csv(db)); f = rows[0]
    assert (f['record_type'], f['node_id'], f['co_ppm'], f['temp_c'], f['bat_pct'], f['mandown'], f['scba_on'], f['verify']) == ('frame', '1', '12.3', '25.12', '77', '1', '1', 'OK')

def test_formula_leading_text_gets_an_apostrophe_and_a_negative_rssi_stays_a_plain_number(tmp_path):
    c, db = full(tmp_path); _, rows = parse(CE.iter_csv(db)); by = {int(r['event_seq']): r for r in rows}
    assert by[30]['detail'] == '\'=HYPERLINK("http://x","y")' and by[40]['detail'] == "'+1 -2 @3" and by[46]['detail'] == "'\tcell" and by[47]['detail'] == "'\rcr"
    assert by[5]['rssi'] == '-68.5' and by[5]['snr'] == '9.25' and by[5]['temp_c'] == '25.12'          # numbers are never prefixed
    assert CE.safe_text('-5') == "'-5" and CE.safe_text('plain') == 'plain' and CE.safe_text(-68.5) == -68.5 and CE.safe_text(None) == ''

def test_raw_hex_is_always_written_as_a_text_literal(tmp_path):
    c, db = full(tmp_path); _, rows = parse(CE.iter_csv(db)); by = {int(r['event_seq']): r for r in rows}
    assert by[5]['raw_hex'] == "'" + HEX and by[20]['raw_hex'] == "'AB" and by[10]['raw_hex'] == '' and by[30]['raw_hex'] == ''
    assert CE.row_values(['raw_hex'], ('0123',)) == ["'0123"] and CE.row_values(['raw_hex'], (None,)) == ['']

def test_a_per_session_export_is_filtered_on_the_session_id_column_and_the_whole_database_is_one_file(tmp_path):
    c, db = full(tmp_path)
    _, s1 = parse(CE.iter_csv(db, 1)); _, s2 = parse(CE.iter_csv(db, 2)); _, allrows = parse(CE.iter_csv(db))
    assert {r['session_id'] for r in s1} == {'1'} and {r['session_id'] for r in s2} == {'2'} and len(s1) + len(s2) == len(allrows)
    assert [r['record_type'] for r in s1 if r['code'] == 'co_threshold'] == ['alert_raised', 'alert_cleared']        # the alert and its clear stay together with the session that raised it
    assert [int(r['event_seq']) for r in s2] == [46, 47]

def test_an_unknown_session_gives_the_header_row_only(tmp_path):
    c, db = full(tmp_path); chunks = list(CE.iter_csv(db, 99)); head, rows = parse(chunks); assert rows == [] and head[0] == 'session_id' and len(chunks) == 1

def test_the_file_is_read_in_500_row_chunks_and_a_closed_generator_releases_the_connection(tmp_path):
    c = new_db(tmp_path); session(c)
    c.executemany('INSERT INTO system_events(session_id, event_seq, ts, kind, detail) VALUES (1, ?, ?, \'COUNTERS\', ?)', [(i, i, 'x') for i in range(1, 1202)])
    chunks = list(CE.iter_csv(tmp_path / 't.db'))
    assert len(chunks) == 3 and [b.count(b'\r\n') for b in chunks] == [501, 500, 201]          # header + 500, 500, 201 rows
    head, rows = parse(chunks); assert len(rows) == 1201
    it = CE.iter_csv(tmp_path / 't.db'); next(it); it.close()                                      # the client went away: no error, the connection is closed
    c.execute('PRAGMA wal_checkpoint(TRUNCATE)')

# ---- the route ----
@pytest.fixture
def rig(tmp_path, monkeypatch):
    c, db = full(tmp_path); monkeypatch.setattr(R, '_now_ms', lambda: 1_700_000_000_000); port = Port()
    port.audits_full = []; orig = port.audit
    port.audit = lambda action, operator_id=None, node_id=None, episode_id=None, reason=None: (port.audits_full.append((action, operator_id, reason)), orig(action))[1]
    return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port

def test_the_route_streams_text_csv_with_a_file_name_and_audits_csv_export(rig):
    client, port = rig; r = client.get('/api/export.csv', headers=GOOD)
    assert r.status_code == 200 and r.headers['content-type'].startswith('text/csv') and r.headers['cache-control'] == 'no-store'
    assert r.headers['content-disposition'] == 'attachment; filename="export_all_20231114T221320Z.csv"' and r.text.startswith('session_id,event_seq,log_ts,record_type')
    assert port.audits_full == [('CSV_EXPORT', 1, 'all')]
    r = client.get('/api/export.csv', params={'session_id': 2}, headers=GOOD)
    assert r.headers['content-disposition'].startswith('attachment; filename="export_session_2_') and port.audits_full[-1] == ('CSV_EXPORT', 1, '2')
    _, rows = parse([r.content]); assert [int(x['event_seq']) for x in rows] == [46, 47]

def test_the_route_needs_a_token_and_a_good_origin_and_checks_the_query(rig):
    client, port = rig
    r = client.get('/api/export.csv'); assert r.status_code == 401 and r.json()['error_code'] == 'UNAUTHENTICATED' and 'CSV_EXPORT' not in port.audits
    r = client.get('/api/export.csv', headers={**GOOD, 'Origin': EVIL}); assert r.status_code == 403 and 'CSV_EXPORT' not in port.audits and 'ORIGIN_REJECTED' in port.audits
    r = client.get('/api/export.csv', params={'session_id': 'x'}, headers=GOOD); assert r.status_code == 422 and r.json()['error_code'] == 'VALIDATION_ERROR'
    r = client.get('/api/export.csv', params={'session_id': -1}, headers=GOOD); assert r.status_code == 422

def test_the_export_reads_a_big_database_without_a_long_wait_for_the_first_chunk(tmp_path):
    c = new_db(tmp_path); session(c)
    c.executemany("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, 1, 1, ?, ?, 'OK', 'OK', 'fresh', ?, 0.1)", [(i, i, i, 'ab' * 23) for i in range(1, 60_001)])
    it = CE.iter_csv(tmp_path / 't.db'); t = time.perf_counter(); next(it); first = time.perf_counter() - t; n = 1 + sum(1 for _ in it)
    assert n == 120 and first < 3.0, 'first chunk after %.2f s' % first                              # 60,000 rows = 120 chunks of 500 (the header is in the first)
