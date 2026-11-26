import { describe, it, expect, beforeEach } from 'vitest';
import { ackTargets, overlayAcks, pendingIds, pruneAcks, resolvable } from '../src/alerts/ack.ts';
import type { Card } from '../src/alerts/group.ts';
import { resolveMessage, type ActionResult, type ResolveBody } from '../src/api/actions.ts';
import { acksStore, createActions } from '../src/store/actions.ts';
import type { AlertBody, EpisodeBody } from '../src/gen/ws.ts';
import { FakeTimers } from './helpers.ts';

const al = (id: number, over: Partial<AlertBody> = {}): AlertBody => ({
  alert_id: id, node_id: 1, alert_type: 'heat', level: 'WARNING', reasons: null, authenticated: 1, episode_id: null, raised_ts: 1000 + id,
  cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
const line = (a: AlertBody, ids = [a.alert_id]) => ({ alert: a, ids, count: ids.length, cleared: a.cleared_ts !== null });
const card = (...lines: ReturnType<typeof line>[]): Card => ({ key: 'n1', kind: 'responder', node_id: 1, level: 'DANGER', lines, raised_ts: 1, sig: 'x' });
const ep = (id: number, state: EpisodeBody['state']): EpisodeBody => ({ episode_id: id, node_id: 1, kind: 'MAN_DOWN', state, man_down_motion_state: null, resolve_reason: null, operator: null });

describe('ack rules', () => {
  it('an episode line goes through the episode call; other lines one by one; acknowledged lines are skipped', () => {
    const t = ackTargets(card(line(al(1, { alert_type: 'man_down', episode_id: 3 })), line(al(2, { cleared_ts: 1100 })), line(al(3), [3, 4]), line(al(9, { acknowledged_ts: 1200 }))));
    expect(t.episodes).toEqual([{ id: 3, alertIds: [1] }]);
    expect(t.alerts).toEqual([2, 3, 4]); // the cleared line is included: the host accepts it
  });
  it('an unconfirmed ack counts as acknowledged on screen; the host value wins once it arrives', () => {
    const out = overlayAcks([al(1), al(2, { acknowledged_ts: 5 })], { 1: { ts: 77, confirmed: false }, 2: { ts: 99, confirmed: false } });
    expect(out.map((a) => a.acknowledged_ts)).toEqual([77, 5]);
    expect([...pendingIds({ 1: { ts: 1, confirmed: false }, 2: { ts: 1, confirmed: true } })]).toEqual([1]);
  });
  it('an entry is pruned when the host shows the acknowledgement or the alert is gone', () => {
    const acks = { 1: { ts: 1, confirmed: true }, 2: { ts: 1, confirmed: false }, 3: { ts: 1, confirmed: false } };
    expect(pruneAcks(acks, { 1: al(1, { acknowledged_ts: 9 }), 2: al(2) })).toEqual({ 2: acks[2] });
    expect(pruneAcks({ 2: acks[2] }, { 2: al(2) })).toEqual({ 2: acks[2] });
  });
  it('Resolve is offered only for an episode the host has acknowledged', () => {
    const c = card(line(al(1, { alert_type: 'man_down', episode_id: 3 })));
    expect(resolvable(c, { 3: ep(3, 'OPEN') })).toEqual([]);
    expect(resolvable(c, { 3: ep(3, 'ACKNOWLEDGED') }).map((e) => e.episode_id)).toEqual([3]);
  });
  it('the Resolve message says the latch stays set', () => {
    const ok = (latch: boolean): ActionResult<ResolveBody> => ({ kind: 'ok', body: { resolved_ts: 1, resolve_reason: 'rescued', latch_still_set: latch } });
    expect(resolveMessage(ok(true))).toContain('CANCEL');
    expect(resolveMessage(ok(false))).toBe('Resolved.');
    expect(resolveMessage({ kind: 'conflict' })).toBe('Already resolved.');
  });
});

type Reply = { status: number; body?: unknown } | 'down';
function setup(replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [], timers = new FakeTimers();
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 200, body: { acknowledged_ts: 5000 } };
    if (r === 'down') throw new TypeError('network');
    return { status: r.status, json: async () => r.body ?? {} } as Response;
  }) as unknown as typeof fetch;
  const actions = createActions({ fetchFn, getToken: () => 'tok', timers, retryMs: 1000, now: () => 42 });
  return { calls, timers, actions };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => acksStore.setState({ acks: {} }));

describe('Acknowledge runner', () => {
  it('silences at once, sends the Bearer token, then confirms with the host time', async () => {
    const { calls, actions } = setup([{ status: 200, body: { acknowledged_ts: 5000 } }]);
    actions.acknowledge({ episodes: [], alerts: [7] });
    expect(acksStore.getState().acks[7]).toEqual({ ts: 42, confirmed: false }); // before any answer
    await flush();
    expect(calls[0].url).toBe('/api/alerts/7/ack');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(acksStore.getState().acks[7]).toEqual({ ts: 5000, confirmed: true });
  });
  it('a failed call is retried and never un-silences the card', async () => {
    const { calls, timers, actions } = setup(['down', { status: 503 }, { status: 200, body: { acknowledged_ts: 6000 } }]);
    actions.acknowledge({ episodes: [], alerts: [7] });
    await flush();
    expect(acksStore.getState().acks[7].confirmed).toBe(false);
    timers.tick(1000); await flush();
    expect(calls).toHaveLength(2); expect(acksStore.getState().acks[7]).toBeDefined();
    timers.tick(1000); await flush();
    expect(calls).toHaveLength(3); expect(acksStore.getState().acks[7]).toEqual({ ts: 6000, confirmed: true });
  });
  it('a refused token stops the retries but the card stays silenced', async () => {
    const { calls, timers, actions } = setup([{ status: 401 }]);
    actions.acknowledge({ episodes: [], alerts: [7] });
    await flush(); timers.tick(5000); await flush();
    expect(calls).toHaveLength(1); expect(acksStore.getState().acks[7].confirmed).toBe(false);
  });
  it('an episode is acknowledged through its own call; a resolved episode (409) falls back to its alerts', async () => {
    const { calls, actions } = setup([{ status: 409 }, { status: 200, body: { acknowledged_ts: 7000 } }]);
    actions.acknowledge({ episodes: [{ id: 3, alertIds: [11] }], alerts: [] });
    await flush(); await flush();
    expect(calls.map((c) => c.url)).toEqual(['/api/episodes/3/ack', '/api/alerts/11/ack']);
    expect(acksStore.getState().acks[11]).toEqual({ ts: 7000, confirmed: true });
  });
  it('Resolve posts the reason once and does not retry', async () => {
    const { calls, timers, actions } = setup([{ status: 200, body: { resolved_ts: 9, resolve_reason: 'rescued', latch_still_set: true } }, 'down']);
    const r = await actions.resolve(3, 'rescued');
    expect(r.kind).toBe('ok'); expect(calls[0].url).toBe('/api/episodes/3/resolve'); expect(calls[0].init.body).toBe('{"reason":"rescued"}');
    expect((await actions.resolve(3, 'rescued')).kind).toBe('retry'); timers.tick(5000); await flush();
    expect(calls).toHaveLength(2);
  });
});
