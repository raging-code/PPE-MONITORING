import { describe, expect, it } from 'vitest';
import type { AlertBody } from '../src/gen/ws.ts';
import { badgesFor, inTray, MAX_BADGES, trayOrder } from '../src/alerts/rules.ts';

let n = 0;
const mk = (alert_type: string, level: AlertBody['level'], over: Partial<AlertBody> = {}): AlertBody => ({
  alert_id: ++n, node_id: 1, alert_type: alert_type as AlertBody['alert_type'], level, reasons: null, authenticated: 1, episode_id: null,
  raised_ts: 1000 + n, cleared_ts: null, acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
const types = (xs: AlertBody[]) => xs.map((a) => a.alert_type);

describe('badges (3.2)', () => {
  it('shows at most 2, and a co_threshold DANGER is first even behind two WARNINGs', () => {
    const al = [mk('scba_expired', 'WARNING'), mk('sensor_fault', 'WARNING'), mk('co_threshold', 'DANGER')];
    expect(MAX_BADGES).toBe(2);
    expect(types(badgesFor(al, 1))).toEqual(['co_threshold', 'scba_expired']);
  });
  it('orders by level first, then badge_order, then alert_id', () => {
    expect(types(badgesFor([mk('heat', 'WARNING'), mk('link_lost', 'DANGER')], 1))).toEqual(['link_lost', 'heat']);
    expect(types(badgesFor([mk('node_reboot', 'NONE'), mk('battery_low', 'WARNING')], 1))).toEqual(['battery_low', 'node_reboot']);
    const [a, b] = [mk('unauth_alert', 'NONE'), mk('unauth_alert', 'NONE')];
    expect(badgesFor([b, a], 1).map((x) => x.alert_id)).toEqual([a.alert_id, b.alert_id]);
  });
  it('counts only this node, uncleared alerts, and not hotspot-only types', () => {
    const al = [mk('man_down', 'DANGER', { node_id: 2 }), mk('heat', 'WARNING', { cleared_ts: 5 }), mk('wrist_open', 'NONE'), mk('weak_signal', 'NONE'), mk('mayday', 'DANGER', { node_id: null })];
    expect(types(badgesFor(al, 1))).toEqual(['weak_signal']);
    expect(types(badgesFor(al, 2))).toEqual(['man_down']);
  });
  it('keeps an unknown type visible instead of dropping it', () => {
    expect(types(badgesFor([mk('brand_new', 'WARNING')], 1))).toEqual(['brand_new']);
    expect(inTray(mk('brand_new', 'WARNING'))).toBe(true);
  });
});

describe('tray (3.3)', () => {
  it('puts danger before warning, then oldest first', () => {
    const al = [mk('heat', 'WARNING', { raised_ts: 10 }), mk('link_lost', 'DANGER', { raised_ts: 50 }), mk('man_down', 'DANGER', { raised_ts: 20 }), mk('battery_low', 'WARNING', { raised_ts: 5 })];
    expect(types(trayOrder(al).cards.map((i) => i.alert))).toEqual(['man_down', 'link_lost', 'battery_low', 'heat']);
  });
  it('keeps a threshold alert that cleared before acknowledge, as cleared, until acknowledged', () => {
    const open = mk('co_threshold', 'WARNING', { cleared_ts: 90 });
    const acked = mk('co_threshold', 'WARNING', { cleared_ts: 90, acknowledged_ts: 95 });
    const live = mk('heat', 'WARNING', { acknowledged_ts: 80 });
    const t = trayOrder([open, acked, live]).cards;
    expect(t.map((i) => [i.alert.alert_id, i.cleared])).toEqual([[open.alert_id, true], [live.alert_id, false]]);
  });
  it('lets an estimate be dismissed, never a safety or security card', () => {
    const est = mk('estimate', 'NONE'), md = mk('man_down', 'DANGER'), ua = mk('unauth_alert', 'NONE');
    const all = trayOrder([est, md, ua], new Set([est.alert_id, md.alert_id, ua.alert_id]));
    expect(all.slim).toEqual([]);
    expect(all.cards.map((i) => [i.alert.alert_type, i.dismissible])).toEqual([['man_down', false], ['unauth_alert', false]]);
    expect(trayOrder([est]).slim.map((i) => [i.alert.alert_id, i.dismissible])).toEqual([[est.alert_id, true]]);
  });
  it('drops an estimate once it clears, and never shows quiet notices as cards', () => {
    expect(inTray(mk('estimate', 'NONE', { cleared_ts: 9 }))).toBe(false);
    for (const t of ['node_reboot', 'button_stuck', 'shadow_notice', 'weak_signal', 'co_rising', 'wrist_open', 'suspect_frame']) expect(inTray(mk(t, 'NONE')), t).toBe(false);
  });
  it('shows a check-in as a card at WARNING and as a notice at NONE', () => {
    expect(inTray(mk('checkin', 'WARNING'))).toBe(true);
    expect(inTray(mk('checkin', 'NONE'))).toBe(false);
  });
  it('puts the 3 responders in alert plus 1 advisory into 3 cards and 1 slim card, in order', () => {
    const al = [mk('man_down', 'DANGER', { node_id: 1 }), mk('co_threshold', 'DANGER', { node_id: 2 }), mk('heat', 'WARNING', { node_id: 3 }), mk('estimate', 'NONE', { node_id: 1 })];
    const t = trayOrder(al);
    expect(t.cards.map((i) => i.alert.node_id)).toEqual([1, 2, 3]);
    expect(t.slim).toHaveLength(1);
  });
});
