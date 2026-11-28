"""S8-2 (ADR 0071): GET /api/firefighters, POST /api/firefighters and POST /api/firefighters/assign. The port here runs the real service plans (services/firefighters.py) on a real migrated database, the way
HostPort runs them through the writer; the routes, the models and the error mapping are the real ones. Requirements: REQ-API-002."""
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ppe_host import cli
from ppe_host.api import api_rest as R
from ppe_host.io.db_writer import connect_db
from ppe_host.services import firefighters as F

NOW = 1_800_000_000_000
GOOD = {'Authorization': 'Bearer good-token'}
BODY = dict(full_name='Sam Example', sex=None, age_years=34, height_cm=180, weight_kg=82.5, resting_hr=58, max_hr=None, smoker=False, years_service=None, consent=True,
            consent_form_version='v1', consent_witness='Witness One', consent_date=None)

class DbPort:
    def __init__(self, db): self.db, self.audits, self.recovering = db, [], None
    def authenticate(self, t): return R.Operator(1, 'Ana') if t == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append(dict(action=action, operator_id=operator_id, node_id=node_id, reason=reason))
    def recovering_retry_s(self): return self.recovering
    def _conn(self, ro=False): return connect_db(self.db, readonly=ro)
    def list_firefighters(self):
        c = self._conn(True)
        try: return F.list_firefighters(c, show_names=True)
        finally: c.close()
    def add_firefighter(self, profile):
        v = F.check_profile(now_ms=NOW, **profile); c = self._conn()
        try:
            def w():
                fid = c.execute('SELECT COALESCE(MAX(firefighter_id), 0) + 1 FROM firefighters').fetchone()[0]; c.execute(*F.insert_stmt(v, fid, NOW)); return fid, F.alias_of(fid)
            return F._txn(c, w)
        finally: c.close()
    def set_firefighter_active(self, firefighter_id, active):      # S8-3a
        c = self._conn()
        try:
            result, stmts, reason, alias = F.plan_set_active(c, firefighter_id, active, NOW)
            if stmts: F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
            return result, reason, alias
        finally: c.close()
    def edit_firefighter(self, firefighter_id, changes):      # S8-5
        c = self._conn()
        try:
            result, stmts, reason, alias, changed = F.plan_edit(c, firefighter_id, changes, NOW)
            if stmts: F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
            return result, reason, alias, changed
        finally: c.close()
    def withdraw_firefighter(self, firefighter_id):      # S8-5
        c = self._conn()
        try:
            result, stmts, reason, alias = F.plan_withdraw(c, firefighter_id, NOW)
            if stmts: F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
            return result, reason, alias
        finally: c.close()
    def assign_firefighter(self, node_id, firefighter_id):
        c = self._conn()
        try:
            result, stmts, reason, alias = F.plan_assign(c, node_id, firefighter_id, NOW)
            if stmts: F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
            return result, reason, alias
        finally: c.close()

@pytest.fixture
def rig(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; port = DbPort(p)
    return TestClient(R.create_app(port, p), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port

def add(client, **over): return client.post('/api/firefighters', json={**BODY, **over}, headers=GOOD)
def assign(client, node, ff): return client.post('/api/firefighters/assign', json={'node_id': node, 'firefighter_id': ff}, headers=GOOD)

def test_add_then_list_shows_the_alias_the_profile_and_no_node(rig):
    client, port = rig; r = add(client); assert r.status_code == 200 and r.json() == {'firefighter_id': 1, 'alias': 'FFR-01'}
    row = client.get('/api/firefighters', headers=GOOD).json()[0]
    assert row['alias'] == 'FFR-01' and row['full_name'] == 'Sam Example' and row['node_id'] is None and row['smoker'] is False and row['active'] is True and row['weight_kg'] == 82.5

def test_the_audit_row_of_an_add_names_the_alias_and_never_the_name(rig):
    client, port = rig; add(client)
    assert port.audits == [dict(action='FIREFIGHTER_ADDED', operator_id=1, node_id=None, reason='firefighter_id 1 (FFR-01)')] and 'Sam' not in str(port.audits)

def test_the_second_firefighter_gets_the_next_alias(rig):
    client, _ = rig; add(client); assert add(client, full_name='Pat Other').json()['alias'] == 'FFR-02'

@pytest.mark.parametrize('over,word', [(dict(consent=False), 'consent'), (dict(age_years=99), 'age_years'), (dict(weight_kg=10), 'weight_kg'), (dict(max_hr=50), 'max_hr'),
                                       (dict(consent_form_version=' '), 'consent form version'), (dict(consent_witness=''), 'consent_witness'), (dict(consent_date='2999-01-01'), 'future'),
                                       (dict(consent_date='28/11/2026'), 'YYYY-MM-DD'), (dict(sex='Q'), 'sex')])
def test_a_refused_profile_is_422_writes_nothing_and_never_echoes_the_name(rig, over, word):
    client, port = rig; r = add(client, **over); b = r.json()
    assert r.status_code == 422 and b['error_code'] == 'VALIDATION_ERROR' and word in b['detail'] and 'Sam' not in r.text
    assert client.get('/api/firefighters', headers=GOOD).json() == [] and port.audits == []

def test_a_body_with_a_missing_or_extra_key_is_422(rig):
    client, _ = rig; body = dict(BODY); del body['consent']
    assert client.post('/api/firefighters', json=body, headers=GOOD).status_code == 422
    assert add(client, nickname='x').status_code == 422

def test_assign_shows_on_the_list_and_a_repeat_changes_nothing(rig):
    client, port = rig; add(client); port.audits.clear()
    a = assign(client, 1, 1); assert a.status_code == 200 and a.json() == dict(node_id=1, firefighter_id=1, alias='FFR-01', result='assigned')
    b = assign(client, 1, 1); assert b.json()['result'] == 'unchanged' and b.json()['alias'] == 'FFR-01'
    assert client.get('/api/firefighters', headers=GOOD).json()[0]['node_id'] == 1
    assert port.audits == [dict(action='FIREFIGHTER_ASSIGNED', operator_id=1, node_id=1, reason='firefighter_id 1')]

def test_assigning_another_firefighter_replaces_the_first_and_none_ends_it(rig):
    client, port = rig; add(client); add(client, full_name='Pat Other'); assign(client, 1, 1)
    assert assign(client, 1, 2).json()['alias'] == 'FFR-02'
    nodes = {r['alias']: r['node_id'] for r in client.get('/api/firefighters', headers=GOOD).json()}; assert nodes == {'FFR-01': None, 'FFR-02': 1}
    e = assign(client, 1, None); assert e.status_code == 200 and e.json() == dict(node_id=1, firefighter_id=None, alias=None, result='ended')
    assert assign(client, 1, None).json()['result'] == 'unchanged'
    c = connect_db(port.db, readonly=True); assert c.execute('SELECT COUNT(*) FROM firefighter_assignments').fetchone()[0] == 2; c.close()      # the history stays

def test_assign_refusals_are_404_for_unknown_ids_and_409_for_state(rig):
    client, port = rig; add(client); add(client, full_name='Pat Other')
    assert assign(client, 7, 1).status_code == 404 and assign(client, 1, 99).status_code == 404      # node 7 fits the model but is not in the roster
    assert assign(client, 0, 1).status_code == 422 and client.post('/api/firefighters/assign', json={'node_id': 'x', 'firefighter_id': 1}, headers=GOOD).status_code == 422
    assign(client, 1, 1); r = assign(client, 2, 1); assert r.status_code == 409 and r.json()['error_code'] == 'STATE_CONFLICT' and r.json()['retry_after_s'] is None
    c = connect_db(port.db); c.execute('UPDATE firefighters SET active = 0 WHERE firefighter_id = 2'); c.close()
    r = assign(client, 3, 2); assert r.status_code == 409 and 'inactive' in r.json()['detail']

def test_both_writes_are_409_recovering_while_the_host_recovers(rig):
    client, port = rig; port.recovering = 3.0
    for r in (add(client), assign(client, 1, 1)): assert r.status_code == 409 and r.json()['error_code'] == 'RECOVERING' and r.json()['retry_after_s'] == 3.0
    assert client.get('/api/firefighters', headers=GOOD).status_code == 200      # a read is allowed

def test_no_token_is_401_and_nothing_is_written(rig):
    client, port = rig
    assert client.get('/api/firefighters').status_code == 401 and client.post('/api/firefighters', json=BODY).status_code == 401 and client.post('/api/firefighters/assign', json={'node_id': 1, 'firefighter_id': 1}).status_code == 401
    c = connect_db(port.db, readonly=True); assert c.execute('SELECT COUNT(*) FROM firefighters').fetchone()[0] == 0; c.close()

def test_plan_assign_changes_nothing_by_itself(rig):
    _, port = rig; c = connect_db(port.db); F.add_firefighter(c, NOW, **{k: v for k, v in BODY.items() if k not in ('sex', 'max_hr', 'years_service', 'consent_date')})
    out, stmts, reason, alias = F.plan_assign(c, 1, 1, NOW); assert (out, alias, reason) == ('assigned', 'FFR-01', 'firefighter_id 1') and len(stmts) == 1
    assert c.execute('SELECT COUNT(*) FROM firefighter_assignments').fetchone()[0] == 0; c.close()

def test_the_error_kinds_of_the_service():
    assert F.FirefighterError('x').kind == 'invalid' and F.FirefighterError('x', 'missing').kind == 'missing'

# ---- S8-3a (ADR 0072): POST /api/firefighters/active ----
def active(client, ff, on): return client.post('/api/firefighters/active', json={'firefighter_id': ff, 'active': on}, headers=GOOD)

def test_inactive_ends_the_jacket_keeps_the_history_and_writes_one_audit_row_without_a_name(rig):
    client, port = rig; add(client); assign(client, 1, 1); port.audits.clear()
    r = active(client, 1, False); assert r.status_code == 200 and r.json() == dict(firefighter_id=1, alias='FFR-01', active=False, result='changed')
    row = client.get('/api/firefighters', headers=GOOD).json()[0]; assert row['active'] is False and row['node_id'] is None
    assert port.audits == [dict(action='FIREFIGHTER_ACTIVE_SET', operator_id=1, node_id=None, reason='firefighter_id 1 (FFR-01) inactive')] and 'Sam' not in str(port.audits)
    c = connect_db(port.db, readonly=True); rows = c.execute('SELECT end_ts FROM firefighter_assignments').fetchall(); c.close(); assert len(rows) == 1 and rows[0][0] is not None      # the history stays, closed

def test_an_inactive_firefighter_cannot_be_assigned_until_active_again(rig):
    client, _ = rig; add(client); active(client, 1, False)
    assert assign(client, 1, 1).status_code == 409
    assert active(client, 1, True).json()['result'] == 'changed' and assign(client, 1, 1).json()['result'] == 'assigned'

def test_a_repeat_changes_nothing_and_writes_no_row(rig):
    client, port = rig; add(client); port.audits.clear()
    r = active(client, 1, True); assert r.status_code == 200 and r.json()['result'] == 'unchanged' and port.audits == []

def test_active_refusals_and_recovering_and_no_token(rig):
    client, port = rig; add(client)
    assert active(client, 99, False).status_code == 404 and client.post('/api/firefighters/active', json={'firefighter_id': 1, 'active': 'maybe'}, headers=GOOD).status_code == 422
    assert client.post('/api/firefighters/active', json={'firefighter_id': 0, 'active': False}, headers=GOOD).status_code == 422 and client.post('/api/firefighters/active', json={'firefighter_id': 1}, headers=GOOD).status_code == 422
    assert client.post('/api/firefighters/active', json={'firefighter_id': 1, 'active': False}).status_code == 401
    port.recovering = 3.0; r = active(client, 1, False); assert r.status_code == 409 and r.json()['error_code'] == 'RECOVERING'
    port.recovering = None; assert client.get('/api/firefighters', headers=GOOD).json()[0]['active'] is True      # nothing changed
