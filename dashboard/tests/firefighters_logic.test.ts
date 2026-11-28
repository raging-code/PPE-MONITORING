// Requirements: REQ-API-002
// ADR 0071: the Add firefighter form checks, the messages and the wearer map. Pure functions, no browser.
import { describe, it, expect } from 'vitest';
import { addMessage, assignMessage, checkForm, emptyForm, wearersOf, type FirefighterRow } from '../src/api/firefighters.ts';

const TODAY = '2026-11-28';
const OK = { ...emptyForm(TODAY), name: ' Sam Example ', age: '34', height: '180', weight: '82.5', restingHr: '58', smoker: 'no' as const, consent: true, formVersion: 'v1', witness: 'Witness One' };
const row = (o: Partial<FirefighterRow>): FirefighterRow => ({ firefighter_id: 1, alias: 'FFR-01', full_name: 'Sam', sex: null, age_years: 30, height_cm: 175, weight_kg: 70, resting_hr: 60, max_hr: null, smoker: false, years_service: null, consent_ts: 1, consent_form_version: 'v1', active: true, node_id: null, ...o });

describe('checkForm', () => {
  it('turns a complete form into the body the host takes (trimmed, numbers as numbers, null for the optional blanks)', () => {
    expect(checkForm(OK, TODAY)).toEqual({ body: { full_name: 'Sam Example', sex: null, age_years: 34, height_cm: 180, weight_kg: 82.5, resting_hr: 58, max_hr: null, smoker: false, years_service: null,
      consent: true, consent_form_version: 'v1', consent_witness: 'Witness One', consent_date: TODAY } });
  });
  it('sends the optional fields when they are filled, and null for a blank consent date', () => {
    expect(checkForm({ ...OK, maxHr: '190', years: '7.5', sex: 'F', smoker: 'yes', date: '' }, TODAY)).toMatchObject({ body: { max_hr: 190, years_service: 7.5, sex: 'F', smoker: true, consent_date: null } });
  });
  it.each([
    [{ name: '' }, 'Full name is required.'], [{ age: '99' }, 'Age must be 16 to 80.'], [{ age: '3.5' }, 'Age must be a whole number.'], [{ weight: 'abc' }, 'Weight must be a number.'],
    [{ height: '' }, 'Height is required.'], [{ restingHr: '20' }, 'Resting heart rate must be 30 to 120.'], [{ maxHr: '50' }, 'Maximum heart rate must be 100 to 230.'], [{ maxHr: '100', restingHr: '110' }, 'Maximum heart rate must be above the resting heart rate.'],
    [{ smoker: '' as const }, 'Say whether the firefighter smokes.'], [{ consent: false }, 'Tick the consent box: a profile is saved only with consent.'], [{ formVersion: ' ' }, 'The consent form version is required.'],
    [{ witness: '' }, 'The consent witness is required.'], [{ date: '2026-12-01' }, 'The consent date cannot be in the future.'], [{ date: '28/11/2026' }, 'The consent date must be a date.'],
  ])('refuses %j with one sentence', (over, sentence) => { expect(checkForm({ ...OK, ...over }, TODAY)).toEqual({ error: sentence }); });
});

describe('wearersOf and the messages', () => {
  it('maps a node to the alias of the active firefighter on it, and never to a name', () => {
    const m = wearersOf([row({ node_id: 1 }), row({ firefighter_id: 2, alias: 'FFR-02', node_id: 2, active: false }), row({ firefighter_id: 3, alias: 'FFR-03', node_id: null })]);
    expect(m).toEqual({ 1: 'FFR-01' }); expect(JSON.stringify(m)).not.toContain('Sam');
  });
  it('words every outcome', () => {
    expect(addMessage({ kind: 'ok', body: { firefighter_id: 2, alias: 'FFR-02' } })).toBe('Saved as FFR-02.');
    expect(addMessage({ kind: 'bad', status: 422, detail: 'age_years must be 16 to 80' })).toBe('Not accepted: age_years must be 16 to 80');
    expect(addMessage({ kind: 'conflict', code: 'RECOVERING', retryAfterS: 2.2 })).toBe('The host is recovering. Try again in 3 s.');
    expect(addMessage({ kind: 'retry' })).toContain('Nothing was saved');
    expect(assignMessage({ kind: 'ok', body: { node_id: 1, firefighter_id: 1, alias: 'FFR-01', result: 'assigned' } })).toBe('FFR-01 now wears this jacket.');
    expect(assignMessage({ kind: 'ok', body: { node_id: 1, firefighter_id: null, alias: null, result: 'ended' } })).toBe('Nobody is assigned to this jacket now.');
    expect(assignMessage({ kind: 'conflict', code: 'STATE_CONFLICT' })).toContain('inactive, or already on another jacket');
    expect(assignMessage({ kind: 'gone' })).toContain('no such');
  });
});
