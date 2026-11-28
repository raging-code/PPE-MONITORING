// patches/part_s8_7a_withdrawal_date_host.mjs  (run from repo root: node patches/part_s8_7a_withdrawal_date_host.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  // --- the service: the date checks and plan_withdraw ---
  replace('host/ppe_host/services/firefighters.py', `def _audit(conn, now_ms, action, reason, node_id=None):`,
`def withdrawal_ts_of(date_text, now_ms, consent_ts):
    """S8-7 (ADR 0076): the withdrawal date as (ms, YYYY-MM-DD), or (now, None) when none is given. The checks are those of the consent date: YYYY-MM-DD, not later than tomorrow (time zones),
    and a withdrawal cannot come before the day of the consent it withdraws."""
    if not date_text: return now_ms, None
    try: d = dt.datetime.strptime(date_text, '%Y-%m-%d').replace(tzinfo=dt.timezone.utc)
    except ValueError: raise FirefighterError('the withdrawal date must be YYYY-MM-DD') from None
    ts = int(d.timestamp() * 1000)
    if ts > now_ms + 86_400_000: raise FirefighterError('the withdrawal date is in the future')
    if ts < consent_ts - consent_ts % 86_400_000: raise FirefighterError('the withdrawal date is before the consent date')
    return ts, d.strftime('%Y-%m-%d')

def _audit(conn, now_ms, action, reason, node_id=None):`);
  replace('host/ppe_host/services/firefighters.py', `def plan_withdraw(conn, firefighter_id, now_ms):`, `def plan_withdraw(conn, firefighter_id, now_ms, withdrawal_date=None):`);
  replace('host/ppe_host/services/firefighters.py', `    with a new consent. An unknown firefighter is kind 'missing'."""
    f = conn.execute('SELECT alias, consent_withdrawn_ts FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
    if f is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id, 'missing')
    if f[1] is not None: return 'unchanged', [], None, f[0]
    stmts = [('UPDATE firefighters SET consent_withdrawn_ts = ?, active = 0 WHERE firefighter_id = ?', (now_ms, firefighter_id)),
             ('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE firefighter_id = ? AND end_ts IS NULL', (now_ms, firefighter_id))]
    return 'withdrawn', stmts, 'firefighter_id %d (%s) consent withdrawn' % (firefighter_id, f[0]), f[0]`,
`    with a new consent. An unknown firefighter is kind 'missing'.
    S8-7 (ADR 0076): withdrawal_date (YYYY-MM-DD, optional) is the day the person withdrew, for a paper withdrawal from an earlier day; it is stored in consent_withdrawn_ts (00:00 UTC of that day)
    and checked like the consent date (not in the future, not before the consent day). Without it the stored time is now. The jacket is still ended now, because the person wore it until the operator
    recorded the withdrawal; only the legal date moves. A repeat of an already withdrawn person writes nothing and its date is not looked at. A refused date is kind 'invalid' and writes nothing."""
    f = conn.execute('SELECT alias, consent_withdrawn_ts, consent_ts FROM firefighters WHERE firefighter_id = ?', (firefighter_id,)).fetchone()
    if f is None: raise FirefighterError('no firefighter with firefighter_id %d' % firefighter_id, 'missing')
    if f[1] is not None: return 'unchanged', [], None, f[0]
    ts, label = withdrawal_ts_of(withdrawal_date, now_ms, f[2])
    stmts = [('UPDATE firefighters SET consent_withdrawn_ts = ?, active = 0 WHERE firefighter_id = ?', (ts, firefighter_id)),
             ('UPDATE firefighter_assignments SET end_ts = MAX(?, start_ts) WHERE firefighter_id = ? AND end_ts IS NULL', (now_ms, firefighter_id))]
    return 'withdrawn', stmts, 'firefighter_id %d (%s) consent withdrawn%s' % (firefighter_id, f[0], '' if label is None else ' (withdrawal dated %s)' % label), f[0]`);

  // --- the port, the route, the model ---
  replace('host/ppe_host/host_port.py', `    def withdraw_firefighter(self, firefighter_id):`, `    def withdraw_firefighter(self, firefighter_id, withdrawal_date=None):`);
  replace('host/ppe_host/host_port.py', `F.plan_withdraw(c, firefighter_id, now)`, `F.plan_withdraw(c, firefighter_id, now, withdrawal_date)`);
  replace('host/ppe_host/api/api_rest.py', `run_in_threadpool(port.withdraw_firefighter, body.firefighter_id)`, `run_in_threadpool(port.withdraw_firefighter, body.firefighter_id, body.withdrawal_date)`);
  replace('host/ppe_host/api/models.py', `class FirefighterWithdrawReq(_Strict):
    firefighter_id: int = Field(ge=1)
`, `class FirefighterWithdrawReq(_Strict):
    firefighter_id: int = Field(ge=1)
    withdrawal_date: Optional[str] = Field(default=None, max_length=10)      # S8-7 (ADR 0076): YYYY-MM-DD, null or absent = now
`);

  // --- the test doubles that stand in for the port ---
  replace('host/tests/test_api_endpoint_table.py', `    def withdraw_firefighter(self, ff):      # S8-5`, `    def withdraw_firefighter(self, ff, withdrawal_date=None):      # S8-5, S8-7`);
  replace('host/tests/test_firefighters_rest.py', `    def withdraw_firefighter(self, firefighter_id):      # S8-5`, `    def withdraw_firefighter(self, firefighter_id, withdrawal_date=None):      # S8-5, S8-7`);
  replace('host/tests/test_firefighters_rest.py', `F.plan_withdraw(c, firefighter_id, NOW)`, `F.plan_withdraw(c, firefighter_id, NOW, withdrawal_date)`);

  // --- the design record ---
  replace('docs/design/s03-8.md', `• POST /api/firefighters/withdraw — Req: {firefighter_id} -> 200`, `• POST /api/firefighters/withdraw — Req: {firefighter_id, and optionally withdrawal_date as YYYY-MM-DD, ADR 0076} -> 200`);
  replace('docs/design/s03-8.md', `| 422 (a missing or wrong-typed field). The call is the twenty-second endpoint of the list.`, `| 422 (a missing or wrong-typed field, or a withdrawal date that is not YYYY-MM-DD, is in the future or is before the day of the consent). The call is the twenty-second endpoint of the list.`);
  append('docs/design/s03-8.md', `
WITHDRAWAL DATE addendum (ADR 0076, Proposed; Rev 3.45 itself is unchanged)
• Withdrawal date (the route POST /api/firefighters/withdraw above, no new endpoint): the optional field withdrawal_date (YYYY-MM-DD) is the day the person withdrew consent, for a paper withdrawal from an earlier day. consent_withdrawn_ts is then 00:00 UTC of that day; without the field it is the time of the call, as before. The date is checked like the consent date (not later than tomorrow, not before the day of the consent). The jacket still ends at the time of the call, and the response is unchanged. The CONSENT_WITHDRAWN reason gets the suffix (withdrawal dated YYYY-MM-DD) only when a date was sent. No migration and no new audit action.
`);
  put('docs/adr/0076.md', `# ADR 0076: The withdrawal date can be entered (S8-7a host, S8-7b dashboard)

Status: Proposed (decided with the operator on 2026-11-28; confirm at the next design review).

Design: Rev 3.45 stays frozen. This ADR adds one optional field to the existing \`POST /api/firefighters/withdraw\` (ADR 0074). No new endpoint, no migration, no audit action, no wire message and no new error code.

## Why

ADR 0074 stores the moment the operator pressed Withdraw consent as the date of the withdrawal (\`firefighters.consent_withdrawn_ts\`). A person who withdrew on paper on an earlier day (for example on a Monday, entered on the Thursday) therefore got the wrong date in the record that says when consent ended. That date is the legal record, so it has to be the day of the withdrawal.

## Decisions

- **A. An optional \`withdrawal_date\` (YYYY-MM-DD).** Absent or null means now, as before, so no existing client changes. When given, \`consent_withdrawn_ts\` is 00:00 UTC of that day, the same convention as the consent date (ADR 0070).
- **B. The same checks as the consent date, plus one.** A malformed date is refused; a date later than tomorrow is refused (the one day of slack covers time zones, as for the consent date); a date before the day of the consent is refused, because a person cannot withdraw something they had not yet given. The comparison is by day, so a withdrawal on the day of the consent is allowed even though a consent given with no date is stored with the time of day. A refused date is HTTP 422 and writes nothing, not even the audit row.
- **C. Only the legal date moves; the jacket ends now.** The assignment is ended at the time of the call, as in ADR 0074. The person did wear the jacket until the operator recorded the withdrawal, and \`firefighter_assignments\` is the record of who wore what. Back-dating it would make readings that really were taken from them look like another person's. The readings of a withdrawn person are left out of the per-firefighter export whatever the date (ADR 0074), so the date does not change what is exported.
- **D. A repeat is still a repeat.** A person who already withdrew gets \`unchanged\` and no row; the date sent with a repeat is not looked at and never overwrites the first date.
- **E. The audit row says so.** When a date was sent, the CONSENT_WITHDRAWN reason gets the suffix \`(withdrawal dated YYYY-MM-DD)\`. The id and the alias are there as before; no name and no other personal value.
- **F. Dashboard.** The Withdraw consent dialog has an optional "Date consent was withdrawn" field (empty = today; it cannot be later than today on the screen). It is sent only when filled in, so a plain withdrawal sends exactly what it sent before.

## Not here (open points)

- **Whether the withdrawal date must come from a paper form.** The software does not ask for a witness or a form reference at withdrawal; whether it should is a question for the data-governance owner.
- **Correcting a wrong date.** A withdrawal cannot be undone or re-dated through the software (ADR 0074); a wrong date needs the governance owner and a database correction.
- **The Word documents** do not describe this yet; it belongs in the consolidated Rev 3.46.

## Tests

\`host/tests/test_withdrawal_date.py\` (a past date is stored as 00:00 UTC of that day and the jacket still ends now; no date stores now; the audit suffix only with a date; refusals for a bad format, a future date and a date before the consent write nothing; the consent day itself is allowed; a repeat ignores the date; null is the same as absent). Dashboard: \`tests/withdrawal_date.test.tsx\`.
`);
  append('docs/PROGRESS.md', `- Part S8-7 done (ADR 0076; the withdrawal date can be entered, host and dashboard): POST /api/firefighters/withdraw takes an optional withdrawal_date (YYYY-MM-DD, null or absent = now). It is stored in consent_withdrawn_ts as 00:00 UTC of that day and checked like the consent date (not later than tomorrow, not before the consent day; a refused date is 422 and writes nothing). The jacket still ends at the time of the call; a repeat ignores the date; the CONSENT_WITHDRAWN reason gets (withdrawal dated YYYY-MM-DD) only when a date was sent. No new endpoint, migration or audit action. S8-7a is the host, S8-7b the dashboard.
`);

  // --- the tests ---
  put('host/tests/test_withdrawal_date.py', `"""S8-7a (ADR 0076): POST /api/firefighters/withdraw with an optional withdrawal_date. Covered: a past date is stored as 00:00 UTC of that day while the jacket still ends now, no date or null stores now,
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

def withdraw(client, ff, **extra): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff, **extra}, headers=GOOD)
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
    outcome, stmts, reason, alias = F.plan_withdraw(c, 1, NOW, '2027-01-03'); assert (outcome, alias) == ('withdrawn', 'FFR-01') and reason.endswith('(withdrawal dated 2027-01-03)') and stmts[0][1][0] == day_ms('2027-01-03') and stmts[1][1][0] == NOW
    assert F.withdrawal_ts_of(None, NOW, 0) == (NOW, None) and F.withdrawal_ts_of('', NOW, 0) == (NOW, None)
    with pytest.raises(F.FirefighterError): F.withdrawal_ts_of('2027-01-17', NOW, day_ms('2027-01-01'))      # two days ahead is the future
    assert F.withdrawal_ts_of('2027-01-16', NOW, day_ms('2027-01-01'))[0] == day_ms('2027-01-16')      # tomorrow is the allowed slack
    c.close()
`);
}
