// P22d-2: the pure rules and the paging of the event log (3.11, 3.8). Page sizes here are test values.
import { describe, it, expect, beforeEach } from 'vitest';
import { mergeRows, rejectedText, rowText } from '../src/alerts/eventlog.ts';
import { logStore, refreshLog, resetLog } from '../src/store/eventlog.ts';
import type { LogRow } from '../src/api/events.ts';
import type { NodeSnap } from '../src/gen/ws.ts';

const R = (seq: number, o: Partial<LogRow> = {}): LogRow => ({ event_seq: seq, log_ts: 1000 + seq, record_type: 'system', node_id: null, level: null, code: 'HOST_START', detail: null, operator_id: null, ...o });
const nodes = { 1: { alias: 'FF-01' } } as unknown as Record<number, NodeSnap>;

describe('merge', () => {
  it('keeps strict event_seq order, adds no duplicate, and keeps rows that share one event_seq', () => {
    const a = R(5), b = R(5, { record_type: 'audit', code: 'ACK_ALERT', node_id: 1 }), c = R(3);
    const m = mergeRows([a], [c, b, a]); expect(m.map((r) => r.event_seq)).toEqual([3, 5, 5]); expect(mergeRows(m, m)).toHaveLength(3);
  });
  it('keeps only the newest rows', () => { expect(mergeRows([], [R(1), R(2), R(3), R(4)], 2).map((r) => r.event_seq)).toEqual([3, 4]); });
});

describe('words', () => {
  it('say alerts, operator actions and system events in plain text', () => {
    expect(rowText(R(1, { record_type: 'alert_raised', node_id: 1, level: 'DANGER', code: 'man_down' }), nodes)).toBe('FF-01 Man down DANGER raised');
    expect(rowText(R(2, { record_type: 'alert_cleared', node_id: 1, level: 'WARNING', code: 'co_threshold', operator_id: 3 }), nodes)).toBe('FF-01 Co threshold WARNING cleared (operator 3)');
    expect(rowText(R(3, { record_type: 'alert_raised', node_id: 1, level: 'NONE', code: 'wrist_open' }), nodes)).toBe('FF-01 Wrist open raised');
    expect(rowText(R(4, { record_type: 'audit', code: 'ACK_ALERT', node_id: 1, operator_id: 2 }), nodes)).toBe('Ack alert FF-01 (operator 2)');
    expect(rowText(R(5, { code: 'BASE_OFFLINE', detail: 'no beacon' }), nodes)).toBe('Base offline: no beacon');
    expect(rowText(R(6, { record_type: 'advisory', node_id: 1, code: 'NOMINAL', detail: 'ok -> none' }), nodes)).toBe('Advisory FF-01, Nominal: ok -> none');
  });
  it('the rejected-frames line is one count with the "check key" message', () => {
    expect(rejectedText(1)).toBe('1 frame rejected (authentication): check key'); expect(rejectedText(7)).toBe('7 frames rejected (authentication): check key');
  });
});

describe('refreshLog', () => {
  beforeEach(resetLog);
  const host = (all: LogRow[], calls: string[] = []) => ({ getToken: () => 't', fetchFn: (async (url: string) => {
    calls.push(url); const after = Number(new URL(url, 'http://h').searchParams.get('after_seq')), lim = Number(new URL(url, 'http://h').searchParams.get('limit'));
    const events = all.filter((r) => r.event_seq > after).slice(0, lim);
    return { status: 200, json: async () => ({ events, last_seq: events.length ? events[events.length - 1].event_seq : after }) };
  }) as unknown as typeof fetch });
  it('pages forward until a short page, then later calls ask only after the last sequence number', async () => {
    const calls: string[] = [], all = [R(1), R(2), R(3), R(4), R(5)], api = host(all, calls);
    await refreshLog(api, 2);
    expect(calls).toEqual(['/api/events?after_seq=0&limit=2', '/api/events?after_seq=2&limit=2', '/api/events?after_seq=4&limit=2']);
    expect(logStore.getState().rows.map((r) => r.event_seq)).toEqual([1, 2, 3, 4, 5]); expect(logStore.getState().lastSeq).toBe(5);
    all.push(R(6)); await refreshLog(api, 2); expect(calls[calls.length - 1]).toBe('/api/events?after_seq=5&limit=2'); expect(logStore.getState().rows).toHaveLength(6);
  });
  it('a failed call keeps the rows already shown and reports failed; the next call recovers', async () => {
    const api = host([R(1)]); await refreshLog(api, 5);
    await refreshLog({ getToken: () => 't', fetchFn: (async () => { throw new Error('down'); }) as unknown as typeof fetch }, 5);
    expect(logStore.getState().status).toBe('failed'); expect(logStore.getState().rows).toHaveLength(1);
    await refreshLog(api, 5); expect(logStore.getState().status).toBe('ok');
  });
  it('sends the token on every call', async () => {
    const seen: unknown[] = []; await refreshLog({ getToken: () => 'tok', fetchFn: (async (_u: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>).Authorization); return { status: 200, json: async () => ({ events: [], last_seq: 0 }) }; }) as unknown as typeof fetch });
    expect(seen).toEqual(['Bearer tok']);
  });
});
