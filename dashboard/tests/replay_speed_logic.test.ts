// Requirements: REQ-API-007, REQ-UI-008
// S7-7b (ADR 0065): the speed choices, their words, POST /api/replay/speed, and what the store does with the answer. No DOM.
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { apply, initialState, type LiveState } from '../src/store/reducer.ts';
import { REPLAY_SPEEDS, replayMessage, replayView, speedChoices } from '../src/alerts/replay.ts';
import { postReplaySpeed } from '../src/api/actions.ts';
import { setReplaySpeed } from '../src/store/replay.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot } from './helpers.ts';

const RP = { speed: 16, paused: false, finished: false };
const replaySnap = (rp: Record<string, unknown> | null = RP) => snapshot({ session: { session_id: 4, started_ts: 1, mode: 'REPLAY', session_label: null }, replay: rp });
const st = (m: unknown) => apply(initialState('CONNECTING'), m as ServerMessage).state;
const resp = (status: number, body: unknown = {}) => vi.fn(async () => ({ status, json: async () => body }) as unknown as Response);
const apiOf = (f: ReturnType<typeof resp>) => ({ fetchFn: f as unknown as typeof fetch, getToken: () => 'tok' });

describe('the speeds', () => {
  it('are the host\'s SPEEDS, read from the host source, in the same order', () => {
    const src = readFileSync(new URL('../../host/ppe_host/services/replay.py', import.meta.url), 'utf8');
    const m = /^SPEEDS = \(([\d,\s]+)\)/m.exec(src);
    expect(m).not.toBeNull();
    expect([...REPLAY_SPEEDS]).toEqual(m![1].split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n)));
  });
  it('are 1, 4 and 16', () => { expect([...REPLAY_SPEEDS]).toEqual([1, 4, 16]); });
});

describe('speedChoices', () => {
  it('lists one choice per speed in order with the host\'s one selected', () => {
    expect(speedChoices(4)).toEqual([
      { speed: 1, label: '×1', name: 'Speed ×1', selected: false },
      { speed: 4, label: '×4', name: 'Speed ×4', selected: true },
      { speed: 16, label: '×16', name: 'Speed ×16', selected: false },
    ]);
  });
  it('selects nothing for a speed the dashboard does not offer (an older or different host)', () => {
    expect(speedChoices(2).some((c) => c.selected)).toBe(false);
    expect(speedChoices(2)).toHaveLength(3);
  });
  it('exactly one is selected for each offered speed', () => {
    for (const s of REPLAY_SPEEDS) expect(speedChoices(s).filter((c) => c.selected).map((c) => c.speed)).toEqual([s]);
  });
  it('replayView carries them, and is still null off REPLAY', () => {
    expect(replayView('REPLAY', RP)?.choices.find((c) => c.selected)?.speed).toBe(16);
    expect(replayView('REPLAY', { ...RP, speed: 1, paused: true })?.choices.find((c) => c.selected)?.speed).toBe(1);
    expect(replayView('LIVE', RP)).toBeNull();
  });
});

describe('the words for a speed press', () => {
  it('a 404 says the host cannot change the speed, and still says no replay to pause for Pause', () => {
    expect(replayMessage({ kind: 'gone' }, 'speed')).toBe('This host cannot change the replay speed.');
    expect(replayMessage({ kind: 'gone' })).toBe('The host has no replay to pause.');
    expect(replayMessage({ kind: 'gone' }, 'pause')).toBe('The host has no replay to pause.');
  });
  it('the other outcomes read the same for both', () => {
    expect(replayMessage({ kind: 'ok', body: {} }, 'speed')).toBeNull();
    expect(replayMessage({ kind: 'conflict', code: 'RECOVERING' }, 'speed')).toContain('not started');
    expect(replayMessage({ kind: 'conflict', code: 'STATE_CONFLICT' }, 'speed')).toBe('The replay has finished.');
    expect(replayMessage({ kind: 'auth' }, 'speed')).toContain('Log in again');
    expect(replayMessage({ kind: 'retry' }, 'speed')).toContain('Try again');
    expect(replayMessage({ kind: 'bad', status: 422, detail: 'x' }, 'speed')).toBe('Not accepted: x');
  });
});

describe('POST /api/replay/speed', () => {
  it('sends {speed} with the bearer token and nothing else', async () => {
    const f = resp(200, { speed: 4, paused: false, finished: false });
    const r = await postReplaySpeed(apiOf(f), 4);
    expect(r).toEqual({ kind: 'ok', body: { speed: 4, paused: false, finished: false } });
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/replay/speed'); expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ speed: 4 });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('maps 409 RECOVERING, 409 STATE_CONFLICT, 401, 404 and 422 to outcomes', async () => {
    expect(await postReplaySpeed(apiOf(resp(409, { error_code: 'RECOVERING', retry_after_s: 2 })), 4)).toEqual({ kind: 'conflict', code: 'RECOVERING', retryAfterS: 2 });
    expect(await postReplaySpeed(apiOf(resp(409, { error_code: 'STATE_CONFLICT' })), 4)).toMatchObject({ kind: 'conflict', code: 'STATE_CONFLICT' });
    expect((await postReplaySpeed(apiOf(resp(401)), 4)).kind).toBe('auth');
    expect((await postReplaySpeed(apiOf(resp(404)), 4)).kind).toBe('gone');
    expect((await postReplaySpeed(apiOf(resp(422, { detail: 'bad' })), 4)).kind).toBe('bad');
  });
});

describe('setReplaySpeed', () => {
  const mk = (over: Partial<LiveState> = {}) => createStore<LiveState>(() => ({ ...st(replaySnap()), ...over }));
  it('takes the host\'s answer into the store at once', async () => {
    const store = mk();
    expect((await setReplaySpeed(4, apiOf(resp(200, { speed: 4, paused: false, finished: false })), store)).kind).toBe('ok');
    expect(store.getState().replay).toEqual({ speed: 4, paused: false, finished: false });
  });
  it('keeps a pause: a speed chosen while paused leaves it paused', async () => {
    const store = mk({ replay: { speed: 16, paused: true, finished: false } });
    await setReplaySpeed(1, apiOf(resp(200, { speed: 1, paused: true, finished: false })), store);
    expect(store.getState().replay).toEqual({ speed: 1, paused: true, finished: false });
  });
  it('takes finished from the answer', async () => {
    const store = mk(); await setReplaySpeed(4, apiOf(resp(200, { speed: 4, paused: false, finished: true })), store);
    expect(store.getState().replay).toEqual({ speed: 4, paused: false, finished: true });
  });
  it('a refusal or a failure changes nothing', async () => {
    for (const f of [resp(409, { error_code: 'STATE_CONFLICT' }), resp(409, { error_code: 'RECOVERING' }), resp(401), resp(404), resp(422), resp(503), vi.fn(async () => { throw new Error('net'); })]) {
      const store = mk(); await setReplaySpeed(4, apiOf(f as ReturnType<typeof resp>), store); expect(store.getState().replay).toEqual(RP);
    }
  });
  it('with no replay block an answer creates none', async () => {
    const store = mk({ replay: null }); await setReplaySpeed(4, apiOf(resp(200, { speed: 4, paused: false, finished: false })), store); expect(store.getState().replay).toBeNull();
  });
});
