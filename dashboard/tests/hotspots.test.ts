// Requirements: REQ-UI-005
import { describe, it, expect } from 'vitest';
import { HOTSPOTS, LISTED, hotspotStates, type Byte, type HotspotId } from '../src/jacket/hotspots.ts';
import type { AlertBody, NodeSnap } from '../src/gen/ws.ts';

const K = { bat_warn_pct: 10, co_clamp_max_ppm: 500 };
// Baseline: everything quiet, wrist mated and OK, SCBA on, link OK.
const base = (over: Partial<NodeSnap> = {}): NodeSnap => ({
  node_id: 1, alias: 'FF-01', last_rx_ts: 900, co_ppm: 12, temp_c: 31.2, hum_pct: 44, motion_g: 0.08, bat_pct: 86, scba: 1, mandown: 0, level: 'NORMAL',
  link_state: 'ok', status2: 0x02, flags: 0, id_mode: 0x49, status3: 0, status4: 0, co_validity: 'VALID', co_reason: null, scba_correction: null, ...over,
});
const heat = (over: Partial<AlertBody> = {}): AlertBody => ({
  alert_id: 1, node_id: 1, alert_type: 'heat', level: 'WARNING', reasons: null, authenticated: 1, episode_id: null, raised_ts: 1, cleared_ts: null,
  acknowledged_ts: null, acknowledged_by: null, unauth_count: null, last_seen_ts: null, ...over,
});
const by = (n: NodeSnap, a: AlertBody[] = []) => Object.fromEntries(hotspotStates(n, a, K).map((h) => [h.id, h])) as Record<HotspotId, ReturnType<typeof hotspotStates>[number]>;
const BYTES: Byte[] = ['id_mode', 'flags', 'status2', 'status3', 'status4'];

describe('fault map (3.10)', () => {
  it('lists the nine hotspots of shared/hotspots.json in order', () => {
    expect(hotspotStates(base(), [], K).map((h) => h.id)).toEqual(HOTSPOTS.map((h) => h.id));
    expect(Object.keys(LISTED).sort()).toEqual(HOTSPOTS.map((h) => h.id).sort());
  });
  it('each hotspot reacts only to its listed bits: every bit of every status byte is flipped', () => {
    const quiet = hotspotStates(base(), [], K);
    for (const byte of BYTES) for (let bit = 0; bit < 8; bit++) {
      const n = base(); n[byte] = (n[byte] as number) ^ (1 << bit);
      hotspotStates(n, [], K).forEach((h, i) => {
        if (h.tone !== quiet[i].tone || h.word !== quiet[i].word) expect(LISTED[h.id][byte] ?? [], `${h.id} reacted to ${byte} bit ${bit}`).toContain(bit);
      });
    }
  });
  it('every listed bit moves some hotspot, except flags bit 3 (fault), which alone never greys CO', () => {
    const quiet = JSON.stringify(hotspotStates(base(), [], K));
    const listed = new Set(Object.values(LISTED).flatMap((l) => Object.entries(l).flatMap(([b, bits]) => bits!.map((x) => `${b}:${x}`))));
    for (const key of listed) {
      const [byte, bit] = key.split(':') as [Byte, string], n = base(); n[byte] = (n[byte] as number) ^ (1 << Number(bit));
      expect(JSON.stringify(hotspotStates(n, [], K)) !== quiet, key).toBe(key !== 'flags:3');
    }
  });
  it('bits no hotspot lists (node id, posture, restored, reset cause, still_now, reserved) change nothing', () => {
    const quiet = JSON.stringify(hotspotStates(base(), [], K));
    for (const [byte, bit] of [['id_mode', 0], ['id_mode', 4], ['status3', 4], ['status3', 5], ['status3', 7], ['status4', 1], ['status4', 4], ['status4', 7], ['flags', 7]] as [Byte, number][]) {
      const n = base(); n[byte] = (n[byte] as number) ^ (1 << bit);
      expect(JSON.stringify(hotspotStates(n, [], K)), `${byte} ${bit}`).toBe(quiet);
    }
  });
  it('CO: a CO fault or an SHT40 fault greys it, an IMU fault does not; 500+ and warming up are words', () => {
    expect(by(base({ status2: 0x12 })).co_sensor).toMatchObject({ tone: 'grey', word: 'CO unknown' });
    expect(by(base({ status2: 0x42 })).co_sensor.tone).toBe('grey');
    expect(by(base({ status2: 0x22 })).co_sensor.tone).toBe('neutral');
    expect(by(base({ co_validity: 'UNRELIABLE' })).co_sensor.tone).toBe('grey');
    expect(by(base({ flags: 0x10, co_ppm: 500 })).co_sensor.word).toBe('500+ ppm');
    expect(by(base({ status3: 0x04 })).co_sensor.word).toBe('warming up');
    expect(by(base()).co_sensor.word).toBe('12 ppm');
  });
  it('SHT40: grey on its fault bit; the heat alert gives it the alert level, and a cleared one does not', () => {
    expect(by(base({ status2: 0x42 })).sht40).toMatchObject({ tone: 'grey', word: 'temperature unknown' });
    expect(by(base(), [heat()]).sht40.tone).toBe('warning');
    expect(by(base(), [heat({ level: 'DANGER' })]).sht40.tone).toBe('danger');
    expect(by(base(), [heat({ cleared_ts: 5 })]).sht40.tone).toBe('neutral');
    expect(by(base(), [heat({ node_id: 2 })]).sht40.tone).toBe('neutral');
  });
  it('IMU: red for man-down even with an IMU fault; grey on the fault; otherwise the activity word', () => {
    expect(by(base({ flags: 0x04 })).chest_imu).toMatchObject({ tone: 'danger', word: 'MAN-DOWN' });
    expect(by(base({ flags: 0x04, status2: 0x22 })).chest_imu.tone).toBe('danger');
    expect(by(base({ status2: 0x22 })).chest_imu.tone).toBe('grey');
    expect(by(base({ flags: 0x40 })).chest_imu.word).toBe('fall suspected');
  });
  it('wrist: an open connector is quiet "disconnected"; wrist lost (WARNING) only while the connector is mated', () => {
    expect(by(base({ status4: 0x01, status2: 0 })).wrist_module).toMatchObject({ tone: 'neutral', word: 'disconnected' });
    expect(by(base({ status2: 0 })).wrist_module).toMatchObject({ tone: 'warning', word: 'wrist lost' });
    expect(by(base()).wrist_module.word).toBe('connected');
  });
  it('SCBA, battery, radio, buzzer and CANCEL show their listed states', () => {
    expect(by(base()).scba_coupling.word).toBe('ON');
    expect(by(base({ id_mode: 0x41 })).scba_coupling.word).toBe('OFF');
    expect(by(base({ status3: 0x08 })).scba_coupling).toMatchObject({ tone: 'warning', word: 'EXPIRED' });
    expect(by(base({ bat_pct: 20, status2: 0x06 })).battery).toMatchObject({ tone: 'neutral', word: '20% low' });
    expect(by(base({ bat_pct: 10, status2: 0x06 })).battery).toMatchObject({ tone: 'warning', word: '10% LOW' });
    expect(by(base({ link_state: 'link_lost' })).radio_node).toMatchObject({ tone: 'grey', word: 'link lost' });
    expect(by(base({ id_mode: 0xc9 })).radio_node.word).toBe('link OK, MISSED EVENT');
    expect(by(base({ flags: 1 })).buzzer_led).toMatchObject({ tone: 'warning', word: 'WARNING' });
    expect(by(base({ flags: 2 })).buzzer_led).toMatchObject({ tone: 'danger', word: 'DANGER' });
    expect(by(base({ flags: 3 })).buzzer_led.tone).toBe('grey');
    expect(by(base({ status3: 0x01 })).cancel_button).toMatchObject({ tone: 'warning', word: 'STUCK' });
    expect(by(base({ status3: 0x02 })).cancel_button.word).toBe('CLEAR ARMED');
    expect(by(base({ status2: 0x82 })).cancel_button.word).toBe('CANCEL SEEN');
  });
});
