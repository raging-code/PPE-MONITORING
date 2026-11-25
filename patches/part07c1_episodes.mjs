// patches/part07c1_episodes.mjs  (run from repo root: node patches/part07_2_battery_link_unauth.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  const RE = 'host/ppe_host/core/rule_engine.py', GV = 'host/tests/test_golden_vectors.py', MD_T = 'host/tests/test_man_down.py';
  put('host/tests/test_episodes.py', String.raw`"""P7c-1: episode lifecycle (design 14.1 man_down / mayday rows, 2.3 episodes, 3.3 cards): GV-02 and GV-03 episode halves, GV-10 Acknowledge, GV-20,
the MAN_DOWN label rule (5 s and 15 s), Acknowledge and Resolve. Frames are built from F-01; operator actions go through step() as events."""
import pytest
from test_co_state import co_frame
from test_co_threshold import Eng
from ppe_host.core import rule_engine as re_
from ppe_host.core.rule_engine import (AckAlertEvent, AckEpisodeEvent, EngineState, EpisodeAcknowledged, EpisodeEscalated, EpisodeLabelChanged, EpisodeOpened,
                                       EpisodeResolved, AlertAcknowledged, ClearAlert, FrameEvent, RaiseAlert, ResolveEpisodeEvent, TickEvent, raise_alert)

MD, MAYDAY = 0x06, 0x10
def mf(flags=0, status4=0, motion=0, seq_class='fresh', node=1):
    d = dict(co_frame(co_x10=0, node=node).decoded); d.update(flags=flags, status4=status4, motion_x100=motion, id_mode=0x40 | node)
    return FrameEvent(node, 'OK', seq_class, d)
def nm(fx): return [(type(x).__name__, getattr(x, 'type', None) or getattr(x, 'kind', None) or getattr(x, 'motion_state', None)) for x in fx]
def ep(e, n=1): return e.state.episodes.get(n)
def al(e, t, n=1): return e.state.alerts.get((n, t))
def resolve(e, reason='rescued', n=1): return e.step(ResolveEpisodeEvent(n, reason, 7), 0)

# ---- opening and upgrading (GV-02, GV-03) ----
def test_GV02_man_down_opens_one_episode_before_the_alert_row_and_adds_nothing_while_the_latch_stays_set():
    e = Eng(); fx = e.step(mf(MD, motion=1), 0)
    assert nm(fx) == [('EpisodeOpened', 'MAN_DOWN'), ('RaiseAlert', 'man_down')] and ep(e).state == 'OPEN' and ep(e).kind == 'MAN_DOWN' and al(e, 'man_down').level == 'DANGER' and e.state.nodes[1].level == 'DANGER'
    assert fx[0].event_seq < fx[1].event_seq and len(e.state.episodes) == 1
    assert sum(len(e.step(mf(MD))) for _ in range(5)) == 0 and len(e.state.episodes) == 1 and not al(e, 'node_danger')

def test_GV03_mayday_upgrades_the_open_episode_in_place_and_logs_the_escalation():
    e = Eng(); e.step(mf(MD), 0); first = ep(e).opened_event_seq; fx = e.step(mf(MD, MAYDAY))
    assert nm(fx) == [('EpisodeEscalated', 'MAYDAY'), ('RaiseAlert', 'mayday')] and (fx[0].old_kind, fx[0].kind) == ('MAN_DOWN', 'MAYDAY')
    assert len(e.state.episodes) == 1 and ep(e).kind == 'MAYDAY' and ep(e).opened_event_seq == first and ep(e).motion_state is None
    assert e.step(mf(MD, MAYDAY)) == []                                          # held: no second upgrade

def test_first_seen_mandown_and_first_seen_mayday_open_exactly_one_episode():
    e = Eng(); assert nm(e.step(mf(MD, MAYDAY), 0)) == [('EpisodeOpened', 'MAYDAY'), ('RaiseAlert', 'man_down'), ('RaiseAlert', 'mayday')] and len(e.state.episodes) == 1
    e = Eng(); e.step(mf(MD), 0); assert ep(e).kind == 'MAN_DOWN'

def test_a_restart_with_the_latch_still_set_opens_no_second_episode_or_alert():
    e = Eng(); e.step(mf(MD), 0)
    e.state = EngineState(event_seq=e.state.event_seq, alerts=dict(e.state.alerts), episodes=dict(e.state.episodes))   # rebuilt from open rows; node memory gone
    assert e.step(mf(MD)) == [] and len(e.state.episodes) == 1 and len(e.state.alerts) == 1

def test_mandown_0_to_1_while_an_episode_is_open_or_acknowledged_adds_no_episode_and_no_alert():
    for ack in (False, True):
        e = Eng(); e.step(mf(MD), 0)
        if ack: e.step(AckEpisodeEvent(1, 7), 0)
        e.step(mf(0)); assert e.step(mf(MD)) == [] and len(e.state.episodes) == 1 and len(e.state.alerts) == 1

def test_a_suspect_frame_opens_an_episode_but_never_moves_a_label_timer():
    e = Eng(); assert nm(e.step(mf(MD, motion=50, seq_class='suspect'), 0)) == [('EpisodeOpened', 'MAN_DOWN'), ('RaiseAlert', 'man_down')]
    e.step(mf(MD, motion=50, seq_class='suspect')); e.step(mf(MD, motion=50, seq_class='suspect'), 9000)
    assert ep(e).motion_state == 'no_response' and ep(e).move_since_mono is None

def test_nodes_have_independent_episodes():
    e = Eng(); e.step(mf(MD, node=1), 0); e.step(mf(MD, node=2), 0); assert set(e.state.episodes) == {1, 2}
    resolve(e, n=1); assert set(e.state.episodes) == {2} and al(e, 'man_down', 2) is not None

# ---- Acknowledge never closes a safety alert (14.1b, 14.1) ----
@pytest.mark.parametrize('typ', ['man_down', 'mayday', 'co_threshold', 'node_danger', 'link_lost', 'sensor_fault', 'battery_low'])
def test_acknowledge_sets_acknowledged_ts_and_never_closes_a_safety_alert(typ):
    e = Eng(); e.state, _ = raise_alert(e.state, 1, typ, 'DANGER', 'setup', e.clock.now()); seq0 = e.state.event_seq
    fx = e.step(AckAlertEvent(1, typ, 7), 0); assert nm(fx) == [('AlertAcknowledged', typ)] and al(e, typ).acknowledged_ts is not None and e.state.event_seq == seq0 + 1
    assert e.step(AckAlertEvent(1, typ, 7), 0) == [] and al(e, typ) is not None                       # idempotent
    assert e.step(AckAlertEvent(1, 'heat', 7), 0) == []                                                # nothing open: no effect, no error

def test_GV10_acknowledge_closes_an_unauth_alert_and_the_next_claim_opens_a_new_card_with_count_1():
    from test_link_battery import bad
    e = Eng(); e.step(bad(0x06, 2), 0); e.step(bad(0x06, 2)); assert al(e, 'unauth_alert', 2) is not None and e.state.nodes[2].unauth_count == 2
    assert nm(e.step(AckAlertEvent(2, 'unauth_alert', 7), 0)) == [('AlertAcknowledged', 'unauth_alert'), ('ClearAlert', 'unauth_alert')] and al(e, 'unauth_alert', 2) is None
    assert nm(e.step(bad(0x06, 2))) == [('RaiseAlert', 'unauth_alert')] and e.state.nodes[2].unauth_count == 1

def test_acknowledge_episode_acknowledges_the_episode_and_its_open_rows_and_closes_nothing():
    e = Eng(); e.step(mf(MD, MAYDAY), 0); fx = e.step(AckEpisodeEvent(1, 7), 0)
    assert nm(fx) == [('EpisodeAcknowledged', None), ('AlertAcknowledged', 'man_down'), ('AlertAcknowledged', 'mayday')]
    assert ep(e).state == 'ACKNOWLEDGED' and ep(e).acknowledged_by == 7 and al(e, 'man_down').acknowledged_ts is not None and al(e, 'mayday').acknowledged_ts is not None
    assert e.step(AckEpisodeEvent(1, 7), 0) == [] and e.step(AckEpisodeEvent(3, 7), 0) == [] and e.state.nodes[1].level == 'DANGER'

# ---- Resolve (14.1: the only way an episode ends) ----
def test_resolve_closes_the_episode_and_its_man_down_and_mayday_rows_and_nothing_else():
    e = Eng(); e.step(mf(MD, MAYDAY), 0); e.state, _ = raise_alert(e.state, 1, 'co_threshold', 'WARNING', 'setup', e.clock.now())
    fx = resolve(e, 'false_alarm'); assert nm(fx) == [('EpisodeResolved', 'MAYDAY'), ('ClearAlert', 'man_down'), ('ClearAlert', 'mayday')] and fx[0].reason == 'false_alarm' and fx[0].operator_id == 7
    assert e.state.episodes == {} and sorted(t for _, t in e.state.alerts) == ['co_threshold']

@pytest.mark.parametrize('reason', ['rescued', 'false_alarm', 'device_removed'])
def test_resolve_accepts_the_three_reasons(reason):
    e = Eng(); e.step(mf(MD), 0); assert nm(resolve(e, reason))[0] == ('EpisodeResolved', 'MAN_DOWN') and e.state.episodes == {}

@pytest.mark.parametrize('reason,op', [('bored', 7), (None, 7), ('', 7), ('rescued', None)])
def test_resolve_refuses_a_missing_reason_or_operator_and_changes_nothing(reason, op):
    e = Eng(); e.step(mf(MD), 0); before = e.state
    with pytest.raises(ValueError): e.step(ResolveEpisodeEvent(1, reason, op), 0)
    assert e.state is before and len(e.state.episodes) == 1

def test_resolve_with_no_active_episode_is_a_no_op():
    e = Eng(); before = e.state; assert resolve(e) == [] and e.state == before

def test_GV20_latch_still_set_after_resolve_is_a_level_not_an_event_and_clears_with_the_jacket_cancel():
    e = Eng(); e.step(mf(MD, motion=1), 0); resolve(e); assert e.state.nodes[1].level == 'DANGER'          # the node still reports DANGER
    out = []
    for _ in range(3): out += e.step(mf(MD))                                                                 # (a)
    assert out == [] and e.state.episodes == {} and e.state.alerts == {} and e.state.nodes[1].level == 'DANGER'
    assert e.step(mf(0)) == [] and e.state.nodes[1].level == 'NORMAL' and not al(e, 'node_danger')          # (b)

def test_after_resolve_and_a_jacket_clear_a_new_mandown_edge_opens_a_new_episode():
    e = Eng(); e.step(mf(MD), 0); first = ep(e).opened_event_seq; resolve(e); e.step(mf(0))
    assert nm(e.step(mf(MD))) == [('EpisodeOpened', 'MAN_DOWN'), ('RaiseAlert', 'man_down')] and ep(e).opened_event_seq != first

def test_a_latch_cleared_on_the_jacket_keeps_the_episode_open_until_an_operator_resolves_it():
    e = Eng(); e.step(mf(MD), 0)
    for _ in range(40): e.step(mf(0))
    assert ep(e) is not None and al(e, 'man_down') is not None
    e.step(TickEvent(), 60000); assert ep(e) is not None                                                    # no auto-resolve, ticks included

# ---- the MAN_DOWN label (3.3, 3.4): 5 s of movement, 15 s of stillness; card, siren and level never reduce ----
def labels(fx): return [x.motion_state for x in fx if isinstance(x, EpisodeLabelChanged)]
def test_label_changes_to_movement_detected_after_5_s_above_still_g_and_the_boundary_is_5_s():
    e = Eng(); e.step(mf(MD), 0); assert labels(e.step(mf(MD, motion=6), 2000)) == [] and labels(e.step(mf(MD, motion=6), 4999)) == [] and ep(e).motion_state == 'no_response'
    assert labels(e.step(mf(MD, motion=6), 1)) == ['movement_detected'] and ep(e).motion_state == 'movement_detected'   # 5000 ms after the first moving frame
    assert e.state.nodes[1].level == 'DANGER' and al(e, 'man_down').level == 'DANGER' and al(e, 'man_down').acknowledged_ts is None and ep(e).state == 'OPEN'

def test_motion_at_exactly_still_g_is_still_and_one_still_frame_restarts_the_5_s_run():
    e = Eng(); e.step(mf(MD), 0)
    for _ in range(5): e.step(mf(MD, motion=5))                                   # 0.05 g is not above STILL_G
    assert ep(e).motion_state == 'no_response'
    e.step(mf(MD, motion=6), 0); e.step(mf(MD, motion=6), 4000); e.step(mf(MD, motion=0), 500); e.step(mf(MD, motion=6), 500)
    assert labels(e.step(mf(MD, motion=6), 4000)) == [] and labels(e.step(mf(MD, motion=6), 1000)) == ['movement_detected']

def test_label_reverts_to_no_response_after_15_s_of_renewed_stillness_and_movement_restarts_that_clock():
    e = Eng(); e.step(mf(MD), 0); e.step(mf(MD, motion=9), 0); e.step(mf(MD, motion=9), 5000); assert ep(e).motion_state == 'movement_detected'
    e.step(mf(MD, motion=0), 2000); assert labels(e.step(mf(MD, motion=0), 12999)) == [] and labels(e.step(mf(MD, motion=9), 100)) == []
    e.step(mf(MD, motion=0), 100); assert labels(e.step(mf(MD, motion=0), 14999)) == [] and labels(e.step(mf(MD, motion=0), 1)) == ['no_response']
    assert e.state.nodes[1].level == 'DANGER' and al(e, 'man_down').level == 'DANGER'

def test_mayday_has_no_label_and_an_upgrade_drops_it():
    e = Eng(); e.step(mf(MD, MAYDAY), 0)
    for _ in range(6): assert labels(e.step(mf(MD, MAYDAY, motion=50))) == []
    assert ep(e).motion_state is None
    e = Eng(); e.step(mf(MD, motion=50), 0); e.step(mf(MD, MAYDAY, motion=50)); assert ep(e).motion_state is None and ep(e).move_since_mono is None

def test_label_survives_acknowledge_and_a_new_episode_starts_at_no_response():
    e = Eng(); e.step(mf(MD, motion=9), 0); e.step(mf(MD, motion=9), 5000); e.step(AckEpisodeEvent(1, 7), 0); assert ep(e).motion_state == 'movement_detected' and ep(e).state == 'ACKNOWLEDGED'
    resolve(e); e.step(mf(0)); e.step(mf(MD)); assert ep(e).motion_state == 'no_response'

def test_the_new_effects_and_events_are_exported_and_unknown_events_still_raise():
    for c in (AlertAcknowledged, EpisodeAcknowledged, EpisodeEscalated, EpisodeOpened, EpisodeResolved, EpisodeLabelChanged): assert issubclass(c, re_.Effect)
    with pytest.raises(TypeError): Eng().step(object())
`);
  replace(RE, "    if md and not n.mandown_prev: state, fx = raise_alert(state, nid, 'man_down', 'DANGER', _why(d), now)\n    if my and not n.mayday_prev:\n        state, more = raise_alert(state, nid, 'mayday', 'DANGER', _why(d), now); fx += more\n", "    state, fx = _episode_edges(state, nid, n, md, my, now)   # P7c-1: the episode opens or upgrades BEFORE the alert rows, so alerts.episode_id can link\n    if md and not n.mandown_prev: state, more = raise_alert(state, nid, 'man_down', 'DANGER', _why(d), now); fx += more\n    if my and not n.mayday_prev:\n        state, more = raise_alert(state, nid, 'mayday', 'DANGER', _why(d), now); fx += more\n    if fresh: state, more = _man_down_label(state, nid, d, now); fx += more\n");
  replace(RE, "nid: n2})), fx\n\nRULES = (co_state_rule", "nid: n2})), fx\n\n# ---- P7c-1: episode lifecycle (MAN_DOWN and MAYDAY), operator Acknowledge and Resolve, and the MAN_DOWN label rule, design 14.1 (man_down / mayday row),\n# 2.3 (episodes), 3.3 and 3.8. One active episode per node (idx_episodes_one_active). Episodes close ONLY through ResolveEpisodeEvent; Acknowledge never closes a\n# safety alert (only unauth_alert closes on Acknowledge, 14.1b). checkin, scba_expired, heat and the shadow estimator are P7c-2 and P7c-3. ----\nRESOLVE_REASONS = ('rescued', 'false_alarm', 'device_removed')\nEPISODE_ALERT_TYPES = ('man_down', 'mayday')\nNO_RESPONSE, MOVEMENT_DETECTED = 'no_response', 'movement_detected'\n\n@dataclass(frozen=True)\nclass Episode:\n    node_id: int\n    kind: str                       # MAN_DOWN | MAYDAY\n    state: str                      # OPEN | ACKNOWLEDGED (a RESOLVED episode leaves EngineState.episodes)\n    opened_event_seq: int           # identifies the row for the writer\n    opened_ts: int\n    acknowledged_ts: Optional[int] = None\n    acknowledged_by: Optional[int] = None\n    motion_state: Optional[str] = NO_RESPONSE   # man_down_motion_state; None for MAYDAY (no such label)\n    move_since_mono: Optional[int] = None       # first fresh frame of the current run above STILL_G (label to movement_detected after mandown_move_label_s)\n    still_since_mono: Optional[int] = None      # first fresh frame of the current run at or below STILL_G (label back after mandown_still_revert_s)\n\n@dataclass(frozen=True)\nclass AckAlertEvent:                # operator: POST /api/alerts/{alert_id}/ack (idempotent)\n    node_id: int\n    type: str\n    operator_id: Optional[int] = None\n\n@dataclass(frozen=True)\nclass AckEpisodeEvent:              # operator: POST /api/episodes/{episode_id}/ack (acknowledges the episode and its open alert rows)\n    node_id: int\n    operator_id: Optional[int] = None\n\n@dataclass(frozen=True)\nclass ResolveEpisodeEvent:          # operator: Resolve with a reason (rescued, false_alarm, device_removed)\n    node_id: int\n    reason: str\n    operator_id: Optional[int] = None\n\n@dataclass(frozen=True)\nclass EpisodeOpened(Effect):        # emitted BEFORE the RaiseAlert of the same frame, so the writer can link alerts.episode_id\n    node_id: int\n    kind: str\n    opened_ts: int\n\n@dataclass(frozen=True)\nclass EpisodeEscalated(Effect):     # MAN_DOWN -> MAYDAY in place (audit EPISODE_ESCALATED)\n    node_id: int\n    old_kind: str\n    kind: str\n    ts: int\n\n@dataclass(frozen=True)\nclass EpisodeLabelChanged(Effect):  # incremental episode WebSocket message (man_down_motion_state)\n    node_id: int\n    motion_state: str\n    ts: int\n\n@dataclass(frozen=True)\nclass EpisodeAcknowledged(Effect):\n    node_id: int\n    operator_id: Optional[int]\n    ts: int\n\n@dataclass(frozen=True)\nclass EpisodeResolved(Effect):\n    node_id: int\n    kind: str\n    reason: str\n    operator_id: int\n    ts: int\n\n@dataclass(frozen=True)\nclass AlertAcknowledged(Effect):    # sets alerts.acknowledged_ts and acknowledged_by on the row identified by raised_event_seq\n    node_id: int\n    type: str\n    raised_event_seq: int\n    operator_id: Optional[int]\n    ts: int\n\ndef _put_episode(state, ep): return replace(state, episodes={**state.episodes, ep.node_id: ep})\n\ndef _episode_edges(state, nid, n, md, my, now):\n    \"\"\"Open an episode on a mandown or mayday edge (0->1 or first-seen 1) when the node has none; upgrade an active MAN_DOWN to MAYDAY in place on a mayday edge.\n    An edge while an episode is active adds no episode (and no alert: the open rows stay, 14.1).\"\"\"\n    md_edge, my_edge, ep = md and not n.mandown_prev, my and not n.mayday_prev, state.episodes.get(nid)\n    if ep is None and (md_edge or my_edge):\n        kind = 'MAYDAY' if my else 'MAN_DOWN'\n        state, seq = next_seq(state)\n        return _put_episode(state, Episode(nid, kind, 'OPEN', seq, now.wall_ms, motion_state=None if kind == 'MAYDAY' else NO_RESPONSE)), (EpisodeOpened(seq, nid, kind, now.wall_ms),)\n    if ep is not None and my_edge and ep.kind == 'MAN_DOWN':\n        state, seq = next_seq(state)\n        return _put_episode(state, replace(ep, kind='MAYDAY', motion_state=None, move_since_mono=None, still_since_mono=None)), (EpisodeEscalated(seq, nid, 'MAN_DOWN', 'MAYDAY', now.wall_ms),)\n    return state, ()\n\ndef _man_down_label(state, nid, d, now):\n    \"\"\"Spec 7: chest movement above STILL_G for mandown_move_label_s changes the label to movement_detected; mandown_still_revert_s of renewed stillness reverts it.\n    Fresh frames only (the caller checks); card, siren and level never change. MAYDAY has no label.\"\"\"\n    ep = state.episodes.get(nid)\n    if ep is None or ep.kind != 'MAN_DOWN': return state, ()\n    mono, moving = now.mono_ms, d['motion_x100'] / 100 > K.STILL_G_DEFAULT\n    mv, st, label = ep.move_since_mono, ep.still_since_mono, ep.motion_state\n    if label == NO_RESPONSE:\n        mv, st = ((mono if mv is None else mv) if moving else None), None\n        if mv is not None and mono - mv >= K.MANDOWN_MOVE_LABEL_S * 1000: label, mv = MOVEMENT_DETECTED, None\n    else:\n        st, mv = ((mono if st is None else st) if not moving else None), None\n        if st is not None and mono - st >= K.MANDOWN_STILL_REVERT_S * 1000: label, st = NO_RESPONSE, None\n    new = replace(ep, motion_state=label, move_since_mono=mv, still_since_mono=st)\n    if new == ep: return state, ()\n    state = _put_episode(state, new)\n    if label == ep.motion_state: return state, ()\n    state, seq = next_seq(state)\n    return state, (EpisodeLabelChanged(seq, nid, label, now.wall_ms),)\n\ndef _ack_row(state, nid, type, operator_id, now):\n    row = state.alerts.get((nid, type))\n    if row is None or row.acknowledged_ts is not None: return state, ()\n    state, seq = next_seq(state)\n    return replace(state, alerts={**state.alerts, (nid, type): replace(row, acknowledged_ts=now.wall_ms)}), (AlertAcknowledged(seq, nid, type, row.event_seq, operator_id, now.wall_ms),)\n\ndef operator_step(state, event, now):\n    \"\"\"Acknowledge and Resolve. Acknowledge sets acknowledged_ts and never clears a row, except unauth_alert, which closes with it (14.1b, GV-10).\n    Resolve is the only way an episode ends; it also clears the episode's man_down and mayday rows. A latch still set on the jacket stays a level, not an edge.\"\"\"\n    nid = event.node_id\n    _check_alert(nid, getattr(event, 'type', 'man_down'))\n    ep = state.episodes.get(nid)\n    if isinstance(event, AckAlertEvent):\n        state, fx = _ack_row(state, nid, event.type, event.operator_id, now)\n        if event.type == 'unauth_alert' and (nid, 'unauth_alert') in state.alerts:\n            state, more = clear_alert(state, nid, 'unauth_alert', now, 'acknowledged'); fx += more\n            if nid in state.nodes: state = replace(state, nodes={**state.nodes, nid: replace(state.nodes[nid], unauth_count=0)})\n        return state, fx\n    if isinstance(event, AckEpisodeEvent):\n        if ep is None or ep.state == 'ACKNOWLEDGED': return state, ()\n        state, seq = next_seq(state); fx = (EpisodeAcknowledged(seq, nid, event.operator_id, now.wall_ms),)\n        state = _put_episode(state, replace(ep, state='ACKNOWLEDGED', acknowledged_ts=now.wall_ms, acknowledged_by=event.operator_id))\n        for t in EPISODE_ALERT_TYPES: state, more = _ack_row(state, nid, t, event.operator_id, now); fx += more\n        return state, fx\n    if event.reason not in RESOLVE_REASONS or event.operator_id is None: raise ValueError('Resolve needs a reason from RESOLVE_REASONS and an operator')\n    if ep is None: return state, ()\n    state, seq = next_seq(state); fx = (EpisodeResolved(seq, nid, ep.kind, event.reason, event.operator_id, now.wall_ms),)\n    state = replace(state, episodes={k: v for k, v in state.episodes.items() if k != nid})\n    for t in EPISODE_ALERT_TYPES: state, more = clear_alert(state, nid, t, now, 'resolved'); fx += more\n    latched = state.nodes.get(nid, NodeState()).mandown_prev          # the jacket latch is cleared only by the jacket CANCEL: until a frame says so the node still reports DANGER\n    return refresh_level(state, nid, 2 if latched else 0, False), fx\n\nRULES = (co_state_rule");
  replace(RE, "    if isinstance(event, TickEvent): return _run_rules(state, event, now, FULL)\n    raise TypeError(", "    if isinstance(event, TickEvent): return _run_rules(state, event, now, FULL)\n    if isinstance(event, (AckAlertEvent, AckEpisodeEvent, ResolveEpisodeEvent)): return operator_step(state, event, now)   # P7c-1: operator actions\n    raise TypeError(");
  replace(GV, "e.node_id, e.type, e.level) for e in fx]\n\ndef run_case", "e.node_id, e.type, e.level) if isinstance(e, ChangeAlertLevel) else (type(e).__name__, e.node_id, None, None) for e in fx]   # P7c-1: episode effects project as (class name, node, None, None)\n\ndef run_case");
  replace(GV, "    {'id': 'GV-02', 'gv': 'GV-02 (alert half)', 'desc': 'F-02: node 1, flags 0x06 (mandown, DANGER): raises man_down DANGER and no node_danger; the episode half is P7c',\n     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'man_down', 'DANGER')], 'open': [(1, 'man_down', 'DANGER')], 'seq_delta': 1, 'levels': {1: 'DANGER'}}}]},", "    {'id': 'GV-02', 'gv': 'GV-02', 'desc': 'F-02: node 1, flags 0x06 (mandown, DANGER): raises man_down DANGER and no node_danger; the episode opens before the alert row (P7c-1)',\n     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'open': [(1, 'man_down', 'DANGER')], 'episodes': 1, 'seq_delta': 2, 'levels': {1: 'DANGER'}}}]},");
  replace(GV, "    {'id': 'GV-03', 'gv': 'GV-03 (alert half)', 'desc': 'F-03 with an open man_down: status4 MAYDAY raises mayday DANGER; the episode upgrade is P7c',\n     'open': [(1, 'man_down', 'DANGER')],\n     'steps': [{'frame': 'F-03', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('raise', 1, 'mayday', 'DANGER')], 'open': [(1, 'man_down', 'DANGER'), (1, 'mayday', 'DANGER')], 'seq_delta': 1, 'levels': {1: 'DANGER'}}}]},", "    {'id': 'GV-03', 'gv': 'GV-03', 'desc': 'F-02 then F-03 (status4 MAYDAY, latch still set): the open MAN_DOWN episode is upgraded in place to MAYDAY (EpisodeEscalated, one episode) and mayday is raised DANGER',\n     'steps': [{'frame': 'F-02', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('EpisodeOpened', 1, None, None), ('raise', 1, 'man_down', 'DANGER')], 'episodes': 1}},\n               {'frame': 'F-03', 'seq_class': 'fresh', 'dt_ms': 2000, 'expect': {'effects': [('EpisodeEscalated', 1, None, None), ('raise', 1, 'mayday', 'DANGER')], 'open': [(1, 'man_down', 'DANGER'), (1, 'mayday', 'DANGER')], 'episodes': 1, 'seq_delta': 2, 'levels': {1: 'DANGER'}}}]},");
  replace(MD_T, "def tys(fx): return [(type(x).__name__, x.type, getattr(x, 'level', None)) for x in fx]", "def tys(fx): return [(type(x).__name__, x.type, getattr(x, 'level', None)) for x in fx if hasattr(x, 'type')]   # P7c-1: alert effects only; the episode effects are checked in test_episodes.py");
  replace(MD_T, "and al(e, 'node_danger') is None and e.state.episodes == {}", "and al(e, 'node_danger') is None and len(e.state.episodes) == 1   # P7c-1: the latch now opens the episode (details in test_episodes.py)");
  replace(MD_T, "('ClearAlert', 'node_danger', None)] and fx[1].reason == 'mandown'", "('ClearAlert', 'node_danger', None)] and fx[2].reason == 'mandown'   # fx[0] is the EpisodeOpened of P7c-1");
  append('docs/PROGRESS.md', "- Part 7c-1 done: episode lifecycle in core/rule_engine.py (Episode, EpisodeOpened/Escalated/LabelChanged/Acknowledged/Resolved and AlertAcknowledged effects; AckAlertEvent, AckEpisodeEvent, ResolveEpisodeEvent through step; one active episode per node; MAN_DOWN to MAYDAY upgrade; Resolve is the only close; Acknowledge closes only unauth_alert; MAN_DOWN label 5 s / 15 s), host/tests/test_episodes.py (GV-02, GV-03, GV-10, GV-20); harness GV-02 and GV-03 now check the episode; test_man_down.py filters episode effects out of its alert checks");
}
