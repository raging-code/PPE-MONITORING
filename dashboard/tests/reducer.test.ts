import { describe, it, expect } from 'vitest';
import { apply, initialState } from '../src/store/reducer.ts';
import type { ServerMessage } from '../src/gen/ws.ts';
import { snapshot, tick, alert } from './helpers.ts';

const msg = (m: unknown) => m as ServerMessage;
const live = () => apply(initialState('CONNECTING'), msg(snapshot())).state;

describe('reducer (design 3.8)', () => {
  it('a snapshot fills the state and starts srv_seq at 0', () => {
    const s = live();
    expect(s.conn).toBe('LIVE');
    expect(s.epoch).toBe('e1');
    expect(s.lastSeq).toBe(0);
    expect(s.nodes[1].alias).toBe('FF-01');
    expect(s.constants.co_warn_ppm).toBe(35.0);
  });
  it('an increment before any snapshot asks for a resync and changes nothing', () => {
    const s0 = initialState('CONNECTING');
    const r = apply(s0, msg(tick(1)));
    expect(r.resync).toBe(true);
    expect(r.state).toBe(s0);
  });
  it('a gap in srv_seq asks for a resync and keeps the old state', () => {
    const s = live();
    const r = apply(s, msg(tick(2)));
    expect(r.resync).toBe(true);
    expect(r.state).toBe(s);
  });
  it('a duplicate or older srv_seq is also a resync', () => {
    const s1 = apply(live(), msg(tick(1))).state;
    expect(apply(s1, msg(tick(1))).resync).toBe(true);
  });
  it('a snapshot with srv_seq other than 0 is refused', () => {
    expect(apply(initialState('CONNECTING'), msg(snapshot({ srv_seq: 5 }))).resync).toBe(true);
  });
  it('a second snapshot (reconnect) replaces everything', () => {
    let s = apply(live(), msg(alert(1))).state;
    expect(Object.keys(s.alerts)).toEqual(['7']);
    s = apply(s, msg(snapshot({ epoch: 'e2' }))).state;
    expect(s.epoch).toBe('e2');
    expect(s.lastSeq).toBe(0);
    expect(Object.keys(s.alerts)).toEqual([]);
  });
  it('a reading updates the node and keeps its link state', () => {
    const r = { v: 1, type: 'reading', srv_seq: 1, srv_ts: 2000, node_id: 1, alias: 'FF-01', rx_ts: 1990, co_ppm: 52, co_over_range: 0,
      co_validity: 'VALID', co_reason: null, temp_c: 33, hum_pct: 40, motion_g: 0.1, posture: 'UPRIGHT', stillness_s: 0, bat_pct: 80,
      scba: 1, mandown: 0, level: 'WARNING', reasons: ['co'], seq_class: 'fresh', rssi: -80, snr: 7, status2: 0, flags: 1, id_mode: 73, status3: 0, status4: 0 };
    const s = apply(live(), msg(r)).state;
    expect(s.nodes[1].co_ppm).toBe(52);
    expect(s.nodes[1].level).toBe('WARNING');
    expect(s.nodes[1].link_state).toBe('ok');
    expect(s.lastSeq).toBe(1);
  });
  it('an alert is kept until it has cleared and been acknowledged', () => {
    let s = apply(live(), msg(alert(1))).state;
    expect(s.alerts[7].level).toBe('DANGER');
    s = apply(s, msg(alert(2, { cleared_ts: 1600 }))).state;
    expect(s.alerts[7].cleared_ts).toBe(1600); // cleared but unacknowledged: stays
    s = apply(s, msg(alert(3, { cleared_ts: 1600, acknowledged_ts: 1700, acknowledged_by: 1 }))).state;
    expect(s.alerts[7]).toBeUndefined();
  });
  it('an episode is dropped when it is RESOLVED', () => {
    const ep = (seq: number, state: string) => ({ v: 1, type: 'episode', srv_seq: seq, srv_ts: 1000 + seq, episode_id: 3, node_id: 1, kind: 'MAN_DOWN',
      state, man_down_motion_state: 'no_response', resolve_reason: state === 'RESOLVED' ? 'rescued' : null, operator: null });
    let s = apply(live(), msg(ep(1, 'OPEN'))).state;
    expect(s.episodes[3].state).toBe('OPEN');
    s = apply(s, msg(ep(2, 'RESOLVED'))).state;
    expect(s.episodes[3]).toBeUndefined();
  });
  it('a link message changes only that node', () => {
    const l = { v: 1, type: 'link', srv_seq: 1, srv_ts: 2000, node_id: 1, state: 'signal_lost', since_ts: 1900, last_state: 'ok' };
    expect(apply(live(), msg(l)).state.nodes[1].link_state).toBe('signal_lost');
  });
  it('a system message sets banners and records a banner acknowledgement', () => {
    const sys = { v: 1, type: 'system', srv_seq: 1, srv_ts: 2000, base: 'offline', recovering: false, session_id: 4, session_mode: 'LIVE', rejected_frames: 3,
      logging_fault: true, host_gap: null, host_power: 'ac', audio_fault: false, banner: 'logging_fault', acknowledged_ts: 1999 };
    const s = apply(live(), msg(sys)).state;
    expect(s.banners?.base_offline).toBe(true);
    expect(s.banners?.logging_fault).toBe(true);
    expect(s.rejectedFrames).toBe(3);
    expect(s.bannerAck.logging_fault).toBe(1999);
  });
  it('tick only moves the counters', () => {
    const s = apply(live(), msg(tick(1))).state;
    expect(s.lastSeq).toBe(1);
    expect(s.lastSrvTs).toBe(2000);
  });
});
