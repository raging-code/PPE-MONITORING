"""S8-5 (ADR 0074): editing a profile (POST /api/firefighters/edit) and withdrawing consent (POST /api/firefighters/withdraw). The routes run on a real migrated database through the real service plans.
Covered: only the fields sent change, a field sent as null is cleared where the profile allows it, the ranges of a new profile, no value and no name in the audit row, a repeat writes no row, a withdrawal sets the person inactive,
ends the jacket and keeps the record, nobody can edit, activate or assign a person who withdrew, and the per-firefighter export leaves out every reading of such a person (before and after the withdrawal) and keeps the rest.
Requirements: REQ-API-002."""
import pytest
from fastapi.testclient import TestClient
from ppe_host import cli
from ppe_host.api import api_rest as R
from ppe_host.io.db_writer import connect_db
from ppe_host.services import firefighters as F, firefighter_export as FX
from test_firefighters_rest import DbPort, add, assign, active, GOOD, NOW
from test_firefighter_export import db_with_people, parse, who
from test_db_schema import frame

@pytest.fixture
def rig(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; port = DbPort(p)
    return TestClient(R.create_app(port, p), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port

def edit(client, ff, **fields): return client.post('/api/firefighters/edit', json={'firefighter_id': ff, **fields}, headers=GOOD)
def withdraw(client, ff): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two'}, headers=GOOD)      # S8-8: the proof is required
def row(client, n=0): return client.get('/api/firefighters', headers=GOOD).json()[n]

# ---- edit ----
def test_an_edit_changes_only_the_fields_sent_and_the_audit_row_names_fields_never_values_or_the_name(rig):
    client, port = rig; add(client); port.audits.clear()
    r = edit(client, 1, weight_kg=90.5, age_years=35); assert r.status_code == 200 and r.json() == dict(firefighter_id=1, alias='FFR-01', result='changed', changed=['age_years', 'weight_kg'])
    x = row(client); assert x['weight_kg'] == 90.5 and x['age_years'] == 35 and x['height_cm'] == 180 and x['full_name'] == 'Sam Example' and x['resting_hr'] == 58
    assert port.audits == [dict(action='FIREFIGHTER_EDITED', operator_id=1, node_id=None, reason='firefighter_id 1 (FFR-01) changed: age_years, weight_kg')]
    assert '90.5' not in str(port.audits) and 'Sam' not in str(port.audits) and '35' not in port.audits[0]['reason']

def test_an_edit_that_changes_nothing_writes_no_row(rig):
    client, port = rig; add(client); port.audits.clear()
    r = edit(client, 1, weight_kg=82.5, smoker=False, sex=None); assert r.status_code == 200 and r.json()['result'] == 'unchanged' and r.json()['changed'] == [] and port.audits == []

def test_a_name_can_be_corrected_and_the_consent_record_cannot_be_edited(rig):
    client, _ = rig; add(client)
    assert edit(client, 1, full_name='Samuel Example').status_code == 200 and row(client)['full_name'] == 'Samuel Example'
    for f in ('consent_ts', 'consent_form_version', 'consent_witness', 'alias', 'active'):
        assert edit(client, 1, **{f: 'x'}).status_code == 422, f      # not a field of the edit request

def test_an_optional_field_sent_as_null_is_cleared_and_a_required_one_is_refused(rig):
    client, _ = rig; add(client, max_hr=190, sex='F', years_service=4.5)
    assert edit(client, 1, max_hr=None, sex=None, years_service=None).json()['changed'] == ['sex', 'max_hr', 'years_service']
    x = row(client); assert (x['max_hr'], x['sex'], x['years_service']) == (None, None, None)
    r = edit(client, 1, age_years=None); assert r.status_code == 422 and 'required' in r.json()['detail'] and row(client)['age_years'] == 34

@pytest.mark.parametrize('fields,word', [(dict(age_years=99), 'age_years'), (dict(weight_kg=10), 'weight_kg'), (dict(resting_hr=10), 'resting_hr'), (dict(sex='Q'), 'sex'), (dict(full_name=' '), 'name'), (dict(), 'nothing')])
def test_an_edit_is_refused_with_its_sentence_and_changes_nothing(rig, fields, word):
    client, port = rig; add(client); port.audits.clear(); r = edit(client, 1, **fields)
    assert r.status_code == 422 and word in r.json()['detail'] and port.audits == [] and row(client)['age_years'] == 34 and row(client)['weight_kg'] == 82.5

def test_max_hr_must_stay_above_resting_hr_after_the_edit_whichever_field_moves(rig):
    client, _ = rig; add(client, max_hr=100)
    assert edit(client, 1, resting_hr=100).status_code == 422 and edit(client, 1, max_hr=58).status_code == 422
    assert edit(client, 1, resting_hr=70, max_hr=190).status_code == 200 and (row(client)['resting_hr'], row(client)['max_hr']) == (70, 190)

def test_an_edit_of_an_unknown_firefighter_is_404_and_of_zero_is_422_and_recovering_and_no_token(rig):
    client, port = rig; add(client)
    assert edit(client, 99, weight_kg=80).status_code == 404 and edit(client, 0, weight_kg=80).status_code == 422
    assert client.post('/api/firefighters/edit', json={'firefighter_id': 1, 'weight_kg': 80}).status_code == 401
    port.recovering = 3.0; r = edit(client, 1, weight_kg=80); assert r.status_code == 409 and r.json()['error_code'] == 'RECOVERING'
    port.recovering = None; assert row(client)['weight_kg'] == 82.5

# ---- withdraw ----
def test_a_withdrawal_sets_inactive_ends_the_jacket_keeps_the_record_and_writes_one_audit_row_without_a_name(rig):
    client, port = rig; add(client); assign(client, 1, 1); port.audits.clear()
    r = withdraw(client, 1); assert r.status_code == 200 and r.json() == dict(firefighter_id=1, alias='FFR-01', result='withdrawn')
    x = row(client); assert x['active'] is False and x['node_id'] is None and x['consent_withdrawn_ts'] == NOW and x['consent_form_version'] == 'v1' and x['full_name'] == 'Sam Example'      # nothing deleted
    assert port.audits == [dict(action='CONSENT_WITHDRAWN', operator_id=1, node_id=None, reason='firefighter_id 1 (FFR-01) consent withdrawn')] and 'Sam' not in str(port.audits)
    c = connect_db(port.db, readonly=True); rows = c.execute('SELECT end_ts FROM firefighter_assignments').fetchall(); c.close(); assert len(rows) == 1 and rows[0][0] is not None

def test_a_repeat_withdrawal_changes_nothing_and_writes_no_row(rig):
    client, port = rig; add(client); withdraw(client, 1); port.audits.clear()
    r = withdraw(client, 1); assert r.status_code == 200 and r.json()['result'] == 'unchanged' and port.audits == [] and row(client)['consent_withdrawn_ts'] == NOW

def test_a_person_who_withdrew_cannot_be_set_active_assigned_or_edited_and_set_inactive_stays_a_repeat(rig):
    client, port = rig; add(client); withdraw(client, 1); port.audits.clear()
    r = active(client, 1, True); assert r.status_code == 409 and 'withdrew consent' in r.json()['detail']
    assert assign(client, 1, 1).status_code == 409 and edit(client, 1, weight_kg=80).status_code == 409
    assert active(client, 1, False).json()['result'] == 'unchanged' and port.audits == [] and row(client)['active'] is False

def test_a_withdrawal_leaves_the_other_firefighters_alone_and_a_new_profile_gets_a_new_alias(rig):
    client, _ = rig; add(client); add(client, full_name='Pat Other'); assign(client, 1, 1); assign(client, 2, 2); withdraw(client, 1)
    a, b = row(client, 0), row(client, 1); assert (b['active'], b['node_id'], b['consent_withdrawn_ts']) == (True, 2, None) and a['node_id'] is None
    assert add(client).json()['alias'] == 'FFR-03'

def test_withdraw_refusals_and_recovering_and_no_token(rig):
    client, port = rig; add(client)
    assert withdraw(client, 99).status_code == 404 and withdraw(client, 0).status_code == 422 and client.post('/api/firefighters/withdraw', json={'firefighter_id': 1}).status_code == 401
    port.recovering = 3.0; r = withdraw(client, 1); assert r.status_code == 409 and r.json()['error_code'] == 'RECOVERING'
    port.recovering = None; assert row(client)['consent_withdrawn_ts'] is None and row(client)['active'] is True

# ---- the export ----
def test_the_export_leaves_out_every_reading_of_a_person_who_withdrew_before_and_after_and_keeps_the_rest(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1); F.assign(c, 1000, 2, 2)
    frame(c, 1, 1, rx_ts=1500); frame(c, 2, 2, rx_ts=1500); frame(c, 3, 3, rx_ts=1500)      # Sam, Pat, a node nobody wears
    outcome, stmts, _, _ = F.plan_withdraw(c, 1, 2000, form_ref='WF-1', witness='W'); assert outcome == 'withdrawn'; F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
    frame(c, 4, 1, rx_ts=2500); frame(c, 5, 2, rx_ts=2500)      # after: node 1 is unassigned now, node 2 is still Pat
    _, rows = parse(FX.iter_csv(db)); assert who(rows) == [(2, 'FFR-02'), (3, ''), (4, ''), (5, 'FFR-02')]      # Sam's reading 1 is gone, the unassigned stretch after it stays
    assert c.execute('SELECT full_name, consent_ts, consent_withdrawn_ts FROM firefighters WHERE firefighter_id = 1').fetchone()[2] == 2000      # the record stays in the database

def test_the_export_of_one_session_leaves_the_withdrawn_person_out_too_and_the_columns_are_the_same(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1)
    frame(c, 1, 1, rx_ts=1500, session_id=2)
    _, stmts, _, _ = F.plan_withdraw(c, 1, 2000, form_ref='WF-1', witness='W'); F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
    head, rows = parse(FX.iter_csv(db, 2)); assert rows == [] and head == list(FX.COLUMNS)

def test_the_row_keeps_its_place_when_nobody_withdrew_and_an_edit_does_not_change_the_export(tmp_path):
    c, db = db_with_people(tmp_path); F.assign(c, 1000, 1, 1); frame(c, 1, 1, rx_ts=1500)
    _, stmts, _, _, _ = F.plan_edit(c, 1, {'weight_kg': 99}, 2000); F._txn(c, lambda: [c.execute(s, p) for s, p in stmts])
    _, rows = parse(FX.iter_csv(db)); assert who(rows) == [(1, 'FFR-01')]
