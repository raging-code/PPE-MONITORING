// Requirements: REQ-API-002
// ADR 0072 (S8-3b): the jacket check before Start monitoring and the set-inactive message. Pure logic, no browser.
import { describe, it, expect, beforeEach } from 'vitest';
import { activeMessage, type ActiveBody } from '../src/api/firefighters.ts';
import type { ActionResult } from '../src/api/actions.ts';
import { confirmWearers, optionsFor, planConfirm, resetWearers, setWearers, sigOf, startBlocked, wearerStore, type Person } from '../src/store/wearers.ts';

const P = (id: number, node: number | null): Person => ({ firefighter_id: id, alias: `FFR-0${id}`, node_id: node });
const row = (id: number, node: number | null, active = true) => ({ firefighter_id: id, alias: `FFR-0${id}`, full_name: 'Name Hidden', sex: null, age_years: 30, height_cm: 170, weight_kg: 70, resting_hr: 60, max_hr: null, smoker: false, years_service: null, consent_ts: 1, consent_form_version: 'v1', active, node_id: node });
beforeEach(() => resetWearers());

describe('startBlocked', () => {
  it('never blocks before the list is known or when there are no active firefighters', () => {
    expect(startBlocked(wearerStore.getState())).toBe(false);
    setWearers([]); expect(startBlocked(wearerStore.getState())).toBe(false);
    setWearers([row(1, null, false)]); expect(startBlocked(wearerStore.getState())).toBe(false);
  });
  it('blocks while there are active firefighters and nothing is confirmed, then lets go on confirm', () => {
    setWearers([row(1, 1), row(2, null)]); expect(startBlocked(wearerStore.getState())).toBe(true);
    confirmWearers(); expect(startBlocked(wearerStore.getState())).toBe(false);
  });
  it('a change by anyone after the confirmation blocks again, and putting it back lets go', () => {
    setWearers([row(1, 1), row(2, null)]); confirmWearers();
    setWearers([row(1, null), row(2, 1)]); expect(startBlocked(wearerStore.getState())).toBe(true);
    setWearers([row(1, 1), row(2, null)]); expect(startBlocked(wearerStore.getState())).toBe(false);
  });
  it('confirming that nobody wears a jacket counts as confirmed', () => {
    setWearers([row(1, null)]); expect(startBlocked(wearerStore.getState())).toBe(true); confirmWearers(); expect(startBlocked(wearerStore.getState())).toBe(false);
  });
  it('the store keeps the alias only, never a name, and ignores inactive people', () => {
    setWearers([row(1, 1), row(2, null, false)]); const s = wearerStore.getState();
    expect(s.people).toEqual([{ firefighter_id: 1, alias: 'FFR-01', node_id: 1 }]); expect(JSON.stringify(s)).not.toContain('Name Hidden'); expect(s.byNode).toEqual({ 1: 'FFR-01' });
  });
  it('resetWearers (Log out) forgets the list and the confirmation', () => {
    setWearers([row(1, 1)]); confirmWearers(); resetWearers(); expect(wearerStore.getState()).toMatchObject({ people: null, confirmedSig: null });
  });
  it('sigOf ignores people who wear nothing and the order', () => { expect(sigOf([P(2, 2), P(1, 1), P(3, null)])).toBe('1:1,2:2'); expect(sigOf([P(1, null)])).toBe(''); });
});

describe('planConfirm', () => {
  it('sends nothing when the picks are what the host already has', () => { expect(planConfirm([1, 2], [P(1, 1), P(2, 2)], {})).toEqual([]); expect(planConfirm([1, 2], [P(1, 1)], { 1: '1', 2: '' })).toEqual([]); });
  it('puts a free person on a node', () => { expect(planConfirm([1], [P(1, null)], { 1: '1' })).toEqual([{ node_id: 1, firefighter_id: 1 }]); });
  it('"Nobody" ends the jacket', () => { expect(planConfirm([1], [P(1, 1)], { 1: '' })).toEqual([{ node_id: 1, firefighter_id: null }]); });
  it('a swap ends both jackets first and then puts the people on, so the host never sees two jackets for one person', () => {
    expect(planConfirm([1, 2], [P(1, 1), P(2, 2)], { 1: '2', 2: '1' })).toEqual([{ node_id: 1, firefighter_id: null }, { node_id: 2, firefighter_id: null }, { node_id: 1, firefighter_id: 2 }, { node_id: 2, firefighter_id: 1 }]);
  });
  it('replacing the wearer of one node ends it and puts the new person on', () => {
    expect(planConfirm([1], [P(1, 1), P(2, null)], { 1: '2' })).toEqual([{ node_id: 1, firefighter_id: null }, { node_id: 1, firefighter_id: 2 }]);
  });
  it('refuses one person on two nodes', () => { expect(planConfirm([1, 2], [P(1, null)], { 1: '1', 2: '1' })).toBeNull(); });
});

describe('optionsFor', () => {
  const people = [P(1, 1), P(2, null), P(3, 2)];
  it('offers the free, this node\'s own and nobody else\'s', () => { expect(optionsFor(1, [1, 2], people, {}).map((p) => p.firefighter_id)).toEqual([1, 2]); });
  it('offers a person whose node is being given up, and hides one picked on another node', () => {
    expect(optionsFor(1, [1, 2], people, { 2: '' }).map((p) => p.firefighter_id)).toEqual([1, 2, 3]);
    expect(optionsFor(1, [1, 2], people, { 2: '2', 1: '' }).map((p) => p.firefighter_id)).toEqual([1, 3]);
  });
});

describe('activeMessage', () => {
  const ok = (active: boolean, result: ActiveBody['result']): ActionResult<ActiveBody> => ({ kind: 'ok', body: { firefighter_id: 1, alias: 'FFR-01', active, result } }) as ActionResult<ActiveBody>;
  it('says what happened and carries only the alias', () => {
    expect(activeMessage(ok(false, 'changed'), 'FFR-01')).toBe('FFR-01 is inactive now and no longer wears a jacket.');
    expect(activeMessage(ok(true, 'changed'), 'FFR-01')).toBe('FFR-01 is active again.');
    expect(activeMessage(ok(true, 'unchanged'), 'FFR-01')).toBe('No change.');
  });
  it('has a sentence for every refusal', () => {
    expect(activeMessage({ kind: 'conflict', code: 'RECOVERING', retryAfterS: 3 } as ActionResult<ActiveBody>, 'FFR-01')).toBe('The host is recovering. Try again in 3 s.');
    expect(activeMessage({ kind: 'auth' } as ActionResult<ActiveBody>, 'FFR-01')).toContain('Log in again');
    expect(activeMessage({ kind: 'retry' } as ActionResult<ActiveBody>, 'FFR-01')).toContain('Nothing was changed');
    expect(activeMessage({ kind: 'gone' } as ActionResult<ActiveBody>, 'FFR-01')).toContain('does not know');
  });
});
