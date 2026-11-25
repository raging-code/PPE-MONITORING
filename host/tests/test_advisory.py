"""P9: core/advisory.py (design 14.3). The table is compared with docs/design/s14-3.md row by row; cadence, change rows, heartbeat, quality and
rebuild mode are tested with the real engine in front of advisory_step. window_s is a module constant (docs/adr/0001.md)."""
import json, re
from pathlib import Path
import pytest
from ppe_host.clock import FakeClock
from ppe_host.core import advisory as adv
from ppe_host.core.advisory import (ADVISORY_EVAL_S, ADVISORY_WINDOW_S, RISKS, TABLE, AdvisoryConfig, AdvisoryRow, AdvisoryState, advise, advisory_step, quality_of)
from ppe_host.core.rule_engine import EngineState, FrameEvent, NodeState, OpenAlert, TickEvent, step
from test_co_state import BASE

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = json.loads((ROOT / 'host' / 'config' / 'settings.json').read_text(encoding='utf8'))
CFG = AdvisoryConfig(heartbeat_s=SETTINGS['advisory_heartbeat_s'])
BEAT_MS = CFG.heartbeat_s * 1000

def frame(node=1, seq_class='fresh', verify='OK', flags=0, co_x10=0, **kw):
    d = dict(BASE); d.update(flags=flags, co_x10=co_x10, id_mode=0x40 | node, **kw)
    return FrameEvent(node, verify, seq_class, d)

class Drv:
    """Real engine, then advisory_step with the same event and time, on a FakeClock."""
    def __init__(self, cfg=CFG): self.clock, self.s, self.a, self.cfg, self.rows = FakeClock(1_700_000_000_000, 10_000), EngineState(), AdvisoryState(), cfg, []
    def go(self, event, dt_ms=2000):
        self.clock.advance(dt_ms); now = self.clock.now()
        self.s, _ = step(self.s, event, now); self.s, self.a, fx = advisory_step(self.s, self.a, event, now, self.cfg); self.rows += fx; return fx
    def frames(self, n, **kw):
        out = ()
        for _ in range(n): out += self.go(frame(**kw))
        return out

# ---- the table (14.3) ----
def design_rows():
    out = []
    for line in (ROOT / 'docs' / 'design' / 's14-3.md').read_text(encoding='utf8').splitlines():
        c = [x.strip() for x in line.strip().strip('|').split('|')]
        if len(c) == 4 and c[0] in ('DANGER', 'WARNING', 'NORMAL'): out.append((c[0], None if 'fallback' in c[1] else frozenset(c[1].split(' or ')), c[2], c[3]))
    return out

def test_table_equals_the_design_text_in_order():
    rows = design_rows()
    assert rows[-1] == ('NORMAL', frozenset(('none (healthy)',)), 'NOMINAL', adv.NOMINAL_ACTION) or rows[-1][0] == 'NORMAL' and rows[-1][2:] == ('NOMINAL', adv.NOMINAL_ACTION)
    assert tuple(rows[:-1]) == TABLE and len(TABLE) == 9

def test_risk_labels_equal_the_ddl_check():
    sql = (ROOT / 'host' / 'migrations' / '0001.sql').read_text(encoding='utf8')
    assert set(RISKS) == set(re.findall(r"'(\w+)'", re.search(r"source <> 'table' OR risk IN \((.*?)\)", sql).group(1)))

@pytest.mark.parametrize('level,reasons,risk', [
    ('DANGER', {'mayday'}, 'CRITICAL_LIFE_SAFETY'), ('DANGER', {'man_down'}, 'CRITICAL_LIFE_SAFETY'), ('DANGER', {'mayday', 'co_threshold', 'link_lost'}, 'CRITICAL_LIFE_SAFETY'),
    ('DANGER', {'co_threshold'}, 'TOXIC_ATMOSPHERE'), ('DANGER', {'scba_expired', 'sensor_fault'}, 'TOXIC_ATMOSPHERE'), ('DANGER', {'link_lost'}, 'COMMS_LOSS_ADVERSE'),
    ('DANGER', {'link_lost', 'sensor_fault'}, 'COMMS_LOSS_ADVERSE'), ('DANGER', {'sensor_fault'}, 'DEGRADED_TELEMETRY'), ('DANGER', {'node_danger'}, 'DEGRADED_TELEMETRY'),
    ('DANGER', set(), 'DEGRADED_TELEMETRY'), ('DANGER', {'heat', 'checkin'}, 'DEGRADED_TELEMETRY'),
    ('WARNING', {'co_threshold'}, 'ELEVATED_EXPOSURE'), ('WARNING', {'heat', 'sensor_fault'}, 'ELEVATED_EXPOSURE'), ('WARNING', {'sensor_fault'}, 'DEGRADED_TELEMETRY'),
    ('WARNING', {'signal_lost'}, 'DEGRADED_TELEMETRY'), ('WARNING', {'battery_low'}, 'DEGRADED_TELEMETRY'), ('WARNING', {'checkin'}, 'DEGRADED_TELEMETRY'),
    ('WARNING', {'mayday'}, 'DEGRADED_TELEMETRY'), ('WARNING', set(), 'DEGRADED_TELEMETRY'), ('NORMAL', set(), 'NOMINAL'), ('NORMAL', {'heat'}, 'NOMINAL')])
def test_first_match_from_the_top_wins(level, reasons, risk):
    assert advise(level, reasons)[0] == risk

def test_checkin_row_has_its_own_text_and_a_battery_row_beats_it():
    assert advise('WARNING', {'checkin'})[1] == 'Responder has not answered the stillness prompt: confirm by voice radio now.'
    assert advise('WARNING', {'checkin', 'battery_low'})[1] == 'Confirm responder status by voice radio; plan battery/unit swap.'
    assert advise('WARNING', {'unauth_alert'})[1] == 'Confirm responder status by voice radio.'

def test_unknown_level_is_refused():
    with pytest.raises(ValueError): advise('NONE', set())

# ---- quality (14.3, Rev 3.28): 30 frames fill the 60 s window at the 2 s period ----
@pytest.mark.parametrize('fault,count,q', [(False, 30, 'high'), (False, 24, 'high'), (False, 23, 'medium'), (False, 15, 'medium'), (False, 14, 'low'), (False, 0, 'low'),
                                          (True, 30, 'low'), (True, 24, 'low')])
def test_quality_boundaries(fault, count, q): assert quality_of(fault, count, CFG) == q

def test_window_and_cadence_constants_and_the_adr():
    assert (ADVISORY_WINDOW_S, ADVISORY_EVAL_S, CFG.window_s, CFG.heartbeat_s) == (60, 30, 60, 300)
    adr = (ROOT / 'docs' / 'adr' / '0001.md').read_text(encoding='utf8')
    assert 'window_s' in adr and '60' in adr
    with pytest.raises(TypeError): AdvisoryConfig()      # the heartbeat comes from settings, never from a default

# ---- rows: on change, plus the heartbeat ----
def test_first_frame_writes_one_nominal_row_with_low_quality_and_the_window():
    d = Drv(); (r,) = d.frames(1)
    assert (r.node_id, r.risk, r.reasons, r.action, r.source, r.passage_ids, r.quality, r.window_s, r.heartbeat) == (1, 'NOMINAL', 'none', adv.NOMINAL_ACTION, 'table', None, 'low', 60, False)
    assert r.ts == d.clock.wall_ms() and r.event_seq == d.s.event_seq

def test_no_row_while_the_risk_is_unchanged_then_one_heartbeat_row_at_300_s():
    d = Drv(); d.frames(1)
    assert d.frames(149) == () and len(d.rows) == 1                  # 298 s after the first frame: evaluated at 30 s steps, nothing written
    (hb,) = d.frames(1)                                              # 300 s
    assert hb.heartbeat and hb.risk == 'NOMINAL' and hb.quality == 'high' and len(d.rows) == 2
    assert d.frames(149) == () and d.frames(1)[0].heartbeat           # and one every 300 s after that

def test_a_level_transition_writes_its_row_at_once_not_at_the_next_30_s_evaluation():
    d = Drv(); d.frames(1)
    (up,) = d.frames(1, co_x10=520, flags=1)                         # 2 s later: CO 52 ppm raises co_threshold WARNING
    assert (up.risk, up.reasons) == ('ELEVATED_EXPOSURE', 'co_threshold')
    (dn,) = [r for r in d.frames(8, co_x10=0, flags=0) if r]         # the 10 s clear timer ends: back to NORMAL on that frame
    assert dn.risk == 'NOMINAL' and d.s.nodes[1].level == 'NORMAL'

def test_a_man_down_frame_gives_critical_life_safety():
    d = Drv(); d.frames(1); (r,) = d.frames(1, flags=0x06)
    assert (r.risk, r.reasons) == ('CRITICAL_LIFE_SAFETY', 'man_down') and r.action.startswith('Dispatch RIT')

def test_a_flags_only_warning_uses_the_fallback_row():
    d = Drv(); d.frames(1); (r,) = d.frames(1, flags=0x01)
    assert (r.risk, r.reasons, r.action) == ('DEGRADED_TELEMETRY', 'none', 'Confirm responder status by voice radio.')

def test_a_level_change_with_the_same_risk_writes_no_row():
    oa = lambda t, lv: {(1, t): OpenAlert(1, t, lv, 1, 0, '')}
    s = EngineState(event_seq=1, nodes={1: NodeState(level='WARNING')}, alerts=oa('battery_low', 'WARNING')); a = AdvisoryState()
    clock = FakeClock(1_000_000, 10_000)
    s, a, fx = advisory_step(s, a, TickEvent(), clock.now(), CFG); assert [r.risk for r in fx] == ['DEGRADED_TELEMETRY']
    clock.advance(1000)
    s = EngineState(event_seq=s.event_seq, nodes={1: NodeState(level='DANGER')}, alerts=oa('sensor_fault', 'DANGER'))
    s, a, fx = advisory_step(s, a, TickEvent(), clock.now(), CFG); assert fx == () and a.nodes[1].last_level == 'DANGER'

def test_a_silent_node_is_still_evaluated_on_ticks_and_nodes_get_rows_in_node_order():
    d = Drv(); d.go(frame(node=2)); d.go(frame(node=1)); assert [r.node_id for r in d.rows] == [2, 1]
    for _ in range(151): d.go(TickEvent(), 2000)                       # ticks only: sensor_fault (WARNING) then link_lost (DANGER at 60 s) change the risk
    assert [(r.node_id, r.risk) for r in d.rows[2:]] == [(2, 'DEGRADED_TELEMETRY'), (1, 'DEGRADED_TELEMETRY'), (2, 'COMMS_LOSS_ADVERSE'), (1, 'COMMS_LOSS_ADVERSE')]
    for _ in range(150): d.go(TickEvent(), 2000)                       # 2 s ticks drift off the 30 s steps; the heartbeat still comes on time, node by node
    assert [(r.node_id, r.risk, r.heartbeat) for r in d.rows[6:]] == [(2, 'COMMS_LOSS_ADVERSE', True), (1, 'COMMS_LOSS_ADVERSE', True)]
    assert [r.event_seq for r in d.rows] == sorted(r.event_seq for r in d.rows) and len({r.event_seq for r in d.rows}) == len(d.rows)

def test_a_fault_makes_quality_low_even_with_a_full_window():
    d = Drv(); d.frames(30)
    (r,) = d.frames(1, flags=0x09, status2=0x10, co_x10=0)          # CO fault + WARNING: sensor_fault opens
    assert r.reasons == 'sensor_fault' and r.quality == 'low'

def test_only_evaluated_frames_count_toward_coverage():
    d = Drv(); d.frames(1)
    for sc, vf in (('suspect', 'OK'), ('duplicate', 'OK'), ('fresh', 'BAD_MAC'), ('fresh', 'BAD_CRC')): d.go(frame(seq_class=sc, verify=vf))
    assert len(d.a.nodes[1].frames) == 1
    d.go(frame(seq_class='reboot')); assert len(d.a.nodes[1].frames) == 2

def test_rebuild_mode_returns_the_same_state_and_no_rows():
    live, rb = Drv(), Drv()
    for i in range(160):
        e = frame(co_x10=520 if 20 <= i < 40 else 0, flags=1 if 20 <= i < 40 else 0)
        rb.clock.advance(2000); live.clock.advance(2000); now = live.clock.now()
        live.s, _ = step(live.s, e, now); live.s, live.a, fx = advisory_step(live.s, live.a, e, now, CFG); live.rows += fx
        rb.s, nfx = step(rb.s, e, now, rebuild=True); rb.s, rb.a, rfx = advisory_step(rb.s, rb.a, e, now, CFG, rebuild=True)
        assert nfx == () and rfx == ()
    assert live.rows and (rb.s, rb.a) == (live.s, live.a) and rb.s.event_seq == live.s.event_seq
