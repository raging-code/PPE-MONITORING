// Requirements: REQ-API-007, REQ-UI-008
import { describe, it, expect, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ACKABLE, bannersFor, modeText, parseHostPower } from '../src/alerts/banners.ts';
import { entryFor } from '../src/alerts/catalog.ts';
import { ackBanner, ackMessage } from '../src/store/banners.ts';
import { initialState, type LiveState } from '../src/store/reducer.ts';
import type { Banners } from '../src/gen/ws.ts';

const B = (o: Partial<Banners> = {}): Banners => ({ base_offline: false, logging_fault: false, host_gap: null, host_power: 'ok', audio_fault: false, abi_mismatch: false, ...o });
const show = (banners: Banners | null, o: { recovering?: boolean; ack?: Record<string, number> } = {}) => bannersFor({ recovering: o.recovering ?? false, banners, bannerAck: o.ack ?? {} });

describe('system banners map to the catalog text (3.4, 3.7)', () => {
  it('shows nothing when the host reports no condition, and before the first snapshot', () => {
    expect(show(B())).toEqual([]); expect(show(null)).toEqual([]);
  });
  it('BASE OFFLINE, LOGGING FAULT and AUDIO FAULT use the catalog wording', () => {
    const r = show(B({ base_offline: true, logging_fault: true, audio_fault: true }));
    expect(r.map((b) => b.text)).toEqual([entryFor('base_offline')!.text, entryFor('logging_fault')!.text, entryFor('audio_fault')!.text]);
    expect(r.map((b) => b.level)).toEqual(['DANGER', 'WARNING', 'WARNING']);
  });
  it('RECOVERING comes from the recovering flag and has no level colour', () => {
    const r = show(B(), { recovering: true }); expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'recovering', text: 'RECOVERING: rebuilding state', level: 'NONE' });
  });
  it('the danger banner is first whatever else is showing', () => {
    expect(show(B({ audio_fault: true, logging_fault: true, base_offline: true }), { recovering: true })[0].kind).toBe('base_offline');
  });
  it('HOST GAP shows the gap seconds, adds the db_restored line, and is gone once acknowledged', () => {
    expect(show(B({ host_gap: { gap_s: 7, reason: null } }))[0].text).toBe('MONITORING GAP 7 s: responders were not monitored');
    expect(show(B({ host_gap: { gap_s: 7, reason: 'db_restored' } }))[0].text).toMatch(/Database restored from a backup\.$/);
    expect(show(B({ host_gap: { gap_s: 7, reason: null } }), { ack: { host_gap: 1 } })).toEqual([]);
  });
  it('LOGGING FAULT stays on screen after Acknowledge while the fault lasts (3.7)', () => {
    const r = show(B({ logging_fault: true }), { ack: { logging_fault: 5 } });
    expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ ackable: true, acked: true });
    expect(show(B({ logging_fault: false }), { ack: { logging_fault: 5 } })).toEqual([]);
  });
  it('only host_gap and logging_fault can be acknowledged', () => {
    expect([...ACKABLE].sort()).toEqual(['host_gap', 'logging_fault']);
    const r = show(B({ base_offline: true, audio_fault: true, host_power: 'battery 28' }), { recovering: true });
    expect(r.filter((b) => b.ackable)).toEqual([]);
  });
  it('HOST POWER: mains shows nothing, on battery is a notice, a percent gives the plug-in warning', () => {
    for (const v of ['', 'ok', 'AC', 'none']) expect(parseHostPower(v).onBattery).toBe(false);
    expect(show(B({ host_power: 'battery' }))[0]).toMatchObject({ text: 'HOST ON BATTERY', level: 'NONE' });
    expect(show(B({ host_power: 'battery:28' }))[0]).toMatchObject({ text: 'HOST BATTERY 28%: plug in', level: 'WARNING' });
  });
});

describe('TEST or REPLAY bar (3.7)', () => {
  it('LIVE shows no bar; SIMULATOR says TEST; REPLAY says REPLAY with Asia/Manila 24-hour time', () => {
    expect(modeText('LIVE', 0)).toBeNull(); expect(modeText(undefined, undefined)).toBeNull();
    expect(modeText('SIMULATOR', 0)).toBe('TEST: simulator data');
    expect(modeText('REPLAY', Date.UTC(2026, 10, 26, 9, 5))).toBe('REPLAY: 26/11/2026 17:05');
  });
});

describe('Acknowledge of a banner', () => {
  const api = (status: number, body: unknown = {}) => ({ fetchFn: vi.fn(async () => ({ status, json: async () => body }) as unknown as Response) as unknown as typeof fetch, getToken: () => 'tok' });
  const mk = () => createStore<LiveState>(() => initialState('LIVE'));
  it('posts to the kind and records the host time', async () => {
    const a = api(200, { kind: 'host_gap', acknowledged_ts: 99 }), s = mk();
    expect((await ackBanner('host_gap', a, s)).kind).toBe('ok'); expect(s.getState().bannerAck).toEqual({ host_gap: 99 });
    expect((a.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/system-banners/host_gap/ack');
  });
  it('a 409 (acknowledged in another tab) counts as acknowledged; a failure does not', async () => {
    const s = mk(); await ackBanner('logging_fault', api(409), s, () => 7); expect(s.getState().bannerAck).toEqual({ logging_fault: 7 });
    const t = mk(); const r = await ackBanner('host_gap', api(503), t); expect(t.getState().bannerAck).toEqual({}); expect(ackMessage(r)).toBe('The host did not answer. Try again.');
    expect(ackMessage({ kind: 'ok', body: {} })).toBeNull();
  });
});
