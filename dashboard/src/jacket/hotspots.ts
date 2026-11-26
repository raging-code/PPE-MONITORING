// The fault map of design 3.10: each hotspot reacts only to the frame bits listed for it. Ids, labels and order come from
// shared/hotspots.json, so the flat grid and the later 3D view use one list. Pure: no DOM, no clock.
import raw from '../../../shared/hotspots.json';
import { BITS } from '../gen/abi.ts';
import type { AlertBody, NodeSnap } from '../gen/ws.ts';

export type HotspotId = 'co_sensor' | 'sht40' | 'chest_imu' | 'wrist_module' | 'scba_coupling' | 'battery' | 'radio_node' | 'buzzer_led' | 'cancel_button';
export type Tone = 'neutral' | 'grey' | 'warning' | 'danger';
export interface HotspotState { id: HotspotId; label: string; tone: Tone; word: string }
export interface Limits { bat_warn_pct: number; co_clamp_max_ppm: number }
export type Byte = 'id_mode' | 'flags' | 'status2' | 'status3' | 'status4';

export const HOTSPOTS = raw.hotspots as { id: HotspotId; label: string }[];
// Table 3.10, column 2, as data: the bits each hotspot may react to. The test flips every bit of every byte against this list.
export const LISTED: Record<HotspotId, Partial<Record<Byte, number[]>>> = {
  co_sensor: { status2: [4, 5, 6], flags: [3, 4], status3: [2] },
  sht40: { status2: [6] },
  chest_imu: { status2: [5], flags: [2, 5, 6] },
  wrist_module: { status4: [0], status2: [1] },
  scba_coupling: { id_mode: [3], status3: [3] },
  battery: { status2: [2] },
  radio_node: { id_mode: [6, 7] },
  buzzer_led: { flags: [0, 1] },
  cancel_button: { status3: [0, 1], status2: [7] },
};

const on = (v: number | null, f: { shift: number }): boolean => v !== null && ((v >> f.shift) & 1) === 1;
const num = (v: number | null, f: { shift: number; width: number }): number => (v === null ? 0 : (v >> f.shift) & ((1 << f.width) - 1));
const LINK: Record<NodeSnap['link_state'], string> = { ok: 'link OK', not_connected: 'not connected', weak_signal: 'weak signal', signal_lost: 'signal lost', link_lost: 'link lost', recovered: 'recovered' };
const ACTIVITY = ['still', 'active', 'fall suspected', 'uncertain'];
const LEVEL_WORD: [string, Tone][] = [['off', 'neutral'], ['WARNING', 'warning'], ['DANGER', 'danger'], ['invalid', 'grey']];

export function hotspotStates(n: NodeSnap, alerts: AlertBody[], k: Limits): HotspotState[] {
  const s2 = BITS.status2, s3 = BITS.status3, s4 = BITS.status4, fl = BITS.flags, im = BITS.id_mode;
  const heat = alerts.find((a) => a.node_id === n.node_id && a.alert_type === 'heat' && a.cleared_ts === null);
  const pct = n.bat_pct === null ? null : Math.round(n.bat_pct);
  const sat = on(n.flags, fl.co_sat), connOpen = on(n.status4, s4.wrist_conn_open), level = LEVEL_WORD[num(n.flags, fl.node_level)];
  const co = n.co_ppm === null ? '?' : n.co_ppm >= k.co_clamp_max_ppm ? `${k.co_clamp_max_ppm}+` : String(Math.round(n.co_ppm));
  const out: Record<HotspotId, [Tone, string]> = {
    // 14.2: CO is unreliable on a CO fault or an SHT40 fault (bit 6); the host's own verdict counts too. The IMU bit never greys CO.
    co_sensor: on(n.status2, s2.co_fault) || on(n.status2, s2.temp_fault) || n.co_validity === 'UNRELIABLE' ? ['grey', 'CO unknown']
      : sat ? ['neutral', `${k.co_clamp_max_ppm}+ ppm`] : on(n.status3, s3.co_warmup) ? ['neutral', 'warming up'] : ['neutral', `${co} ppm`],
    sht40: on(n.status2, s2.temp_fault) ? ['grey', 'temperature unknown']
      : [heat ? (heat.level === 'DANGER' ? 'danger' : 'warning') : 'neutral', `${n.temp_c === null ? '?' : Math.round(n.temp_c)} °C, ${n.hum_pct === null ? '?' : Math.round(n.hum_pct)} %`],
    // A latched man-down is never hidden by a sensor fault.
    chest_imu: on(n.flags, fl.mandown) ? ['danger', 'MAN-DOWN'] : on(n.status2, s2.imu_fault) ? ['grey', 'IMU unknown'] : ['neutral', ACTIVITY[num(n.flags, fl.activity)]],
    wrist_module: connOpen ? ['neutral', 'disconnected'] : !on(n.status2, s2.wrist_ok) ? ['warning', 'wrist lost'] : ['neutral', 'connected'],
    scba_coupling: on(n.status3, s3.scba_expired) ? ['warning', 'EXPIRED'] : ['neutral', on(n.id_mode, im.scba_on) ? 'ON' : 'OFF'],
    battery: pct !== null && pct <= k.bat_warn_pct ? ['warning', `${pct}% LOW`] : on(n.status2, s2.bat_low) ? ['neutral', `${pct ?? '?'}% low`] : ['neutral', `${pct ?? '?'}%`],
    radio_node: [n.link_state === 'ok' ? 'neutral' : 'grey', `${LINK[n.link_state]}${n.link_state === 'ok' && !on(n.id_mode, im.link_ok) ? ', base not heard' : ''}${on(n.id_mode, im.evt_unsent) ? ', MISSED EVENT' : ''}`],
    buzzer_led: [level[1], level[0]],
    cancel_button: on(n.status3, s3.btn_stuck) ? ['warning', 'STUCK'] : on(n.status3, s3.clear_armed) ? ['neutral', 'CLEAR ARMED'] : on(n.status2, s2.cancel_ack) ? ['neutral', 'CANCEL SEEN'] : ['neutral', 'ready'],
  };
  return HOTSPOTS.map((h) => ({ id: h.id, label: h.label, tone: out[h.id][0], word: out[h.id][1] }));
}
