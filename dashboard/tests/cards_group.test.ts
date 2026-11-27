// Requirements: REQ-UI-001, REQ-UI-003
import { describe, expect, it } from 'vitest';
import type { AlertBody } from '../src/gen/ws.ts';
import { buildCards, chipText, formatElapsed, isFlashing, lineText, mergeRepeats } from '../src/alerts/group.ts';
import { trayOrder } from '../src/alerts/rules.ts';
import { levelView } from '../src/alerts/style.ts';

let n = 0;
const mk = (alert_type: string, level: AlertBody['level'], over: Partial<AlertBody> = {}): AlertBody => ({
  alert_id: ++n, node_id: 1, alert_type: alert_type as AlertBody['alert_type'], level, reasons: null, authenticated: 1, episode_id: null,
  raised_ts: 1000 + n, cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
const cards = (al: AlertBody[]) => buildCards(trayOrder(al));
const NODE = { node_id: 1, alias: 'FF-01', co_ppm: 52.4, temp_c: 61.6, bat_pct: 9.6 } as never;

describe('repeat alerts join their card (3.3)', () => {
  it('merges the same type on the same responder into one line with a count', () => {
    const lines = mergeRepeats(trayOrder([mk('co_threshold', 'WARNING', { cleared_ts: 5 }), mk('co_threshold', 'WARNING')]).cards);
    expect(lines).toHaveLength(1);
    expect([lines[0].count, lines[0].cleared, lines[0].ids.length]).toEqual([2, false, 2]);
  });
  it('counts an unauthenticated repeat by unauth_count', () => {
    expect(mergeRepeats(trayOrder([mk('unauth_alert', 'NONE', { unauth_count: 3 })]).cards)[0].count).toBe(3);
  });
  it('starts a new line after Acknowledge, and keeps other types and responders apart', () => {
    const old = mk('co_threshold', 'WARNING', { acknowledged_ts: 9 });
    expect(mergeRepeats(trayOrder([old, mk('co_threshold', 'WARNING')]).cards)).toHaveLength(2);
    expect(mergeRepeats(trayOrder([mk('heat', 'WARNING'), mk('battery_low', 'WARNING'), mk('heat', 'WARNING', { node_id: 2 })]).cards)).toHaveLength(3);
  });
});

describe('cards', () => {
  it('makes one card per responder, highest level line first, and orders cards danger first then oldest', () => {
    const c = cards([mk('heat', 'WARNING', { node_id: 2 }), mk('battery_low', 'WARNING', { node_id: 1 }), mk('man_down', 'DANGER', { node_id: 1 }), mk('link_lost', 'DANGER', { node_id: 3, raised_ts: 1 })]).cards;
    expect(c.map((x) => [x.key, x.level])).toEqual([['n3', 'DANGER'], ['n1', 'DANGER'], ['n2', 'WARNING']]);
    expect(c[1].lines.map((l) => l.alert.alert_type)).toEqual(['man_down', 'battery_low']);
  });
  it('gives an unverified alert its own dashed card and an estimate a slim card, neither with a level colour', () => {
    const c = cards([mk('man_down', 'DANGER'), mk('unauth_alert', 'NONE'), mk('estimate', 'NONE')]);
    expect(c.cards.map((x) => x.kind)).toEqual(['responder', 'unauth']);
    expect(c.slim.map((x) => x.kind)).toEqual(['slim']);
    expect(levelView('NONE').box).not.toContain('level-');
    expect(levelView('NORMAL').box).toContain('level-normal');
  });
  it('flashes only while a line is open and unacknowledged', () => {
    expect(isFlashing(cards([mk('heat', 'WARNING')]).cards[0])).toBe(true);
    expect(isFlashing(cards([mk('heat', 'WARNING', { acknowledged_ts: 5 })]).cards[0])).toBe(false);
    expect(isFlashing(cards([mk('co_threshold', 'WARNING', { cleared_ts: 5 })]).cards[0])).toBe(false);
    expect(isFlashing(cards([mk('unauth_alert', 'NONE')]).cards[0])).toBe(false);
  });
  it('signs a card so a new raise or a higher level reopens it', () => {
    const a = mk('heat', 'WARNING'), sig = (al: AlertBody[]) => cards(al).cards[0].sig;
    expect(sig([a])).toBe(sig([a]));
    expect(sig([a, mk('battery_low', 'WARNING')])).not.toBe(sig([a]));
    expect(sig([{ ...a, level: 'DANGER' }])).not.toBe(sig([a]));
  });
});

describe('text', () => {
  it('fills catalog text with the live values, rounded, and keeps an unknown type readable', () => {
    expect(lineText(mk('co_threshold', 'WARNING'), NODE)).toBe('FF-01 CO 52 ppm, SCBA OFF');
    expect(lineText(mk('heat', 'WARNING'), NODE)).toBe('FF-01 HEAT 62 C ambient (unvalidated)');
    expect(lineText(mk('battery_low', 'WARNING'), undefined)).toBe('Node 1 BATTERY ?%');
    expect(lineText(mk('brand_new', 'WARNING'), NODE)).toBe('FF-01 ALERT: brand_new');
  });
  it('formats elapsed time and the chip text', () => {
    expect([formatElapsed(-5), formatElapsed(9000), formatElapsed(124999), formatElapsed(3725000)]).toEqual(['0:00', '0:09', '2:04', '1:02:05']);
    const c = cards([mk('man_down', 'DANGER', { raised_ts: 1001 }), mk('mayday', 'DANGER', { raised_ts: 1002 })]).cards[0];
    expect(chipText(c, { 1: NODE }, 126000)).toBe('FF-01 DANGER ×2 2:04');
  });
});
