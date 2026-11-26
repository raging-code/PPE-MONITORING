// Pure state machine for the /ws data socket (design 3.8). No DOM, no timers, no socket.
// apply() returns resync = true when the message cannot be trusted (an increment before the
// snapshot, or a gap in srv_seq): the caller reconnects, and the host sends a snapshot first.
import type {
  AdvisoryMsg, AlertBody, Banners, EpisodeBody, NodeSnap, RosterRow, ServerMessage, SessionInfo,
} from '../gen/ws.ts';

export type Conn = 'CONNECTING' | 'LIVE' | 'LOGIN' | 'FORBIDDEN';

export interface LiveState {
  conn: Conn;
  epoch: string | null;
  lastSeq: number;
  lastSrvTs: number | null;
  recovering: boolean;
  monitoringActive: boolean;
  session: SessionInfo | null;
  roster: RosterRow[];
  nodes: Record<number, NodeSnap>;
  alerts: Record<number, AlertBody>;
  episodes: Record<number, EpisodeBody>;
  advisories: Record<number, Omit<AdvisoryMsg, 'v' | 'type' | 'srv_seq' | 'srv_ts'> & { srv_ts: number }>;
  coHistory: Record<string, number[][]>;
  banners: Banners | null;
  bannerAck: Record<string, number>;
  rejectedFrames: number;
  constants: Record<string, unknown>;
}

export function initialState(conn: Conn): LiveState {
  return {
    conn, epoch: null, lastSeq: -1, lastSrvTs: null, recovering: false, monitoringActive: false,
    session: null, roster: [], nodes: {}, alerts: {}, episodes: {}, advisories: {}, coHistory: {},
    banners: null, bannerAck: {}, rejectedFrames: 0, constants: {},
  };
}

const byId = <T,>(rows: T[], key: (r: T) => number): Record<number, T> => {
  const out: Record<number, T> = {};
  for (const r of rows) out[key(r)] = r;
  return out;
};

export function apply(s: LiveState, m: ServerMessage): { state: LiveState; resync: boolean } {
  if (m.type === 'snapshot') {
    if (m.srv_seq !== 0) return { state: s, resync: true };
    return {
      resync: false,
      state: {
        conn: 'LIVE', epoch: m.epoch, lastSeq: 0, lastSrvTs: m.srv_ts, recovering: m.recovering,
        monitoringActive: m.monitoring_active, session: m.session, roster: m.roster,
        nodes: byId(m.nodes, (n) => n.node_id), alerts: byId(m.open_alerts, (a) => a.alert_id),
        episodes: byId(m.open_episodes, (e) => e.episode_id), advisories: {},
        coHistory: m.co_history_30m, banners: m.banners, bannerAck: {}, rejectedFrames: 0,
        constants: m.constants,
      },
    };
  }
  if (s.epoch === null || m.srv_seq !== s.lastSeq + 1) return { state: s, resync: true };
  const n: LiveState = { ...s, lastSeq: m.srv_seq, lastSrvTs: m.srv_ts };
  switch (m.type) {
    case 'reading': {
      const old = s.nodes[m.node_id];
      n.nodes = {
        ...s.nodes,
        [m.node_id]: {
          ...({ link_state: 'ok' as const, scba_correction: null, ...(old as Partial<NodeSnap> | undefined) }), node_id: m.node_id, alias: m.alias,
          last_rx_ts: m.rx_ts, co_ppm: m.co_ppm, temp_c: m.temp_c, hum_pct: m.hum_pct,
          motion_g: m.motion_g, bat_pct: m.bat_pct, scba: m.scba, mandown: m.mandown, level: m.level,
          status2: m.status2, flags: m.flags, id_mode: m.id_mode, status3: m.status3, status4: m.status4,
          co_validity: m.co_validity, co_reason: m.co_reason,
        },
      };
      break;
    }
    case 'alert': {
      const { v, srv_seq, srv_ts, type, ...body } = m;
      const alerts = { ...s.alerts, [body.alert_id]: body };
      // Gone only when it has cleared AND someone acknowledged it: an unacknowledged cleared alert
      // stays for the card to show as "cleared" (P22).
      if (body.cleared_ts !== null && body.acknowledged_ts !== null) delete alerts[body.alert_id];
      n.alerts = alerts;
      break;
    }
    case 'episode': {
      const { v, srv_seq, srv_ts, type, ...body } = m;
      const episodes = { ...s.episodes, [body.episode_id]: body };
      if (body.state === 'RESOLVED') delete episodes[body.episode_id];
      n.episodes = episodes;
      break;
    }
    case 'link': {
      const old = s.nodes[m.node_id];
      if (old) n.nodes = { ...s.nodes, [m.node_id]: { ...old, link_state: m.state } };
      break;
    }
    case 'system': {
      n.recovering = m.recovering;
      n.rejectedFrames = m.rejected_frames;
      if (s.session) n.session = { ...s.session, session_id: m.session_id, mode: m.session_mode };
      n.banners = {
        base_offline: m.base === 'offline', logging_fault: m.logging_fault, host_gap: m.host_gap,
        host_power: m.host_power, audio_fault: m.audio_fault,
      };
      if (m.banner !== null && m.acknowledged_ts !== null) n.bannerAck = { ...s.bannerAck, [m.banner]: m.acknowledged_ts };
      break;
    }
    case 'advisory':
      n.advisories = { ...s.advisories, [m.node_id]: { node_id: m.node_id, risk: m.risk, reasons: m.reasons, action: m.action, quality: m.quality, source: m.source, srv_ts: m.srv_ts } };
      break;
    default:
      break; // tick and ml only move lastSeq and lastSrvTs
  }
  return { state: n, resync: false };
}
