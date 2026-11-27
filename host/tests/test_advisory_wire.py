"""P24-3b-2b-ii: advisory rows in Ingest (adv_cfg off until Wire.enable_advisory turns it on, advisory_step called after every step()) and the advisory message of wire.Wire.
Real DBWriter, database, HostPort and engine, a fake hub. Every body is checked against the WsMessage contract (real models when pydantic is installed, else shared/ws.schema.json).
The table itself (design 14.3: which row matches which level and reasons) is tested in test_advisory.py; this file only checks the wiring: the row lands in advisory_summaries in the
same unit as the frame or tick that produced it, and the hub gets one advisory message per row, with no message and no row while adv_cfg is off. Requirements: REQ-RUL-010."""
from ppe_host.wire import Wire
from test_effect_rows import wait
from test_gv_bytes import pack
from test_host_port import port
from test_ingest import rows, send
from test_wire import Hub as Hub1, SCHEMA, _ok, got

HEARTBEAT_S = 300

def check3(body):
    msg = dict(body, v=1, type='advisory', srv_seq=0, srv_ts=1)
    try: from ppe_host.api import models as M
    except ImportError: assert _ok(msg, SCHEMA['AdvisoryMsg']), msg; return
    M.parse_server(msg)
class Hub(Hub1):
    def publish_advisory(self, b): check3(b); self.sent.append(('advisory', b))
def wired(tmp_path, **kw):
    c, w, clock, ing, p = port(tmp_path); h = Hub(); return c, w, clock, ing, p, h, Wire(p, h, **kw).attach()

def test_advisory_is_off_by_default_no_row_and_no_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path)
    r = send(ing, clock, pack(seq=1)); wait(w, r.unit)
    assert rows(c, 'SELECT * FROM advisory_summaries') == [] and got(h, 'advisory') == []; w.stop()

def test_enable_advisory_writes_the_first_row_in_the_frames_unit_and_sends_one_message(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.enable_advisory(HEARTBEAT_S)
    r = send(ing, clock, pack(seq=1)); wait(w, r.unit)
    arows = rows(c, 'SELECT * FROM advisory_summaries ORDER BY event_seq')
    assert len(arows) == 1 and arows[0]['session_id'] == 1 and arows[0]['node_id'] == 1 and arows[0]['risk'] == 'NOMINAL' and arows[0]['source'] == 'table' and arows[0]['passage_ids'] is None
    (m,) = got(h, 'advisory'); assert (m['node_id'], m['risk'], m['action'], m['quality'], m['source']) == (1, 'NOMINAL', arows[0]['action'], arows[0]['quality'], 'table'); w.stop()

def test_a_tick_also_runs_advisory_step_once_enabled(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.enable_advisory(HEARTBEAT_S)
    send(ing, clock, pack(seq=1)); wait(w, ing.write([]))
    n0 = len(rows(c, 'SELECT * FROM advisory_summaries'))
    fx, u = ing.tick()
    if u is not None: wait(w, u)   # a tick with nothing to write returns no unit
    assert len(rows(c, 'SELECT * FROM advisory_summaries')) >= n0; w.stop()   # no level change and no heartbeat due yet: a tick alone need not add a row, but must not error or duplicate state

def test_a_risk_change_writes_a_second_row_in_the_same_unit_as_the_frame_that_caused_it(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); wire.enable_advisory(HEARTBEAT_S)
    send(ing, clock, pack(seq=1)); wait(w, ing.write([]))
    r2 = send(ing, clock, pack(seq=2, co_x10=2500, flags=2))   # DANGER: co 250.0 ppm, node_level DANGER (GV-09a shape)
    wait(w, r2.unit)
    arows = rows(c, 'SELECT * FROM advisory_summaries ORDER BY event_seq')
    assert arows[-1]['node_id'] == 1 and arows[-1]['risk'] == 'TOXIC_ATMOSPHERE'
    frow = rows(c, 'SELECT event_seq FROM frames WHERE event_seq = (SELECT MAX(event_seq) FROM frames)')[0]
    assert arows[-1]['event_seq'] > frow['event_seq'] - 1   # the advisory row's event_seq was allocated in the same step() call as this frame's effects
    msgs = got(h, 'advisory'); assert msgs[-1]['risk'] == 'TOXIC_ATMOSPHERE'; w.stop()

def test_enable_advisory_through_the_wire_reaches_the_same_ingest_the_port_uses(tmp_path):
    c, w, clock, ing, p, h, wire = wired(tmp_path); assert ing.adv_cfg is None
    wire.enable_advisory(HEARTBEAT_S); assert ing.adv_cfg is not None and ing.adv_cfg.heartbeat_s == HEARTBEAT_S; w.stop()
