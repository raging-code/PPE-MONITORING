"""services/firefighters.py (S8-1, ADR 0070): who is wearing the PPE. Offline helpers for the CLI (and later the Settings screen): add a firefighter profile with its consent record,
assign a firefighter to a node (the jacket), and switch roster nodes on or off. No wire, no REST and no engine input: nothing here changes an alert or a threshold.

The dashboard and the audit log show only the alias (FFR-01). The real name lives in firefighters.full_name and is shown only by `cli list-firefighters --show-names` (and later the Settings
screen); it is never written to an audit row, a log line or an export. A profile cannot be saved without the consent record (the tick, the date, the form version and the witness).
Rows are never deleted by software: a person who leaves is set inactive and the assignment history stays, because the readings of their shifts are linked to them through it."""
import datetime as dt

class FirefighterError(ValueError):
    """A refused request; the message is shown to the person and nothing was written. kind is 'invalid' (a value the person must fix), 'missing' (an unknown node or firefighter) or
    'conflict' (the request is fine but the state refuses it); the REST routes (S8-2) map them to 422, 404 and 409. No message ever holds a name."""
    def __init__(self, msg, kind='invalid'): super().__init__(msg); self.kind = kind

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

def check_withdrawal_proof(form_ref, witness):
    """S8-8 (ADR 0077): the reference of the paper withdrawal form and the witness, both required like the form version and the witness of the consent. Returns (form_ref, witness) trimmed.
    No message holds either value."""
    return _text('withdrawal form reference', form_ref, 40), _text('withdrawal witness', witness, 80)

def withdrawal_ts_of(date_text, now_ms, consent_ts):
    """S8-7 (ADR 0076): the withdrawal date as (ms, YYYY-MM-DD), or (now, None) when none is given. The checks are those of the consent date: YYYY-MM-DD, not later than tomorrow (time zones),
    and a withdrawal cannot come before the day of the consent it withdraws."""
    if not date_text: return now_ms, None
    try: d = dt.datetime.strptime(date_text, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc)
    except ValueError: raise FirefighterError('the withdrawal date must be YYYY-MM-DD') from None
    ts = int(d.timestamp() * 1000)
    if ts > now_ms + 86_400_000: raise FirefighterError('the withdrawal date is in the future')
    if ts < consent_ts - consent_ts % 86_400_000: raise FirefighterError('the withdrawal date is before the consent date')
    return ts, d.strftime('%Y-%m-%d')

def _audit(conn, now_ms, action, reason, node_id=None):
    conn.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id, reason) VALUES (NULL, 0, ?, NULL, ?, ?, ?)', (now_ms, action, node_id, reason))

def _txn(conn, fn):
    conn.execute('BEGIN IMMEDIATE')
    try: r = fn(); conn.execute('COMMIT'); return r
    except BaseException: conn.execute('ROLLBACK'); raise

def alias_of(firefighter_id): return 'FFR-%02d' % firefighter_id

def check_profile(*, full_name, age_years, height_cm, weight_kg, resting_hr, smoker, consent, consent_form_version, consent_witness, consent_date=None, sex=None, max_hr=None, years_service=None, now_ms):
    """S8-2: the checks of a new profile, shared by the CLI and the REST route. Returns the row values without the id: (name, sex, age, height, weight, resting_hr, max_hr, smoker 0/1, years_service, consent_ts,
    form version, witness). Refuses a profile without consent, with a value out of range or with max_hr not above resting_hr. No message holds the name."""
    if consent is not True: raise FirefighterError('consent must be given and recorded before a profile is saved')
    name = _text('name', full_name, 80); form = _text('consent form version', consent_form_version, 40); witness = _text('consent witness', consent_witness, 80)
    age = _num('age_years', age_years, True, True); h = _num('height_cm', height_cm, True, True); w = _num('weight_kg', weight_kg, True, False); rhr = _num('resting_hr', resting_hr, True, True)
    mhr = _num('max_hr', max_hr, False, True); ys = _num('years_service', years_service, False, False)
    if mhr is not None and mhr <= rhr: raise FirefighterError('max_hr must be above resting_hr')
    if sex is not None and sex not in SEX: raise FirefighterError('sex must be one of %s' % ', '.join(SEX))
    if smoker not in (0, 1, True, False): raise FirefighterError('smoker must be yes or no')
    return (name, sex, age, h, w, rhr, mhr, int(bool(smoker)), ys, consent_ts_of(consent_date, now_ms), form, witness)

def insert_stmt(values, firefighter_id, now_ms):
    """(sql, params) of the INSERT for check_profile's values; the alias is FFR-NN from the id."""
    name, sex, age, h, w, rhr, mhr, smoker, ys, cts, form, witness = values
    return ('INSERT INTO firefighters(firefighter_id, alias, full_name, sex, age_years, height_cm, weight_kg, resting_hr, max_hr, smoker, years_service, consent_ts, consent_form_version, consent_witness, active, created_ts)'
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', (firefighter_id, alias_of(firefighter_id), name, sex, age, h, w, rhr, mhr, smoker, ys, cts, form, witness, now_ms))

def add_firefighter(conn, now_ms, *, full_name, age_years, height_cm, weight_kg, resting_hr, smoker, consent, consent_form_version, consent_witness, consent_date=None, sex=None, max_hr=None, years_service=None):
    """Returns (firefighter_id, alias). The alias is FFR-NN from the id. Refuses what check_profile refuses."""
    if consent is not True: raise FirefighterError('consent must be given and recorded before a profile is saved (--consent)')
    v = check_profile(full_name=full_name, age_years=age_years, height_cm=height_cm, weight_kg=weight_kg, resting_hr=resting_hr, smoker=smoker, consent=consent, consent_form_version=consent_form_version,
                      consent_witness=consent_witness, consent_date=consent_date, sex=sex, max_hr=max_hr, years_service=years_service, now_ms=now_ms)
    def write():
        fid = conn.execute('SELECT COALESCE(MAX(firefighter_id), 0) + 1 FROM firefighters').fetchone()[0]
        conn.execute(*insert_stmt(v, fid, now_ms)); _audit(conn, now_ms, 'FIREFIGHTER_ADDED', 'firefighter_id %d (%s)' % (fid, alias_of(fid))); return fid, alias_of(fid)
    return _txn(conn, write)

def list_firefighters(conn, show_names=False):
    """Rows of dicts, oldest first: alias, the profile numbers, consent date and form, active, and the node now worn (None when not assigned). full_name only when show_names."""
    rows = conn.execute('SELECT f.firefighter_id, f.alias, f.full_name, f.sex, f.age_years, f.height_cm, f.weight_kg, f.resting_hr, f.max_hr, f.smoker, f.years_service, f.consent_ts, f.consent_form_version, f.active, f.consent_withdrawn_ts,'
                        ' (SELECT a.node_id FROM firefighter_assignments a WHERE a.firefighter_id = f.firefighter_id AND a.end_ts IS NULL) FROM firefighters f ORDER BY f.firefighter_id').fetchall()
    keys = ('firefighter_id', 'alias', 'full_name', 'sex', 'age_years', 'height_cm', 'weight_kg', 'resting_hr', 'max_hr', 'smoker', 'years_service', 'consent_ts', 'consent_form_version', 'active', 'consent_withdrawn_ts', 'node_id')
    out = []
    for r in rows:
        d = dict(zip(keys, r))
        if not show_names: del d['full_name']
        out.append(d)
    return out

def plan_assign(conn, node_id, firefighter_id, now_ms):
    """S8-2: what assign() would do, without doing it. Returns (outcome, stmts, reason, alias): outcome 'assigned', 'ended' or 'unchanged'; stmts a list of (sql, params) to run in one transaction (empty when unchanged);
    reason the audit text (the id only, never a name); alias of the firefighter now on the node (None when the assignment ended or there was none). Refusals: a node outside the roster and an unknown firefighter
    are kind 'missing'; an inactive firefighter and one already on another node are kind 'conflict'."""
    if conn.execute('SELECT 1 FROM roster WHERE node_id = ?', (node_id,)).fetchone() is None: raise FirefighterError('node %d is not in the roster' % node_id, 'missing')
    cur = conn.execute('SELECT assignment_id, firefighter_id FROM firefighter_assignments WHERE node_id = ? AND end_ts IS NULL', (node_id,)).fetchone()
    close = ('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE assignment_id = ?', (now_ms, cur[0])) if cur is not None else None
    if firefighter_id is None:
        if cur is None: return 'unchanged', [], None, None
        return 'ended', [close], 'ended firefighter_id %d' % cur[1], None
    f = conn.execute('SELECT alias, active FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
    if f is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id, 'missing')
    if not f[1]: raise FirefighterError('%s is inactive and cannot be assigned' % f[0], 'conflict')
    if cur is not None and cur[1] == firefighter_id: return 'unchanged', [], None, f[0]
    other = conn.execute('SELECT node_id FROM firefighter_assignments WHERE firefighter_id = ? AND end_ts IS NULL', (firefighter_id,)).fetchone()
    if other is not None: raise FirefighterError('%s is already assigned to node %d; end that assignment first' % (f[0], other[0]), 'conflict')
    stmts = ([close] if close else []) + [('INSERT INTO firefighter_assignments(node_id, firefighter_id, start_ts) VALUES (?, ?, ?)', (node_id, firefighter_id, now_ms))]
    return 'assigned', stmts, 'firefighter_id %d' % firefighter_id, f[0]

def plan_set_active(conn, firefighter_id, active, now_ms):
    """S8-3a (ADR 0072): what set_active would do, without doing it. Returns (outcome, stmts, reason, alias): outcome 'changed' or 'unchanged'; stmts the statements for one transaction (empty when unchanged);
    reason the audit text (the id and the alias, never a name). Setting a firefighter inactive also ends the jacket they wear, so nobody who left stays on a node. An unknown firefighter is kind 'missing'.
    Nothing is deleted: the profile, the consent record and the assignment history stay."""
    if active not in (0, 1, True, False): raise FirefighterError('active must be true or false')
    active = int(bool(active))
    f = conn.execute('SELECT alias, active, consent_withdrawn_ts FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
    if f is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id, 'missing')
    if f[1] == active: return 'unchanged', [], None, f[0]
    if f[2] is not None: raise FirefighterError('%s withdrew consent and cannot be set active again; a new profile needs a new consent' % f[0], 'conflict')      # S8-5 (ADR 0074)
    stmts = [('UPDATE firefighters SET active = ? WHERE firefighter_id = ?', (active, firefighter_id))]
    if not active: stmts.append(('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE firefighter_id = ? AND end_ts IS NULL', (now_ms, firefighter_id)))
    return 'changed', stmts, 'firefighter_id %d (%s) %s' % (firefighter_id, f[0], 'active' if active else 'inactive'), f[0]

EDIT_FIELDS = ('full_name', 'sex', 'age_years', 'height_cm', 'weight_kg', 'resting_hr', 'max_hr', 'smoker', 'years_service')

def plan_edit(conn, firefighter_id, changes, now_ms):
    """S8-5 (ADR 0074): what an edit of a profile would do, without doing it. `changes` holds only the fields to change (EDIT_FIELDS); a field that is not in it stays. The same ranges as a new profile; max_hr must stay above
    resting_hr after the change. Returns (outcome, stmts, reason, alias, changed): outcome 'changed' or 'unchanged' (every value was already what it is, nothing to write); changed the names of the fields whose value differs.
    The audit reason holds the id, the alias and the field NAMES, never a value and never the name. The consent record is not editable. A person who withdrew consent cannot be edited (kind 'conflict'); an unknown
    firefighter is kind 'missing'; an empty change, an unknown field or a value out of range is kind 'invalid'."""
    bad = sorted(set(changes) - set(EDIT_FIELDS))
    if bad: raise FirefighterError('%s cannot be changed' % ', '.join(bad))
    if not changes: raise FirefighterError('nothing to change')
    row = conn.execute('SELECT alias, ' + ', '.join(EDIT_FIELDS) + ', consent_withdrawn_ts FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
    if row is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id, 'missing')
    if row[-1] is not None: raise FirefighterError('%s withdrew consent and the profile cannot be edited' % row[0], 'conflict')
    cur = dict(zip(EDIT_FIELDS, row[1:-1])); new = dict(cur)
    for k, v in changes.items():
        if k == 'full_name': new[k] = _text('name', v, 80)
        elif k == 'sex':
            if v is not None and v not in SEX: raise FirefighterError('sex must be one of %s' % ', '.join(SEX))
            new[k] = v
        elif k == 'smoker':
            if v not in (0, 1, True, False): raise FirefighterError('smoker must be yes or no')
            new[k] = int(bool(v))
        elif k in ('age_years', 'height_cm', 'resting_hr'): new[k] = _num(k, v, True, True)
        elif k == 'weight_kg': new[k] = _num(k, v, True, False)
        elif k == 'max_hr': new[k] = _num(k, v, False, True)
        else: new[k] = _num(k, v, False, False)      # years_service
    if new['max_hr'] is not None and new['max_hr'] <= new['resting_hr']: raise FirefighterError('max_hr must be above resting_hr')
    changed = [k for k in EDIT_FIELDS if k in changes and new[k] != cur[k]]
    if not changed: return 'unchanged', [], None, row[0], []
    stmts = [('UPDATE firefighters SET ' + ', '.join('%s = ?' % k for k in changed) + ' WHERE firefighter_id = ?', tuple(new[k] for k in changed) + (firefighter_id,))]
    return 'changed', stmts, 'firefighter_id %d (%s) changed: %s' % (firefighter_id, row[0], ', '.join(changed)), row[0], changed

def plan_withdraw(conn, firefighter_id, now_ms, withdrawal_date=None, *, form_ref=None, witness=None):
    """S8-5 (ADR 0074): what withdrawing a person's consent would do, without doing it. Returns (outcome, stmts, reason, alias): outcome 'withdrawn' or 'unchanged' (already withdrawn, nothing to write).
    The date of the withdrawal is stored (consent_withdrawn_ts), the person is set inactive and the jacket they wear is ended. Nothing is deleted: the profile and the consent record stay as the record of what was agreed
    and when it was withdrawn. Their readings are left out of the per-firefighter export (services/firefighter_export.py). It cannot be undone through the software: a person who agrees again gets a new profile
    with a new consent. An unknown firefighter is kind 'missing'.
    S8-7 (ADR 0076): withdrawal_date (YYYY-MM-DD, optional) is the day the person withdrew, for a paper withdrawal from an earlier day; it is stored in consent_withdrawn_ts (00:00 UTC of that day)
    and checked like the consent date (not in the future, not before the consent day). Without it the stored time is now. The jacket is still ended now, because the person wore it until the operator
    recorded the withdrawal; only the legal date moves. A repeat of an already withdrawn person writes nothing and its date is not looked at. A refused date is kind 'invalid' and writes nothing.
    S8-8 (ADR 0077): form_ref and witness are required to withdraw (a person already withdrawn is 'unchanged' without them). They are stored in consent_withdrawal_form and consent_withdrawal_witness and
    are in no audit row, response, log or export."""
    f = conn.execute('SELECT alias, consent_withdrawn_ts, consent_ts FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
    if f is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id, 'missing')
    if f[1] is not None: return 'unchanged', [], None, f[0]
    form, wit = check_withdrawal_proof(form_ref, witness)
    ts, label = withdrawal_ts_of(withdrawal_date, now_ms, f[2])
    stmts = [('UPDATE firefighters SET consent_withdrawn_ts = ?, consent_withdrawal_form = ?, consent_withdrawal_witness = ?, active = 0 WHERE firefighter_id = ?', (ts, form, wit, firefighter_id)),
             ('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE firefighter_id = ? AND end_ts IS NULL', (now_ms, firefighter_id))]
    return 'withdrawn', stmts, 'firefighter_id %d (%s) consent withdrawn%s' % (firefighter_id, f[0], '' if label is None else ' (withdrawal dated %s)' % label), f[0]

def assign(conn, now_ms, node_id, firefighter_id=None):
    """Put a firefighter on a node, replacing whoever wore it; firefighter_id None ends the node's assignment. Returns 'assigned', 'ended' or 'unchanged'. A firefighter on another node,
    an inactive or unknown firefighter and a node outside the roster are refused."""
    outcome, stmts, reason, _ = plan_assign(conn, node_id, firefighter_id, now_ms)
    if outcome == 'unchanged': return outcome
    def write():
        for sql, params in stmts: conn.execute(sql, params)
        _audit(conn, now_ms, 'FIREFIGHTER_ASSIGNED', reason, node_id); return outcome
    return _txn(conn, write)

def set_roster_active(conn, now_ms, node_id, active):
    """Switch a roster node on or off (the host reads the roster at start-up, so it takes effect at the next start). The last active node cannot be switched off. Switching a node off ends its
    assignment. Returns 'changed' or 'unchanged'."""
    r = conn.execute('SELECT active FROM roster WHERE node_id = ?', (node_id,)).fetchone()
    if r is None: raise FirefighterError('node %d is not in the roster' % node_id, 'missing')
    if active not in (0, 1): raise FirefighterError('active must be 0 or 1')
    if r[0] == active: return 'unchanged'
    if active == 0 and conn.execute('SELECT COUNT(*) FROM roster WHERE active = 1 AND node_id <> ?', (node_id,)).fetchone()[0] == 0:
        raise FirefighterError('node %d is the last active node; the roster would be empty' % node_id)
    def write():
        conn.execute('UPDATE roster SET active = ? WHERE node_id = ?', (active, node_id))
        if active == 0: conn.execute('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE node_id = ? AND end_ts IS NULL', (now_ms, node_id))
        _audit(conn, now_ms, 'ROSTER_ACTIVE_SET', 'active=%d' % active, node_id); return 'changed'
    return _txn(conn, write)
