"""services/firefighter_export.py (S8-4, ADR 0073): the readings of each firefighter as text/csv. A stored frame is joined to the firefighter who wore its node at the moment it was received, through
firefighter_assignments (node_id, start_ts, end_ts), so the file shows who each reading belongs to. The frozen export of design 2.5 (v_full_log, services/csv_export.py) is not touched.

What it does:
  - One row per reading, the rows of v_readings (a verified frame that is not a duplicate), in event_seq order within each session, sessions in session_id order.
  - firefighter is the ALIAS (FFR-01), never the name; the name and every other profile field stay in the firefighters table and are not in this file. A reading from a time when nobody was assigned to
    the node has an empty firefighter field: it is kept, never guessed.
  - The assignment that counts is the one with start_ts <= rx_ts and (end_ts is open or rx_ts < end_ts); if a clock step ever made two overlap, the one that started last wins, so a reading has exactly one row.
  - Same file rules as the full export: formula protection (a leading apostrophe), numbers as plain numbers, a None as an empty field, a read-only connection, 500 rows per fetch, one bytes chunk per fetch.
Not here: the route and its audit row (api/api_rest.py), the profile numbers (age, weight, resting heart rate) for the forecasting work (a separate decision, ADR 0073)."""
import csv, io
from ..io.db_writer import connect_db
from .csv_export import CHUNK_ROWS, row_values

COLUMNS = ('session_id', 'event_seq', 'rx_ts', 'firefighter', 'node_id', 'co_ppm', 'temp_c', 'hum_pct', 'hr', 'motion_g', 'bat_pct', 'scba_on', 'mandown', 'final_level', 'reasons')
BASE_SQL = ('SELECT f.session_id, f.event_seq, f.rx_ts,'
            ' (SELECT ff.alias FROM firefighter_assignments a JOIN firefighters ff ON ff.firefighter_id = a.firefighter_id'
            '  WHERE a.node_id = f.node_id AND a.start_ts <= f.rx_ts AND (a.end_ts IS NULL OR f.rx_ts < a.end_ts) ORDER BY a.start_ts DESC, a.assignment_id DESC LIMIT 1) AS firefighter,'
            ' f.node_id, ROUND(f.co_x10 / 10.0, 1) AS co_ppm, ROUND(f.temp_x100 / 100.0, 2) AS temp_c, f.hum AS hum_pct, f.hr, ROUND(f.motion_x100 / 100.0, 2) AS motion_g, f.bat AS bat_pct,'
            ' (f.id_mode >> 3) & 1 AS scba_on, (f.flags >> 2) & 1 AS mandown, f.final_level, f.reasons FROM v_readings f')

def iter_csv(db_path, session_id=None, chunk=CHUNK_ROWS):
    """Yield the file as bytes chunks (the header with the first rows, then `chunk` rows per piece), like services/csv_export.iter_csv. session_id given: only that session's readings."""
    conn = connect_db(db_path, readonly=True)
    try:
        if session_id is None: cur = conn.execute(BASE_SQL + ' ORDER BY f.session_id, f.event_seq')
        else: cur = conn.execute(BASE_SQL + ' WHERE f.session_id = ? ORDER BY f.session_id, f.event_seq', (session_id,))
        names = [d[0] for d in cur.description]; assert tuple(names) == COLUMNS
        buf = io.StringIO(); w = csv.writer(buf, lineterminator='\r\n'); w.writerow(names)
        while True:
            rows = cur.fetchmany(chunk)
            for r in rows: w.writerow(row_values(names, r))
            data = buf.getvalue()
            if data: yield data.encode('utf-8')
            buf.seek(0); buf.truncate()
            if len(rows) < chunk: break
    finally: conn.close()
