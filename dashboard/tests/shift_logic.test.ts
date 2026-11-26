import { describe, it, expect } from 'vitest';
import { buildSummary, durationText, manilaStamp, modeWord, nothingOpen, openItems, sessionLine } from '../src/alerts/shift.ts';
import { downloadCsv, endMessage, getSessions, postSessionEnd, type SessionRow } from '../src/api/shift.ts';
import type { AlertBody, EpisodeBody, NodeSnap, RosterRow } from '../src/gen/ws.ts';

const row = (o: Partial<SessionRow> = {}): SessionRow => ({ session_id: 4, started_ts: Date.UTC(2026, 10, 26, 16, 5), ended_ts: Date.UTC(2026, 10, 27, 0, 10), duration_s: 29100, mode: 'LIVE', session_label: 'shift-1', end_kind: 'ENDED', alert_count: 6, unresolved_episodes: 1, highest_level_by_node: { '1': 'DANGER', '2': 'WARNING' }, ...o });
const node = (id: number, o: Partial<NodeSnap> = {}) => ({ node_id: id, alias: `FF-0${id}`, mandown: 0, ...o }) as NodeSnap;
const alert = (id: number, o: Partial<AlertBody> = {}) => ({ alert_id: id, node_id: 1, alert_type: 'man_down', level: 'DANGER', reasons: null, authenticated: 1, episode_id: null, raised_ts: 1, cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...o }) as unknown as AlertBody;
const ep = (id: number, state: EpisodeBody['state'], kind: EpisodeBody['kind'] = 'MAN_DOWN') => ({ episode_id: id, node_id: 1, kind, state, man_down_motion_state: null, resolve_reason: null, operator: null }) as EpisodeBody;
const fake = (status: number, body: unknown = {}) => { const calls: { url: string; init: RequestInit }[] = []; return { calls, api: { fetchFn: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { status, json: async () => body, blob: async () => new Blob(['a,b']) } as unknown as Response; }) as unknown as typeof fetch, getToken: () => 'tok' } }; };

describe('time and length text', () => {
  it('shows Manila 24-hour time, and midnight as 00:05 not 24:05', () => {
    expect(manilaStamp(Date.UTC(2026, 10, 26, 16, 5))).toBe('27/11/2026 00:05');
    expect(manilaStamp(Date.UTC(2026, 10, 26, 3, 30))).toBe('26/11/2026 11:30');
  });
  it('length: seconds, minutes, hours', () => {
    expect(durationText(45)).toBe('45 s'); expect(durationText(125)).toBe('2 min 05 s'); expect(durationText(29100)).toBe('8 h 05 min'); expect(durationText(-3)).toBe('0 s');
  });
});
describe('Sessions list rows', () => {
  it('date, length, mode and alert count, with the label and the unresolved count as notes', () => {
    expect(sessionLine(row())).toEqual({ id: 4, date: '27/11/2026 00:05', length: '8 h 05 min', mode: 'LIVE', alerts: 6, notes: 'shift-1; 1 unresolved' });
  });
  it('the open session is marked running; other modes are never shown as LIVE', () => {
    expect(sessionLine(row({ ended_ts: null, end_kind: null, mode: 'SIMULATOR', unresolved_episodes: 0, session_label: null })).length).toContain('(running)');
    expect(modeWord('SIMULATOR')).toBe('TEST: simulator'); expect(modeWord('REPLAY')).toBe('REPLAY');
    expect(sessionLine(row({ end_kind: 'ABANDONED' })).notes).toContain('Host stopped without ending the shift');
  });
});
describe('End shift open items (3.7)', () => {
  const nodes = { 1: node(1, { mandown: 1 }), 2: node(2) };
  it('lists open alerts, open episodes and latched nodes; a cleared alert and a resolved episode are not open', () => {
    const o = openItems({ 1: alert(1), 2: alert(2, { alert_type: 'heat', level: 'WARNING', node_id: 2, acknowledged_ts: 5 }), 3: alert(3, { cleared_ts: 9 }) }, { 3: ep(3, 'ACKNOWLEDGED'), 4: ep(4, 'RESOLVED'), 5: ep(5, 'OPEN', 'MAYDAY') }, nodes);
    expect(o.alerts).toHaveLength(2); expect(o.alerts[0]).toContain('DANGER, not acknowledged'); expect(o.alerts[1]).toContain('WARNING, acknowledged');
    expect(o.episodes).toEqual(['FF-01: man-down, episode 3, acknowledged, not resolved', 'FF-01: MAYDAY, episode 5, not acknowledged']);
    expect(o.latched).toEqual(['FF-01: jacket latched (only the CANCEL button on the jacket clears it)']);
    expect(nothingOpen(o)).toBe(false);
  });
  it('nothing open is said as such', () => { expect(nothingOpen(openItems({}, {}, { 2: node(2) }))).toBe(true); });
});
describe('summary after End shift (3.10)', () => {
  const roster: RosterRow[] = [{ node_id: 1, alias: 'FF-01', active: 1 }, { node_id: 2, alias: 'FF-02', active: 1 }, { node_id: 3, alias: 'FF-03', active: 1 }];
  it('duration, alerts, unresolved, backup and the highest level of every rostered responder', () => {
    expect(buildSummary(row(), true, roster)).toEqual({ sessionId: 4, duration: '8 h 05 min', alerts: 6, unresolved: 1, backup: 'Backup saved', backupOk: true,
      perNode: [{ alias: 'FF-01', level: 'DANGER' }, { alias: 'FF-02', level: 'WARNING' }, { alias: 'FF-03', level: null }] });
  });
  it('a failed backup is never worded as success', () => { expect(buildSummary(row(), false, roster).backup).toContain('FAILED'); });
});
describe('End shift and Sessions REST', () => {
  it('GET /api/sessions sends the token and no body', async () => {
    const f = fake(200, [row()]); const r = await getSessions(f.api, 10);
    expect(r.kind).toBe('ok'); expect(f.calls[0].url).toBe('/api/sessions?limit=10');
    expect(f.calls[0].init.method).toBe('GET'); expect(f.calls[0].init.body).toBeUndefined(); expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('End shift sends the frozen body with the session id', async () => {
    const f = fake(200, { closed_session_id: 4, new_session_id: 5, backup_ok: true }); await postSessionEnd(f.api, 4);
    expect(f.calls[0].url).toBe('/api/session/end'); expect(f.calls[0].init.body).toBe('{"confirm_text":"END","session_id":4}');
  });
  it('409 RECOVERING keeps its wait, STATE_CONFLICT is another screen, and every failure has words', async () => {
    const rec = await postSessionEnd(fake(409, { error_code: 'RECOVERING', detail: 'x', retry_after_s: 4.2 }).api, 4);
    expect(rec).toEqual({ kind: 'conflict', code: 'RECOVERING', retryAfterS: 4.2 }); expect(endMessage(rec)).toBe('The host is recovering. Try again in 5 s.');
    expect(endMessage(await postSessionEnd(fake(409, { error_code: 'STATE_CONFLICT', detail: 'x', retry_after_s: null }).api, 4))).toBe('The shift was already ended from another screen.');
    expect(endMessage(await postSessionEnd(fake(400, { detail: 'bad' }).api, 4))).toBe('Not accepted: bad');
    expect(endMessage(await postSessionEnd(fake(401, {}).api, 4))).toBe('Not signed in. Log in again.');
    expect(endMessage(await postSessionEnd(fake(500, {}).api, 4))).toBe('The host did not answer. Try again.');
    expect(endMessage({ kind: 'ok', body: { closed_session_id: 1, new_session_id: 2, backup_ok: true } })).toBeNull();
  });
  it('CSV: an authenticated GET, then a blob saved as session-N.csv and the object URL released', async () => {
    const f = fake(200); const log: string[] = [];
    const r = await downloadCsv(f.api, 4, { createObjectURL: () => 'blob:1', revokeObjectURL: (u) => log.push('revoke ' + u), click: (u, n) => log.push(`click ${u} ${n}`) });
    expect(r).toBe('saved'); expect(f.calls[0].url).toBe('/api/export.csv?session_id=4'); expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(log).toEqual(['click blob:1 session-4.csv', 'revoke blob:1']);
  });
  it('CSV failures save nothing', async () => {
    const log: string[] = [], deps = { createObjectURL: () => 'x', revokeObjectURL: () => log.push('r'), click: () => log.push('c') };
    expect(await downloadCsv(fake(401).api, 4, deps)).toBe('auth'); expect(await downloadCsv(fake(500).api, 4, deps)).toBe('failed'); expect(log).toEqual([]);
  });
});
