"""services/firefighters.py (S8-1, ADR 0070): who is wearing the PPE. Offline helpers for the CLI (and later the Settings screen): add a firefighter profile with its consent record,
assign a firefighter to a node (the jacket), and switch roster nodes on or off. No wire, no REST and no engine input: nothing here changes an alert or a threshold.

The dashboard and the audit log show only the alias (FFR-01). The real name lives in firefighters.full_name and is shown only by `cli list-firefighters --show-names` (and later the Settings
screen); it is never written to an audit row, a log line or an export. A profile cannot be saved without the consent record (the tick, the date, the form version and the witness).
Rows are never deleted by software: a person who leaves is set inactive and the assignment history stays, because the readings of their shifts are linked to them through it."""
import datetime as dt

class FirefighterError(ValueError):
    """A refused request; the message is shown to the person and nothing was written."""

RANGES = {'age_years': (16, 80), 'height_cm': (120, 230), 'weight_kg': (30, 250), 'resting_hr': (30, 120), 'max_hr': (100, 230), 'years_service': (0, 60)}
SEX = ('F', 'M', 'X')

def _num(name, v, required, integer):
    if v is None:
        if required: raise FirefighterError('%s is required' % name)
        return None
    try: x = int(v) if integer else float(v)
    except (TypeError, ValueError): raise FirefighterError('%s must be a number' % name) from None
    lo, hi = RANGES[name]
    if not lo <= x <= hi: raise FirefighterError('%s must be %s to %s' % (name, lo, hi))
    return x

def _text(name, v, limit):
    s = (v or '').strip()
    if not s: raise FirefighterError('%s is required' % name)
    if len(s) > limit: raise FirefighterError('%s is at most %d characters' % (name, limit))
    return s

def consent_ts_of(date_text, now_ms):
    """The consent date as ms (00:00 UTC of YYYY-MM-DD), or now when none is given. A date later than tomorrow is refused."""
    if not date_text: return now_ms
    try: d = dt.datetime.strptime(date_text, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc)
    except ValueError: raise FirefighterError('the consent date must be YYYY-MM-DD') from None
    ts = int(d.timestamp() * 1000)
    if ts > now_ms + 86_400_000: raise FirefighterError('the consent date is in the future')
    return ts

def _audit(conn, now_ms, action, reason, node_id=None):
    conn.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id, reason) VALUES (NULL, 0, ?, NULL, ?, ?, ?)', (now_ms, action, node_id, reason))

def _txn(conn, fn):
    conn.execute('BEGIN IMMEDIATE')
    try: r = fn(); conn.execute('COMMIT'); return r
    except BaseException: conn.execute('ROLLBACK'); raise

def add_firefighter(conn, now_ms, *, full_name, age_years, height_cm, weight_kg, resting_hr, smoker, consent, consent_form_version, consent_witness, consent_date=None, sex=None, max_hr=None, years_service=None):
    """Returns (firefighter_id, alias). The alias is FFR-NN from the id. Refuses a profile without consent, with a value out of range or with max_hr not above resting_hr."""
    if consent is not True: raise FirefighterError('consent must be given and recorded before a profile is saved (--consent)')
    name = _text('name', full_name, 80); form = _text('consent form version', consent_form_version, 40); witness = _text('consent witness', consent_witness, 80)
    age = _num('age_years', age_years, True, True); h = _num('height_cm', height_cm, True, True); w = _num('weight_kg', weight_kg, True, False); rhr = _num('resting_hr', resting_hr, True, True)
    mhr = _num('max_hr', max_hr, False, True); ys = _num('years_service', years_service, False, False)
    if mhr is not None and mhr <= rhr: raise FirefighterError('max_hr must be above resting_hr')
    if sex is not None and sex not in SEX: raise FirefighterError('sex must be one of %s' % ', '.join(SEX))
    if smoker not in (0, 1, True, False): raise FirefighterError('smoker must be yes or no')
    cts = consent_ts_of(consent_date, now_ms)
    def write():
        fid = conn.execute('SELECT COALESCE(MAX(firefighter_id), 0) + 1 FROM firefighters').fetchone()[0]; alias = 'FFR-%02d' % fid
        conn.execute('INSERT INTO firefighters(firefighter_id, alias, full_name, sex, age_years, height_cm, weight_kg, resting_hr, max_hr, smoker, years_service, consent_ts, consent_form_version, consent_witness, active, created_ts)'
                     ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', (fid, alias, name, sex, age, h, w, rhr, mhr, int(bool(smoker)), ys, cts, form, witness, now_ms))
        _audit(conn, now_ms, 'FIREFIGHTER_ADDED', 'firefighter_id %d (%s)' % (fid, alias)); return fid, alias
    return _txn(conn, write)

def list_firefighters(conn, show_names=False):
    """Rows of dicts, oldest first: alias, the profile numbers, consent date and form, active, and the node now worn (None when not assigned). full_name only when show_names."""
    rows = conn.execute('SELECT f.firefighter_id, f.alias, f.full_name, f.sex, f.age_years, f.height_cm, f.weight_kg, f.resting_hr, f.max_hr, f.smoker, f.years_service, f.consent_ts, f.consent_form_version, f.active,'
                        ' (SELECT a.node_id FROM firefighter_assignments a WHERE a.firefighter_id = f.firefighter_id AND a.end_ts IS NULL) FROM firefighters f ORDER BY f.firefighter_id').fetchall()
    keys = ('firefighter_id', 'alias', 'full_name', 'sex', 'age_years', 'height_cm', 'weight_kg', 'resting_hr', 'max_hr', 'smoker', 'years_service', 'consent_ts', 'consent_form_version', 'active', 'node_id')
    out = []
    for r in rows:
        d = dict(zip(keys, r))
        if not show_names: del d['full_name']
        out.append(d)
    return out

def assign(conn, now_ms, node_id, firefighter_id=None):
    """Put a firefighter on a node, replacing whoever wore it; firefighter_id None ends the node's assignment. Returns 'assigned', 'ended' or 'unchanged'. A firefighter on another node,
    an inactive or unknown firefighter and a node outside the roster are refused."""
    if conn.execute('SELECT 1 FROM roster WHERE node_id = ?', (node_id,)).fetchone() is None: raise FirefighterError('node %d is not in the roster' % node_id)
    cur = conn.execute('SELECT assignment_id, firefighter_id FROM firefighter_assignments WHERE node_id = ? AND end_ts IS NULL', (node_id,)).fetchone()
    if firefighter_id is None:
        if cur is None: return 'unchanged'
    else:
        f = conn.execute('SELECT alias, active FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
        if f is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id)
        if not f[1]: raise FirefighterError('%s is inactive and cannot be assigned' % f[0])
        if cur is not None and cur[1] == firefighter_id: return 'unchanged'
        other = conn.execute('SELECT node_id FROM firefighter_assignments WHERE firefighter_id = ? AND end_ts IS NULL', (firefighter_id,)).fetchone()
        if other is not None: raise FirefighterError('%s is already assigned to node %d; end that assignment first' % (f[0], other[0]))
    def write():
        if cur is not None: conn.execute('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE assignment_id = ?', (now_ms, cur[0]))
        if firefighter_id is not None:
            conn.execute('INSERT INTO firefighter_assignments(node_id, firefighter_id, start_ts) VALUES (?, ?, ?)', (node_id, firefighter_id, now_ms))
            _audit(conn, now_ms, 'FIREFIGHTER_ASSIGNED', 'firefighter_id %d' % firefighter_id, node_id); return 'assigned'
        _audit(conn, now_ms, 'FIREFIGHTER_ASSIGNED', 'ended firefighter_id %d' % cur[1], node_id); return 'ended'
    return _txn(conn, write)

def set_roster_active(conn, now_ms, node_id, active):
    """Switch a roster node on or off (the host reads the roster at start-up, so it takes effect at the next start). The last active node cannot be switched off. Switching a node off ends its
    assignment. Returns 'changed' or 'unchanged'."""
    r = conn.execute('SELECT active FROM roster WHERE node_id = ?', (node_id,)).fetchone()
    if r is None: raise FirefighterError('node %d is not in the roster' % node_id)
    if active not in (0, 1): raise FirefighterError('active must be 0 or 1')
    if r[0] == active: return 'unchanged'
    if active == 0 and conn.execute('SELECT COUNT(*) FROM roster WHERE active = 1 AND node_id <> ?', (node_id,)).fetchone()[0] == 0:
        raise FirefighterError('node %d is the last active node; the roster would be empty' % node_id)
    def write():
        conn.execute('UPDATE roster SET active = ? WHERE node_id = ?', (active, node_id))
        if active == 0: conn.execute('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE node_id = ? AND end_ts IS NULL', (now_ms, node_id))
        _audit(conn, now_ms, 'ROSTER_ACTIVE_SET', 'active=%d' % active, node_id); return 'changed'
    return _txn(conn, write)
