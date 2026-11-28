// patches/part_s8_8_withdrawal_proof.mjs  (run from repo root: node patches/part_s8_8_withdrawal_proof.mjs [--dry] [--force])
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
  const SV = 'host/ppe_host/services/firefighters.py', PORT = 'host/ppe_host/host_port.py', REST = 'host/ppe_host/api/api_rest.py', MOD = 'host/ppe_host/api/models.py';
  const API = 'dashboard/src/api/firefighters.ts', SP = 'dashboard/src/components/SettingsPanel.tsx';
  const FF_ID = `'firefighter_id': 1`;

  // ===== HOST =====
  put('host/migrations/0009.sql', `-- Migration 0009: the proof kept when consent is withdrawn (S8-8, ADR 0077)
ALTER TABLE firefighters ADD COLUMN consent_withdrawal_form TEXT;
ALTER TABLE firefighters ADD COLUMN consent_withdrawal_witness TEXT;
`);
  replace(SV, `def withdrawal_ts_of(date_text, now_ms, consent_ts):`, `def check_withdrawal_proof(form_ref, witness):
    """S8-8 (ADR 0077): the reference of the paper withdrawal form and the witness, both required like the form version and the witness of the consent. Returns (form_ref, witness) trimmed.
    No message holds either value."""
    return _text('withdrawal form reference', form_ref, 40), _text('withdrawal witness', witness, 80)

def withdrawal_ts_of(date_text, now_ms, consent_ts):`);
  replace(SV, `def plan_withdraw(conn, firefighter_id, now_ms, withdrawal_date=None):`, `def plan_withdraw(conn, firefighter_id, now_ms, withdrawal_date=None, *, form_ref=None, witness=None):`);
  replace(SV, `    recorded the withdrawal; only the legal date moves. A repeat of an already withdrawn person writes nothing and its date is not looked at. A refused date is kind 'invalid' and writes nothing."""`,
`    recorded the withdrawal; only the legal date moves. A repeat of an already withdrawn person writes nothing and its date is not looked at. A refused date is kind 'invalid' and writes nothing.
    S8-8 (ADR 0077): form_ref and witness are required to withdraw (a person already withdrawn is 'unchanged' without them). They are stored in consent_withdrawal_form and consent_withdrawal_witness and
    are in no audit row, response, log or export."""`);
  replace(SV, `    ts, label = withdrawal_ts_of(withdrawal_date, now_ms, f[2])
    stmts = [('UPDATE firefighters SET consent_withdrawn_ts = ?, active = 0 WHERE firefighter_id = ?', (ts, firefighter_id)),`,
`    form, wit = check_withdrawal_proof(form_ref, witness)
    ts, label = withdrawal_ts_of(withdrawal_date, now_ms, f[2])
    stmts = [('UPDATE firefighters SET consent_withdrawn_ts = ?, consent_withdrawal_form = ?, consent_withdrawal_witness = ?, active = 0 WHERE firefighter_id = ?', (ts, form, wit, firefighter_id)),`);
  replace(PORT, `    def withdraw_firefighter(self, firefighter_id, withdrawal_date=None):`, `    def withdraw_firefighter(self, firefighter_id, withdrawal_date=None, form_ref=None, witness=None):`);
  replace(PORT, `F.plan_withdraw(c, firefighter_id, now, withdrawal_date)`, `F.plan_withdraw(c, firefighter_id, now, withdrawal_date, form_ref=form_ref, witness=witness)`);
  replace(REST, `run_in_threadpool(port.withdraw_firefighter, body.firefighter_id, body.withdrawal_date)`, `run_in_threadpool(port.withdraw_firefighter, body.firefighter_id, body.withdrawal_date, body.withdrawal_form_ref, body.withdrawal_witness)`);
  replace(MOD, `    withdrawal_date: Optional[str] = Field(default=None, max_length=10)      # S8-7 (ADR 0076): YYYY-MM-DD, null or absent = now
`, `    withdrawal_date: Optional[str] = Field(default=None, max_length=10)      # S8-7 (ADR 0076): YYYY-MM-DD, null or absent = now
    withdrawal_form_ref: str = Field(min_length=1, max_length=40)            # S8-8 (ADR 0077): the reference of the paper withdrawal form, required
    withdrawal_witness: str = Field(min_length=1, max_length=80)             # S8-8 (ADR 0077): the witness of the withdrawal, required
`);

  // --- existing host tests: the migration count and the proof the withdraw calls now carry ---
  replace('host/tests/test_db_schema.py', `INSERT INTO schema_version VALUES (9, 1, 'future')`, `INSERT INTO schema_version VALUES (10, 1, 'future')`);      // the 'newer than the code' row must stay above the newest migration
  replace('host/tests/test_replay_pause.py', `run_migrations(c, str(MIG), 2) == [4, 5, 6, 7, 8] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8]`, `run_migrations(c, str(MIG), 2) == [4, 5, 6, 7, 8, 9] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]`);
  replace('host/tests/test_replay_speed.py', `run_migrations(c, str(MIG), 2) == [5, 6, 7, 8] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8]`, `run_migrations(c, str(MIG), 2) == [5, 6, 7, 8, 9] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]`);
  replace('host/tests/test_cli_backup.py', `applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8]`, `applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]`);
  replace('host/tests/test_db_schema.py', `applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8]`, `applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]`);
  replace('host/tests/test_firefighters.py', `applied_versions(db) == [1, 2, 3, 4, 5, 6, 7, 8]`, `applied_versions(db) == [1, 2, 3, 4, 5, 6, 7, 8, 9]`);
  replace('host/tests/test_migration_0003.py', `fresh(tmp_path); assert applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8]          # S7-5a added 0004, S7-7a 0005, S8-1 0006, S8-3a 0007, S8-5 0008`, `fresh(tmp_path); assert applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]          # S7-5a added 0004, S7-7a 0005, S8-1 0006, S8-3a 0007, S8-5 0008, S8-8 0009`);
  replace('host/tests/test_migration_0003.py', `run_migrations(c, str(MIG), 2) == [3, 4, 5, 6, 7, 8] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8]`, `run_migrations(c, str(MIG), 2) == [3, 4, 5, 6, 7, 8, 9] and applied_versions(c) == [1, 2, 3, 4, 5, 6, 7, 8, 9]`);
  replace('host/tests/test_firefighter_withdraw.py', `def withdraw(client, ff): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff}, headers=GOOD)`,
    `def withdraw(client, ff): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two'}, headers=GOOD)      # S8-8: the proof is required`);
  replace('host/tests/test_firefighter_withdraw.py', `outcome, stmts, _, _ = F.plan_withdraw(c, 1, 2000);`, `outcome, stmts, _, _ = F.plan_withdraw(c, 1, 2000, form_ref='WF-1', witness='W');`);
  replace('host/tests/test_firefighter_withdraw.py', `    _, stmts, _, _ = F.plan_withdraw(c, 1, 2000);`, `    _, stmts, _, _ = F.plan_withdraw(c, 1, 2000, form_ref='WF-1', witness='W');`);
  replace('host/tests/test_withdrawal_date.py', `def withdraw(client, ff, **extra): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff, **extra}, headers=GOOD)`,
    `def withdraw(client, ff, **extra): return client.post('/api/firefighters/withdraw', json={'firefighter_id': ff, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two', **extra}, headers=GOOD)      # S8-8: the proof is required`);
  replace('host/tests/test_withdrawal_date.py', `F.plan_withdraw(c, 1, NOW, '2027-01-03')`, `F.plan_withdraw(c, 1, NOW, '2027-01-03', form_ref='WF-1', witness='W')`);
  replace('host/tests/test_firefighters_rest.py', `    def withdraw_firefighter(self, firefighter_id, withdrawal_date=None):      # S8-5, S8-7`, `    def withdraw_firefighter(self, firefighter_id, withdrawal_date=None, form_ref=None, witness=None):      # S8-5, S8-7, S8-8`);
  replace('host/tests/test_firefighters_rest.py', `F.plan_withdraw(c, firefighter_id, NOW, withdrawal_date)`, `F.plan_withdraw(c, firefighter_id, NOW, withdrawal_date, form_ref=form_ref, witness=witness)`);
  replace('host/tests/test_api_endpoint_table.py', `    def withdraw_firefighter(self, ff, withdrawal_date=None):      # S8-5, S8-7`, `    def withdraw_firefighter(self, ff, withdrawal_date=None, form_ref=None, witness=None):      # S8-5, S8-7, S8-8`);
  replace('host/tests/test_api_endpoint_table.py', `('/api/firefighters/withdraw', {'firefighter_id': 1}, None)}`, `('/api/firefighters/withdraw', {'firefighter_id': 1, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two'}, None)}`);
  replace('host/tests/test_api_endpoint_table.py', `'/api/firefighters/withdraw', {'firefighter_id': 99}, None, 404`, `'/api/firefighters/withdraw', {'firefighter_id': 99, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two'}, None, 404`);
  replace('host/tests/test_api_endpoint_table.py', `'/api/firefighters/withdraw', {'firefighter_id': 1}, None, 409`, `'/api/firefighters/withdraw', {'firefighter_id': 1, 'withdrawal_form_ref': 'WF-1', 'withdrawal_witness': 'Witness Two'}, None, 409`);

  // --- the new host tests ---
  put('host/tests/test_withdrawal_proof.py', `"""S8-8 (ADR 0077): withdrawing consent needs the reference of the paper withdrawal form and a witness. Covered: both are stored (trimmed) in migration 0009's columns, a missing, empty, blank or too long
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
`);

  // ===== DASHBOARD =====
  replace(API, `export const postWithdraw = (api: Api, firefighterId: number, withdrawalDate?: string): Promise<ActionResult<WithdrawnBody>> => request<WithdrawnBody>(api, 'POST', '/api/firefighters/withdraw', withdrawalDate ? { firefighter_id: firefighterId, withdrawal_date: withdrawalDate } : { firefighter_id: firefighterId });`,
`// ADR 0077: the reference of the paper withdrawal form and its witness are required, like the form version and the witness of the consent. Both are sent trimmed.
export interface WithdrawProof { formRef: string; witness: string }
export const postWithdraw = (api: Api, firefighterId: number, proof: WithdrawProof, withdrawalDate?: string): Promise<ActionResult<WithdrawnBody>> =>
  request<WithdrawnBody>(api, 'POST', '/api/firefighters/withdraw', { firefighter_id: firefighterId, withdrawal_form_ref: proof.formRef.trim(), withdrawal_witness: proof.witness.trim(), ...(withdrawalDate ? { withdrawal_date: withdrawalDate } : {}) });
// The first problem with the proof of a withdrawal as a sentence, or null. The limits are those of the host (40 and 80 characters).
export function checkWithdrawalProof(formRef: string, witness: string): string | null {
  if (formRef.trim() === '') return 'Enter the reference of the withdrawal form.';
  if (witness.trim() === '') return 'Enter the name of the witness.';
  if (formRef.trim().length > 40) return 'The form reference is at most 40 characters.';
  if (witness.trim().length > 80) return 'The witness name is at most 80 characters.';
  return null;
}`);
  replace(SP, `checkForm, checkWithdrawalDate, downloadReadings,`, `checkForm, checkWithdrawalDate, checkWithdrawalProof, downloadReadings,`);
  replace(SP, `[withdrawDate, setWithdrawDate] = useState('');`, `[withdrawDate, setWithdrawDate] = useState(''), [withdrawForm, setWithdrawForm] = useState(''), [withdrawWitness, setWithdrawWitness] = useState('');`);
  replace(SP, `    const bad = checkWithdrawalDate(withdrawDate, localToday(), r.consent_ts);`, `    const noProof = checkWithdrawalProof(withdrawForm, withdrawWitness);      // ADR 0077: the form reference and the witness come first
    if (noProof) { setBusy(false); setNote(noProof); return; }
    const bad = checkWithdrawalDate(withdrawDate, localToday(), r.consent_ts);`);
  replace(SP, `await postWithdraw(api, r.firefighter_id, withdrawDate);`, `await postWithdraw(api, r.firefighter_id, { formRef: withdrawForm, witness: withdrawWitness }, withdrawDate);`);
  replace(SP, `setWithdrawDate(''); setConfirming(r);`, `setWithdrawDate(''); setWithdrawForm(''); setWithdrawWitness(''); setConfirming(r);`);
  replace(SP, `onChange={(e) => setWithdrawDate(e.target.value)} /></label>`, `onChange={(e) => setWithdrawDate(e.target.value)} /></label>
                <label className="block text-base">Withdrawal form reference<input type="text" className={FIELD} value={withdrawForm} maxLength={40} disabled={busy} onChange={(e) => setWithdrawForm(e.target.value)} /></label>
                <label className="block text-base">Witness to the withdrawal<input type="text" className={FIELD} value={withdrawWitness} maxLength={80} disabled={busy} onChange={(e) => setWithdrawWitness(e.target.value)} /></label>`);

  // --- existing dashboard tests: the proof is filled in before Yes ---
  const FILL = `fireEvent.change(screen.getByLabelText('Withdrawal form reference'), { target: { value: 'WF-1' } }); fireEvent.change(screen.getByLabelText('Witness to the withdrawal'), { target: { value: 'Witness Two' } });`;
  replace('dashboard/tests/firefighter_edit.test.tsx', `expect(posts(h)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' })); fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));`,
`expect(posts(h)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' })); ${FILL} fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));`);
  replace('dashboard/tests/firefighter_edit.test.tsx', `body: { firefighter_id: 1 } }]);`, `body: { firefighter_id: 1, withdrawal_form_ref: 'WF-1', withdrawal_witness: 'Witness Two' } }]);`);
  replace('dashboard/tests/firefighter_edit.test.tsx', `toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' })); fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));`,
`toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' })); ${FILL} fireEvent.click(screen.getByRole('button', { name: 'Yes, withdraw consent' }));`);
  replace('dashboard/tests/withdrawal_date.test.tsx', `  return screen.getByRole('alertdialog', { name: 'Withdraw consent for FFR-01' });
}`, `  const dlg = screen.getByRole('alertdialog', { name: 'Withdraw consent for FFR-01' });
  fireEvent.change(within(dlg).getByLabelText('Withdrawal form reference'), { target: { value: 'WF-1' } }); fireEvent.change(within(dlg).getByLabelText('Witness to the withdrawal'), { target: { value: 'Witness Two' } });      // ADR 0077
  return dlg;
}`);
  replace('dashboard/tests/withdrawal_date.test.tsx', `and a plain Yes sends exactly {firefighter_id}`, `and a plain Yes sends no date`);
  replace('dashboard/tests/withdrawal_date.test.tsx', `method: 'POST', body: { firefighter_id: 1 } }]);`, `method: 'POST', body: { firefighter_id: 1, withdrawal_form_ref: 'WF-1', withdrawal_witness: 'Witness Two' } }]);`);
  replace('dashboard/tests/withdrawal_date.test.tsx', `body: { firefighter_id: 1, withdrawal_date: '2025-06-15' } }]);`, `body: { firefighter_id: 1, withdrawal_form_ref: 'WF-1', withdrawal_witness: 'Witness Two', withdrawal_date: '2025-06-15' } }]);`);

  put('dashboard/tests/withdrawal_proof.test.tsx', `// @vitest-environment jsdom
// Requirements: REQ-API-002
// ADR 0077 (S8-8): the Withdraw consent dialog asks for the reference of the withdrawal form and a witness. Both are required: an empty or blank one is said on the screen and nothing is sent; typed values are
// sent trimmed; both fields are empty each time the dialog opens and limited to the host's 40 and 80 characters; and the logic of checkWithdrawalProof.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import SettingsPanel from '../src/components/SettingsPanel.tsx';
import { checkWithdrawalProof, type FirefighterRow } from '../src/api/firefighters.ts';
import { liveStore } from '../src/store/live.ts';
import { wearerStore } from '../src/store/wearers.ts';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const ROW: FirefighterRow = { firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null,
  consent_ts: Date.UTC(2020, 0, 1), consent_form_version: 'v1', active: true, node_id: null, consent_withdrawn_ts: null };
const FORM = 'Withdrawal form reference', WIT = 'Witness to the withdrawal';
type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function host() {
  const calls: Call[] = []; let list = [ROW];
  const reply = (status: number, b: unknown) => ({ status, json: async () => b }) as unknown as Response;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = String(init.method), body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined; calls.push({ url, method, body });
    if (url === '/api/firefighters' && method === 'GET') return reply(200, list);
    if (url === '/api/firefighters/withdraw') { list = list.map((r) => ({ ...r, active: false, node_id: null, consent_withdrawn_ts: 9 })); return reply(200, { firefighter_id: 1, alias: 'FFR-01', result: 'withdrawn' }); }
    return reply(500, {});
  }) as unknown as typeof fetch;
  return { calls, api: { fetchFn, getToken: () => 't' } };
}
const posts = (h: ReturnType<typeof host>) => h.calls.filter((c) => c.method === 'POST');
beforeEach(() => { liveStore.setState(apply(initialState('CONNECTING'), snapshot() as unknown as ServerMessage).state); wearerStore.setState({ byNode: {} }); });
afterEach(cleanup);
async function openDialog(h: ReturnType<typeof host>) {
  render(<SettingsPanel api={h.api} onClose={() => {}} />); await screen.findByText('Sam Example');
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' }));
  return screen.getByRole('alertdialog', { name: 'Withdraw consent for FFR-01' });
}
const type = (dlg: HTMLElement, label: string, value: string) => fireEvent.change(within(dlg).getByLabelText(label), { target: { value } });
const yes = (dlg: HTMLElement) => fireEvent.click(within(dlg).getByRole('button', { name: 'Yes, withdraw consent' }));

describe('checkWithdrawalProof', () => {
  it('needs both, ignores blanks, and keeps to the host limits', () => {
    expect(checkWithdrawalProof('WF-1', 'Witness Two')).toBeNull(); expect(checkWithdrawalProof('', 'W')).toContain('form'); expect(checkWithdrawalProof('   ', 'W')).toContain('form');
    expect(checkWithdrawalProof('WF-1', '')).toContain('witness'); expect(checkWithdrawalProof('WF-1', '  ')).toContain('witness');
    expect(checkWithdrawalProof('x'.repeat(41), 'W')).toContain('40'); expect(checkWithdrawalProof('x'.repeat(40), 'W')).toBeNull(); expect(checkWithdrawalProof('WF', 'x'.repeat(81))).toContain('80'); expect(checkWithdrawalProof('WF', 'x'.repeat(80))).toBeNull();
  });
});

describe('the Withdraw consent dialog asks for the proof', () => {
  it('has two empty text fields with the host limits, and the dialog never shows the name', async () => {
    const h = host(); const dlg = await openDialog(h); const f = within(dlg).getByLabelText(FORM) as HTMLInputElement, w = within(dlg).getByLabelText(WIT) as HTMLInputElement;
    expect(f.type).toBe('text'); expect(f.value).toBe(''); expect(f.maxLength).toBe(40); expect(w.type).toBe('text'); expect(w.value).toBe(''); expect(w.maxLength).toBe(80); expect(dlg.textContent).not.toContain('Sam');
  });
  it('Yes with nothing typed, or with only one of them, says what is missing and sends nothing', async () => {
    const h = host(); const dlg = await openDialog(h);
    yes(dlg); expect((await screen.findByRole('status')).textContent).toContain('reference of the withdrawal form');
    type(dlg, FORM, 'WF-1'); yes(dlg); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('name of the witness'));
    type(dlg, FORM, '   '); type(dlg, WIT, 'Witness Two'); yes(dlg); await waitFor(() => expect(screen.getByRole('status').textContent).toContain('reference of the withdrawal form'));
    expect(posts(h)).toEqual([]); expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
  it('typed values are sent trimmed with the withdrawal', async () => {
    const h = host(); const dlg = await openDialog(h); type(dlg, FORM, '  WF-2026-014 '); type(dlg, WIT, ' Witness Two  '); yes(dlg);
    expect((await screen.findByRole('status')).textContent).toContain('Consent withdrawn for FFR-01');
    expect(posts(h)).toEqual([{ url: '/api/firefighters/withdraw', method: 'POST', body: { firefighter_id: 1, withdrawal_form_ref: 'WF-2026-014', withdrawal_witness: 'Witness Two' } }]);
  });
  it('both fields are empty again each time the dialog is opened', async () => {
    const h = host(); const dlg = await openDialog(h); type(dlg, FORM, 'WF-1'); type(dlg, WIT, 'Witness Two'); fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw consent for FFR-01' }));
    expect((screen.getByLabelText(FORM) as HTMLInputElement).value).toBe(''); expect((screen.getByLabelText(WIT) as HTMLInputElement).value).toBe(''); expect(posts(h)).toEqual([]);
  });
});
`);

  // ===== RECORDS =====
  replace('docs/design/s03-8.md', `• POST /api/firefighters/withdraw — Req: {firefighter_id, and optionally withdrawal_date as YYYY-MM-DD, ADR 0076} -> 200`, `• POST /api/firefighters/withdraw — Req: {firefighter_id, withdrawal_form_ref, withdrawal_witness, and optionally withdrawal_date as YYYY-MM-DD, ADR 0076 and 0077} -> 200`);
  replace('docs/design/s03-8.md', `| 422 (a missing or wrong-typed field, or a withdrawal date`, `| 422 (a missing, empty or wrong-typed field, among them the form reference and the witness, or a withdrawal date`);
  append('docs/design/s03-8.md', `
WITHDRAWAL PROOF addendum (ADR 0077, Proposed; Rev 3.45 itself is unchanged)
• Withdrawal proof (the route POST /api/firefighters/withdraw above, no new endpoint): withdrawal_form_ref (the reference of the paper withdrawal form, at most 40 characters) and withdrawal_witness (at most 80) are required, as the form version and the witness are for the consent; an empty or blank value is 422 and nothing is written. Both are trimmed and stored in firefighters.consent_withdrawal_form and consent_withdrawal_witness (migration 0009, two nullable columns; no new audit action). They are in no response, no audit row (the CONSENT_WITHDRAWN reason is unchanged), no log and no export. A repeat of an already withdrawn person needs no new proof and keeps the first.
`);
  put('docs/adr/0077.md', `# ADR 0077: A withdrawal needs the form reference and a witness (S8-8, host and dashboard)

Status: Proposed (decided with the operator on 2026-11-28; confirm with the data-governance owner and at the next design review).

Design: Rev 3.45 stays frozen. This ADR adds two required fields to the existing \`POST /api/firefighters/withdraw\` (ADR 0074, 0076) and one migration. No new endpoint, no new audit action, no wire message and no new error code.

## Why

Consent is recorded with its form version and a witness (ADR 0070). A withdrawal had no such record in the software, so nothing tied a withdrawal in the database to the paper form that proves it. Question 5 of the governance question sheet (28 November 2026) asked whether withdrawal should ask for the same proof; the operator chose yes.

## Decisions

- **A. Two required fields.** \`withdrawal_form_ref\` (1 to 40 characters) and \`withdrawal_witness\` (1 to 80), trimmed. A missing, empty, blank, too long or wrong-typed value is HTTP 422 and writes nothing, not even the audit row. They are checked before the date (ADR 0076).
- **B. Migration 0009.** \`firefighters.consent_withdrawal_form\` and \`firefighters.consent_withdrawal_witness\`, both TEXT and nullable (people who never withdrew have none). They are set in the same statement that stores \`consent_withdrawn_ts\`, so the date and its proof are written together or not at all.
- **C. The proof stays in the database.** It is in no response (not in GET /api/firefighters either), no audit row, no log and no export. The audit reason is unchanged (id and alias only): a witness is a person's name, and the form reference is free text that an operator could type a name into, so neither goes into a row that other screens read. The dashboard keeps the values only until the request is sent.
- **D. A repeat needs no new proof.** A person who already withdrew gets \`unchanged\` and the first proof stays; the fields are still required by the request shape, so a client sends them every time.
- **E. Dashboard.** The Withdraw consent dialog has two text fields, "Withdrawal form reference" (40) and "Witness to the withdrawal" (80), empty each time the dialog opens. An empty or blank one is said on the screen and nothing is sent. This is a breaking change for any other client of the route: it must send both fields.

## Not here (open points)

- **Whether the proof must be checked against a paper register.** The software only records what the operator typed.
- **Correcting a wrong proof or date.** Still not possible through the software (ADR 0074, 0076): it needs the governance owner and a database correction. Whether an administrator may correct it, with an audit row, is open (question 5 of the sheet).
- **Erasure (question 1-B).** When erasure on withdrawal is built, it must decide what happens to these two columns; the witness name is personal data of a third person.
- **The Word documents** do not describe this yet; it belongs in the consolidated Rev 3.46.

## Tests

\`host/tests/test_withdrawal_proof.py\` (stored trimmed; in no audit row, response or list; eleven refused shapes are 422 and write nothing; a repeat keeps the first; the service refuses without it and lets a repeat through; migration 0009), plus the updated migration-count, endpoint-table, withdraw and withdrawal-date tests. Dashboard: \`tests/withdrawal_proof.test.tsx\`, and the updated \`firefighter_edit\` and \`withdrawal_date\` tests.
`);
  append('docs/PROGRESS.md', `- Part S8-8 done (ADR 0077; a withdrawal needs the form reference and a witness, host and dashboard, one patch): POST /api/firefighters/withdraw now requires withdrawal_form_ref (at most 40) and withdrawal_witness (at most 80), trimmed; empty or blank is 422 and writes nothing. Migration 0009 adds firefighters.consent_withdrawal_form and consent_withdrawal_witness (nullable), set with consent_withdrawn_ts. They are in no response, audit row, log or export (the CONSENT_WITHDRAWN reason is unchanged); a repeat keeps the first. The Withdraw consent dialog has the two fields. Breaking for other clients of the route.
- Governance answers of 28 November 2026 (operator's choices, for the data-governance owner to confirm; see docs/governance-questions sheet in the chat history and CODING_GUIDE section 8): Q3 any signed-in operator may withdraw (no change); Q5 form reference and witness (S8-8, done). NOT BUILT YET: Q1-B erase the name and the profile numbers on withdrawal and keep the readings unlinked; Q2-B names in the jacket picker on the operator screen only; Q4a profile numbers in an export next to the alias; Q4b a history of profile values. Open: how a wrong withdrawal date or proof is corrected.
`);
  append('docs/CODING_GUIDE.md', `
## 8. Later work from the governance answers (28 November 2026)

These are the operator's choices on the governance question sheet. The data-governance owner has not confirmed them yet. S8-8 (Q5) is built. The rest is not, because each one reverses a rule written in an earlier ADR and needs its own ADR first. Do not build any of them without that ADR and without the owner's confirmation.

- **Q1-B, erasure on withdrawal.** On withdrawal, erase \`full_name\` and the profile numbers (age, height, weight, resting and maximum heart rate, smoker, years of service); keep the consent record (form version, witness, consent date), the withdrawal date and proof, and keep the readings and assignments with no link to a person. Reverses ADR 0074 ("nothing is deleted"). Needs: a new erase step in the same atomic unit as the withdrawal; a rule for the audit row (ids only); what happens to the older backups; what happens to the proof columns of migration 0009 (the witness is a person's name); and how it meets Q4b (below).
- **Q2-B, names in the jacket picker.** Show the name next to the alias in the Start monitoring and New shift pickers, on the operator's screen only; node cards, logs and exports keep the alias. Reverses the alias-only rule of ADR 0070 and 0072 (and the tests that assert no name in the picker). Dashboard only; the wearers store needs the name.
- **Q4a, profile numbers in an export.** A forecasting export with the profile numbers next to the alias, never the name. Reverses ADR 0073 (alias and readings only). Needs its own endpoint or columns, and a rule that a withdrawn person is left out.
- **Q4b, history of profile values.** A table that keeps each profile value with the time it started to be true, so a reading can be matched to the values of that day (today an edit overwrites). Needs a migration, a write on add and on edit, and a rule for withdrawal (Q1-B erases it too).
- **Order.** Q4b, then Q4a (it reads the history), then Q1-B (it must erase the history), then Q2-B (independent). Each one is its own ADR and its own patch.
- **Open question.** How a wrong withdrawal date or proof is corrected (an administrator function with its own audit row, or a developer database correction with the owner's approval). Q3 stays: any signed-in operator may record a withdrawal.
`);
}
