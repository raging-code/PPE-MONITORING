"""services/csv_export.py (P26-1, ADR 0038): the full CSV export of design 2.5, the view v_full_log written as text/csv.
What it does (all of it from 2.5, 2.11 and 14.5):
  - One row per v_full_log row, in strict event_seq order (ties by log_ts, as the view orders them): frame, alert_raised, alert_cleared, audit, system and advisory records. An alert raised at event_seq 10 and cleared at 45
    comes after the events between. base_health, keys, tokens and audit rows whose session_id is NULL are not in the view, so they are not in the file.
  - session_id given: only the rows whose session_id column is that session (the cleared row of an alert that outlives its session stays with the session that raised it, 2.11). Not given: the whole database in one file.
  - Formula protection: a text value that starts with =, +, -, @, tab or CR gets a leading apostrophe. raw_hex always gets one, so a hex string of digits or with an 'E' (01001234E5...) is never read as a number.
    Numbers (rssi, snr, temp_c, co_ppm ...) are written as plain numbers, so a negative RSSI such as -68.5 is never touched. A value that is None is an empty field.
  - Read-only connection, rows fetched CHUNK_ROWS (500) at a time, and one bytes chunk handed out per fetch, so the caller (the route, in a worker thread) sends the file while it is read and never holds it whole.
Not here: the route and its CSV_EXPORT audit row (api/api_rest.py), exports/ files (the purge CLI of P26-2 deletes exports/session_<id>_*.csv; nothing in this part writes one)."""
import csv, io
from ..io.db_writer import connect_db

CHUNK_ROWS = 500
DANGEROUS = ('=', '+', '-', '@', '\t', '\r')
BASE_SQL = 'SELECT * FROM v_full_log'

def safe_text(v):
    """A text value for a spreadsheet: a leading apostrophe when it could be read as a formula. Numbers and None are not text and pass through (None as an empty field)."""
    if v is None: return ''
    if isinstance(v, str) and v.startswith(DANGEROUS): return "'" + v
    return v

def row_values(names, row):
    out = []
    for n, v in zip(names, row):
        if n == 'raw_hex': out.append('' if v is None or v == '' else "'" + str(v))
        else: out.append(safe_text(v))
    return out

def iter_csv(db_path, session_id=None, chunk=CHUNK_ROWS):
    """Yield the file as bytes chunks: the header and the first rows, then `chunk` rows per piece. Runs in a worker thread; the connection is closed when the generator ends or is closed (a client that went away)."""
    conn = connect_db(db_path, readonly=True)
    try:
        if session_id is None: cur = conn.execute(BASE_SQL + ' ORDER BY event_seq, log_ts')
        else: cur = conn.execute(BASE_SQL + ' WHERE session_id = ? ORDER BY event_seq, log_ts', (session_id,))
        names = [d[0] for d in cur.description]
        buf = io.StringIO(); w = csv.writer(buf, lineterminator='\r\n'); w.writerow(names)
        while True:
            rows = cur.fetchmany(chunk)
            for r in rows: w.writerow(row_values(names, r))
            data = buf.getvalue()
            if data: yield data.encode('utf-8')
            buf.seek(0); buf.truncate()
            if len(rows) < chunk: break
    finally: conn.close()
