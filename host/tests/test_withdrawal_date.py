"""S8-7a (ADR 0076): POST /api/firefighters/withdraw with an optional withdrawal_date. Covered: a past date is stored as 00:00 UTC of that day while the jacket still ends now, no date or null stores now,
the audit reason has the date suffix only when a date was sent, a bad format / a future date / a date before the consent day are 422 and write nothing, the consent day itself is allowed, and a repeat ignores the date.
Requirements: REQ-API-002."""
import datetime as dt
import pytest
from fastapi.testclient import TestClient
from ppe_host import cli
from ppe_host.api import api_rest as R
from ppe_host.io.db_writer import connect_db
from ppe_host.services import firefighters as F
from test_firefighters_rest import DbPort, add, assign, GOOD, NOW

def day_ms(text): return int(dt.datetime.strptime(text, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
NOW_DAY = dt.datetime.fromtimestamp(NOW / 1000, dt.timezone.utc).strftime('%Y-%m-%d')      # 2027-01-15

@pytest.fixture
def rig(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; port = DbPort(p)
    return TestClient(R.create_app(port, p), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port, p

def withdraw(client, ff, **extra): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two', **extra}, headers=GOOD)      # S8-8: the proof is required
def row(client, n=0): return client.get('/api/firefighters', headers=GOOD).json()[n]

def test_a_past_date_is_stored_as_midnight_utc_and_the_jacket_still_ends_now(rig):
    client, port, db = rig; add(client, consent_date='2027-01-01'); assign(client, 1, 1); port.audits.clear()
    r = withdraw(client, 1, withdrawal_date='2027-01-10'); assert r.status_code == 200 and r.json() == dict(firefighter_id=1, alias='FFR-01', result='withdrawn')
    x = row(client); assert x['consent_withdrawn_ts'] == day_ms('2027-01-10') and x['active'] is False and x['node_id'] is None and x['consent_ts'] == day_ms('2027-01-01')
    c = connect_db(db, readonly=True)
    try: assert c.execute('SELECT end_ts FROM firefighter_assignments WHERE firefighter_id = 1').fetchone()[0] == NOW      # the jacket ended at the call, not at the withdrawal date
    finally: c.close()
    assert port.audits == [dict(action='CONSENT_WITHDRAWN', operator_id=1, node_id=None, reason='firefighter_id 1 (FFR-01) consent withdrawn (withdrawal dated 2027-01-10)')]
    assert 'Sam' not in str(port.audits)

@pytest.mark.parametrize('extra', [{}, {'withdrawal_date': None}])
def test_no_date_or_null_stores_now_and_the_audit_reason_is_the_old_one(rig, extra):
    client, port, _ = rig; add(client); port.audits.clear()
    assert withdraw(client, 1, **extra).status_code == 200 and row(client)['consent_withdrawn_ts'] == NOW
    assert port.audits[0]['reason'] == 'firefighter_id 1 (FFR-01) consent withdrawn'

def test_the_consent_day_itself_is_allowed_even_when_the_consent_was_stored_with_a_time_of_day(rig):
    client, _, _ = rig; add(client)      # no consent date: stored as now, 2027-01-15 08:00 UTC
    assert withdraw(client, 1, withdrawal_date=NOW_DAY).status_code == 200 and row(client)['consent_withdrawn_ts'] == day_ms(NOW_DAY)

@pytest.mark.parametrize('bad, why', [('15/01/2027', 'format'), ('2027-13-40', 'format'), ('yesterday', 'format'), ('2027-01-20', 'future'), ('2026-12-31', 'before the consent')])
def test_a_refused_date_is_422_and_writes_nothing(rig, bad, why):
    client, port, _ = rig; add(client, consent_date='2027-01-01'); assign(client, 1, 1); port.audits.clear()
    bad = '2026-12-31' if why == 'before the consent' else bad
    r = withdraw(client, 1, withdrawal_date=bad); assert r.status_code == 422 and r.json()['error_code'] == 'VALIDATION_ERROR'
    x = row(client); assert x['consent_withdrawn_ts'] is None and x['active'] is True and x['node_id'] == 1 and port.audits == []
    assert 'Sam' not in r.text

def test_the_refusal_sentences_name_the_problem_and_never_the_name(rig):
    client, _, _ = rig; add(client, consent_date='2027-01-01')
    assert 'YYYY-MM-DD' in withdraw(client, 1, withdrawal_date='x').json()['detail']
    assert 'in the future' in withdraw(client, 1, withdrawal_date='2027-02-01').json()['detail']
    assert 'before the consent date' in withdraw(client, 1, withdrawal_date='2026-06-01').json()['detail']

def test_a_wrong_typed_date_is_422_and_an_unknown_person_is_still_404(rig):
    client, _, _ = rig; add(client)
    assert withdraw(client, 1, withdrawal_date=20270110).status_code == 422 and withdraw(client, 1, withdrawal_date='2027-01-10T00:00').status_code == 422
    assert withdraw(client, 99, withdrawal_date='2027-01-10').status_code == 404

def test_a_repeat_ignores_the_date_and_keeps_the_first_one(rig):
    client, port, _ = rig; add(client, consent_date='2027-01-01'); withdraw(client, 1, withdrawal_date='2027-01-05'); port.audits.clear()
    r = withdraw(client, 1, withdrawal_date='2027-01-12'); assert r.status_code == 200 and r.json()['result'] == 'unchanged'
    assert row(client)['consent_withdrawn_ts'] == day_ms('2027-01-05') and port.audits == []
    assert withdraw(client, 1, withdrawal_date='garbage').status_code == 200      # a repeat is not checked

def test_the_service_returns_the_label_and_the_withdrawal_date_checks_directly(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0
    c = connect_db(p); F.add_firefighter(c, NOW, full_name='Sam Example', age_years=30, height_cm=180, weight_kg=80, resting_hr=60, smoker=False, consent=True, consent_form_version='v1', consent_witness='W', consent_date='2027-01-01')
    outcome, stmts, reason, alias = F.plan_withdraw(c, 1, NOW, '2027-01-03', form_ref='WF-1', witness='W'); assert (outcome, alias) == ('withdrawn', 'FFR-01') and reason.endswith('(withdrawal dated 2027-01-03)') and stmts[0][1][0] == day_ms('2027-01-03') and stmts[1][1][0] == NOW
    assert F.withdrawal_ts_of(None, NOW, 0) == (NOW, None) and F.withdrawal_ts_of('', NOW, 0) == (NOW, None)
    with pytest.raises(F.FirefighterError): F.withdrawal_ts_of('2027-01-17', NOW, day_ms('2027-01-01'))      # two days ahead is the future
    assert F.withdrawal_ts_of('2027-01-16', NOW, day_ms('2027-01-01'))[0] == day_ms('2027-01-16')      # tomorrow is the allowed slack
    c.close()
