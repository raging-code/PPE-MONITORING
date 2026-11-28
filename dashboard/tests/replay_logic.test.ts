// Requirements: REQ-API-007, REQ-UI-008
// S7-5b (ADR 0062): the replay block in the store, the words of the Pause bar, POST /api/replay/pause, and what the store does with the answer. No DOM.
import { describe, it, expect, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { apply, initialState, type LiveState } from '../src/store/reducer.ts';
import { replayMessage, replayView, speedText } from '../src/alerts/replay.ts';
import { postReplayPause } from '../src/api/actions.ts';
import { setReplayPaused } from '../src/store/replay.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot, tick } from './helpers.ts';

const sys = (seq: number, over: Record<string, unknown> = {}) => ({
  v: 1, type: 'system', srv_seq: seq, srv_ts: 1000 + seq * 1000, base: 'ok', recovering: false, session_id: 4, session_mode: 'REPLAY', rejected_frames: 0, logging_fault: false,
  host_gap: null, host_power: 'ac', audio_fault: false, abi_mismatch: false, banner: null, acknowledged_ts: null, ...over,
});
const RP = { speed: 16, paused: false, finished: false };
const replaySnap = (rp: Record<string, unknown> | null = RP) => snapshot({ session: { session_id: 4, started_ts: 1, mode: 'REPLAY', session_label: null }, replay: rp });
const st = (m: unknown, from: LiveState = initialState('CONNECTING')) => apply(from, m as ServerMessage).state;
const resp = (status: number, body: unknown = {}) => vi.fn(async () => ({ status, json: async () => body }) as unknown as Response);
const apiOf = (f: ReturnType<typeof resp>) => ({ fetchFn: f as unknown as typeof fetch, getToken: () => 'tok' });

describe('the replay block in the store', () => {
  it('starts as null and stays null for a snapshot without the field (an older host)', () => {
    expect(initialState('LIVE').replay).toBeNull();
    expect(st(snapshot()).replay).toBeNull();
  });
  it('the snapshot sets it, and null stays null', () => {
    expect(st(replaySnap()).replay).toEqual(RP);
    expect(st(replaySnap(null)).replay).toBeNull();
  });
  it('a system message replaces it: paused, then resumed, then finished', () => {
    let s = st(replaySnap());
    s = st(sys(1, { replay: { ...RP, paused: true } }), s); expect(s.replay).toEqual({ speed: 16, paused: true, finished: false });
    s = st(sys(2, { replay: RP }), s); expect(s.replay?.paused).toBe(false);
    s = st(sys(3, { replay: { ...RP, finished: true } }), s); expect(s.replay?.finished).toBe(true);
  });
  it('a system message without the field clears it, so a host that is no longer REPLAY shows no bar', () => {
    const s = st(sys(1, { session_mode: 'LIVE' }), st(replaySnap())); expect(s.replay).toBeNull();
  });
  it('a tick leaves it alone, and a gap in srv_seq still asks for a resync', () => {
    const s = st(tick(1), st(replaySnap())); expect(s.replay).toEqual(RP);
    expect(apply(s, sys(5, { replay: RP }) as unknown as ServerMessage).resync).toBe(true);
  });
});

describe('the words of the bar', () => {
  it('is null unless the mode is REPLAY and the host sent the block', () => {
    expect(replayView('LIVE', RP)).toBeNull(); expect(replayView('SIMULATOR', RP)).toBeNull();
    expect(replayView('REPLAY', null)).toBeNull(); expect(replayView('REPLAY', undefined)).toBeNull(); expect(replayView(undefined, RP)).toBeNull();
  });
  it('running: "Replay running, ×16" and the button asks to pause', () => {
    expect(replayView('REPLAY', RP)).toMatchObject({ text: 'Replay running, ×16', buttonLabel: 'Pause replay', paused: false });
  });
  it('paused: "Replay paused, ×N" and the button asks to resume', () => {
    expect(replayView('REPLAY', { ...RP, paused: true })).toMatchObject({ text: 'Replay paused, ×16', buttonLabel: 'Resume replay', paused: true });
  });
  it('finished wins over paused', () => {
    expect(replayView('REPLAY', { speed: 4, paused: true, finished: true })).toMatchObject({ text: 'Replay finished', finished: true });
  });
  it('speeds are written without trailing zeros', () => {
    expect([1, 4, 16, 0.5, 2.25, 1.333333].map(speedText)).toEqual(['×1', '×4', '×16', '×0.5', '×2.25', '×1.33']);
  });
  it('each refusal has its own sentence, and a success has none', () => {
    expect(replayMessage({ kind: 'ok', body: { paused: true, finished: false } })).toBeNull();
    expect(replayMessage({ kind: 'conflict', code: 'RECOVERING' })).toContain('not started');
    expect(replayMessage({ kind: 'conflict', code: 'STATE_CONFLICT' })).toBe('The replay has finished.');
    expect(replayMessage({ kind: 'conflict' })).toBe('The replay has finished.');
    expect(replayMessage({ kind: 'auth' })).toContain('Log in again');
    expect(replayMessage({ kind: 'retry' })).toContain('Try again');
    expect(replayMessage({ kind: 'gone' })).toContain('no replay');
    expect(replayMessage({ kind: 'bad', status: 422, detail: 'x' })).toBe('Not accepted: x');
  });
});

describe('POST /api/replay/pause', () => {
  it('sends {paused} with the bearer token, and nothing else in the body', async () => {
    const f = resp(200, { paused: true, finished: false });
    const r = await postReplayPause(apiOf(f), true);
    expect(r).toEqual({ kind: 'ok', body: { paused: true, finished: false } });
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/replay/pause'); expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ paused: true });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('maps 409 RECOVERING, 409 STATE_CONFLICT, 401 and 422 to outcomes', async () => {
    expect(await postReplayPause(apiOf(resp(409, { error_code: 'RECOVERING', retry_after_s: 2 })), true)).toEqual({ kind: 'conflict', code: 'RECOVERING', retryAfterS: 2 });
    expect(await postReplayPause(apiOf(resp(409, { error_code: 'STATE_CONFLICT' })), false)).toMatchObject({ kind: 'conflict', code: 'STATE_CONFLICT' });
    expect((await postReplayPause(apiOf(resp(401)), true)).kind).toBe('auth');
    expect((await postReplayPause(apiOf(resp(422, { detail: 'bad' })), true)).kind).toBe('bad');
  });
});

describe('setReplayPaused', () => {
  const mk = (over: Partial<LiveState> = {}) => createStore<LiveState>(() => ({ ...st(replaySnap()), ...over }));
  it('takes the host\'s answer into the store at once', async () => {
    const store = mk();
    expect((await setReplayPaused(true, apiOf(resp(200, { paused: true, finished: false })), store)).kind).toBe('ok');
    expect(store.getState().replay).toEqual({ speed: 16, paused: true, finished: false });
  });
  it('keeps the speed, and takes finished from the answer', async () => {
    const store = mk({ replay: { speed: 4, paused: false, finished: false } });
    await setReplayPaused(false, apiOf(resp(200, { paused: false, finished: true })), store);
    expect(store.getState().replay).toEqual({ speed: 4, paused: false, finished: true });
  });
  it('a refusal or a failure changes nothing', async () => {
    for (const f of [resp(409, { error_code: 'STATE_CONFLICT' }), resp(401), resp(503), vi.fn(async () => { throw new Error('net'); })]) {
      const store = mk(); await setReplayPaused(true, apiOf(f as ReturnType<typeof resp>), store); expect(store.getState().replay).toEqual(RP);
    }
  });
  it('with no replay block an answer creates none', async () => {
    const store = mk({ replay: null }); await setReplayPaused(true, apiOf(resp(200, { paused: true, finished: false })), store); expect(store.getState().replay).toBeNull();
  });
});
