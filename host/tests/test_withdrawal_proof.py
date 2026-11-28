"""S8-8 (ADR 0077): withdrawing consent needs the reference of the paper withdrawal form and a witness. Covered: both are stored (trimmed) in migration 0009's columns, a missing, empty, blank or too long
value is 422 and writes nothing, neither value is in the audit row or in any response, a repeat needs no new proof and keeps the first, and the service refuses without them.
Requirements: REQ-API-002."""
import pytest
from fastapi.testclient import TestClient
from ppe_host import cli
from ppe_host.api import api_rest as R
from ppe_host.io.db_writer import connect_db, applied_versions
from ppe_host.services import firefighters as F
from test_firefighters_rest import DbPort, add, GOOD, NOW

@pytest.fixture
def rig(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; port = DbPort(p)
    return TestClient(R.create_app(port, p), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port, p

def post(client, **body): return client.post('/api/firefighters/withdraw', json={'firefighter_id': 1, **body}, headers=GOOD)
def proof_of(db):
    c = connect_db(db, readonly=True)
    try: return c.execute('SELECT consent_withdrawal_form, consent_withdrawal_witness FROM firefighters WHERE firefighter_id = 1').fetchone()
    finally: c.close()

def test_the_form_reference_and_the_witness_are_stored_trimmed_and_the_response_is_unchanged(rig):
    client, _, db = rig; add(client); assert proof_of(db) == (None, None)
    r = post(client, withdrawal_form_ref='  WF-2026-014 ', withdrawal_witness=' Witness Two  '); assert r.status_code == 200 and r.json() == dict(firefighter_id=1, alias='FFR-01', result='withdrawn')
    assert proof_of(db) == ('WF-2026-014', 'Witness Two')

def test_neither_value_is_in_the_audit_row_the_response_or_the_firefighter_list(rig):
    client, port, _ = rig; add(client); port.audits.clear()
    r = post(client, withdrawal_form_ref='WF-2026-014', withdrawal_witness='Witness Two')
    assert port.audits == [dict(action='CONSENT_WITHDRAWN', operator_id=1, node_id=None, reason='firefighter_id 1 (FFR-01) consent withdrawn')]
    listing = client.get('/api/firefighters', headers=GOOD); text = r.text + listing.text
    assert 'WF-2026-014' not in text and 'Witness Two' not in text and 'consent_withdrawal_form' not in text and 'consent_withdrawal_witness' not in text

@pytest.mark.parametrize('body', [{}, {'withdrawal_form_ref': 'WF-1'}, {'withdrawal_witness': 'Witness Two'}, {'withdrawal_form_ref': '', 'withdrawal_witness': 'Witness Two'}, {'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': ''},
                                  {'withdrawal_form_ref': '   ', 'withdrawal_witness': 'Witness Two'}, {'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': '   '},
                                  {'withdrawal_form_ref': 'x' * 41, 'withdrawal_witness': 'Witness Two'}, {'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'x' * 81},
                                  {'withdrawal_form_ref': None, 'withdrawal_witness': 'Witness Two'}, {'withdrawal_form_ref': 5, 'withdrawal_witness': 'Witness Two'}])
def test_a_missing_empty_blank_too_long_or_wrong_typed_proof_is_422_and_writes_nothing(rig, body):
    client, port, db = rig; add(client); port.audits.clear()
    r = post(client, **body); assert r.status_code == 422 and r.json()['error_code'] == 'VALIDATION_ERROR'
    row = client.get('/api/firefighters', headers=GOOD).json()[0]; assert row['consent_withdrawn_ts'] is None and row['active'] is True and port.audits == [] and proof_of(db) == (None, None)

def test_a_repeat_changes_nothing_and_keeps_the_first_proof(rig):
    client, port, db = rig; add(client); post(client, withdrawal_form_ref='WF-1', withdrawal_witness='Witness Two'); port.audits.clear()
    r = post(client, withdrawal_form_ref='WF-9', withdrawal_witness='Someone Else'); assert r.status_code == 200 and r.json()['result'] == 'unchanged' and port.audits == []
    assert proof_of(db) == ('WF-1', 'Witness Two')

def test_an_unknown_person_is_still_404_with_a_good_proof(rig):
    client, _, _ = rig; add(client); assert post(client, firefighter_id=99, withdrawal_form_ref='WF-1', withdrawal_witness='W').status_code == 404

def test_the_service_refuses_without_a_proof_and_says_no_value_and_lets_a_repeat_through(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0
    c = connect_db(p); F.add_firefighter(c, NOW, full_name='Sam Example', age_years=30, height_cm=180, weight_kg=80, resting_hr=60, smoker=False, consent=True, consent_form_version='v1', consent_witness='W')
    for kw in ({}, {'form_ref': 'WF-1'}, {'witness': 'W'}, {'form_ref': ' ', 'witness': 'W'}):
        with pytest.raises(F.FirefighterError) as e: F.plan_withdraw(c, 1, NOW, **kw)
        assert e.value.kind != 'missing' and 'Sam' not in str(e.value)
    outcome, stmts, _, _ = F.plan_withdraw(c, 1, NOW, form_ref='WF-1', witness='W'); assert outcome == 'withdrawn' and stmts[0][1][1:3] == ('WF-1', 'W')
    F._txn(c, lambda: [c.execute(s, q) for s, q in stmts]); assert F.plan_withdraw(c, 1, NOW)[0] == 'unchanged'      # already withdrawn: no proof needed
    c.close()

def test_migration_0009_adds_the_two_empty_columns(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; c = connect_db(p, readonly=True)
    try:
        assert applied_versions(c)[-1] == 9 and {'consent_withdrawal_form', 'consent_withdrawal_witness'} <= {r[1] for r in c.execute('PRAGMA table_info(firefighters)')}
    finally: c.close()
