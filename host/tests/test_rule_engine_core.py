"""P5: rule engine skeleton (core/rule_engine.py) and the injected clock (clock.py), design 14.1 and 14.6.
Covers the 14.1 evaluation gate, strictly increasing event_seq, one open alert per node and type, purity (no mutation, same inputs
give same outputs), the rule registry order, the core import rule and FakeClock."""
import ast, copy, json, re
from pathlib import Path
import pytest
from ppe_host import abi
from ppe_host.clock import FakeClock, now_of
from ppe_host.core import rule_engine as re_
from ppe_host.core import crypto_abi as ca
from ppe_host.core.rule_engine import (ALERT_TYPES, EngineState, FrameEvent, Now, TickEvent, clear_alert, eval_mode, next_seq,
                                       open_alert, raise_alert, step)

ROOT = Path(__file__).resolve().parents[2]
VEC = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
F01 = ca.decode_frame(bytes.fromhex(next(f['hex'] for f in VEC['frames'] if f['id'] == 'F-01')))
T0 = Now(1_000_000, 5_000)

def ev(verify='OK', seq_class='fresh', flags=None, node=1, decoded=True):
    d = dict(F01) if decoded else None
    if d is not None and flags is not None: d['flags'] = flags
    return FrameEvent(node, verify, seq_class, d)

def test_alert_types_match_catalog_and_migration():
    cat = json.loads((ROOT / 'shared' / 'alert_catalog.json').read_text(encoding='utf8'))
    sql = (ROOT / 'host' / 'migrations' / '0001.sql').read_text(encoding='utf8')
    seeded = set(re.findall(r"'(\w+)'", re.search(r'INSERT INTO alert_types\(type\) VALUES (.*?);', sql).group(1)))
    assert ALERT_TYPES == {e['type'] for e in cat if e['owner'] == 'alerts'} == seeded and len(ALERT_TYPES) == 25

@pytest.mark.parametrize('verify,seq_class,flags,decoded,mode', [
    ('OK', 'fresh', None, True, 'full'), ('OK', 'reboot', None, True, 'full'), ('OK', 'suspect', None, True, 'raise_only'),
    ('OK', 'duplicate', None, True, 'none'), ('BAD_MAC', 'fresh', None, True, 'none'), ('BAD_CRC', 'suspect', None, True, 'none'),
    ('BAD_LEN', 'fresh', None, False, 'none'), ('OK', 'fresh', 0x03, True, 'none'), ('OK', 'suspect', 0x03, True, 'none'),
    ('OK', 'fresh', 0x02, True, 'full'), ('OK', 'suspect', 0x06, True, 'raise_only')])
def test_eval_gate(verify, seq_class, flags, decoded, mode):
    assert eval_mode(ev(verify, seq_class, flags, decoded=decoded)) == mode

@pytest.mark.parametrize('verify,seq_class', [('REJECT_ROSTER', 'fresh'), ('ok', 'fresh'), ('OK', 'stale'), ('OK', None)])
def test_eval_gate_rejects_unknown_values(verify, seq_class):
    with pytest.raises(ValueError): eval_mode(ev(verify, seq_class))

def test_step_without_rules_changes_nothing(monkeypatch):
    monkeypatch.setattr(re_, 'RULES', ())   # P6a registers the first rule, so 'no rules' is set up here
    s = EngineState()
    for e in (ev(), ev('OK', 'suspect'), ev('BAD_MAC'), TickEvent()):
        s2, fx = step(s, e, T0); assert s2 is s and fx == ()
    with pytest.raises(TypeError): step(s, 'frame', T0)
    with pytest.raises(TypeError): step(s, ev(), (1, 2))

def test_event_seq_strictly_increasing_and_never_reset():
    s, seqs = EngineState(), []
    for _ in range(5): s, q = next_seq(s); seqs.append(q)
    assert seqs == [1, 2, 3, 4, 5] and s.event_seq == 5
    s, fx1 = raise_alert(s, 1, 'co_threshold', 'WARNING', 'r', T0); s, fx2 = clear_alert(s, 1, 'co_threshold', T0, 'x')
    s, fx3 = raise_alert(s, 1, 'co_threshold', 'WARNING', 'r', T0)
    assert [fx1[0].event_seq, fx2[0].event_seq, fx3[0].event_seq] == [6, 7, 8]

def test_one_open_alert_per_node_and_type():
    s, fx = raise_alert(EngineState(), 1, 'man_down', 'DANGER', 'a', T0)
    assert len(fx) == 1 and fx[0].type == 'man_down' and fx[0].raised_ts == T0.wall_ms and open_alert(s, 1, 'man_down').event_seq == 1
    s2, fx2 = raise_alert(s, 1, 'man_down', 'DANGER', 'again', T0)
    assert s2 is s and fx2 == () and s2.event_seq == 1                         # no second row, no event_seq used
    s3, fx3 = raise_alert(s2, 2, 'man_down', 'DANGER', 'b', T0); s3, fx4 = raise_alert(s3, 1, 'mayday', 'DANGER', 'c', T0)
    assert len(fx3) == 1 and len(fx4) == 1 and len(s3.alerts) == 3             # other node or other type is allowed
    s4, fx5 = clear_alert(s3, 1, 'man_down', T0, 'done')
    assert fx5[0].raised_event_seq == 1 and open_alert(s4, 1, 'man_down') is None and len(s4.alerts) == 2
    s5, fx6 = clear_alert(s4, 1, 'man_down', T0, 'again'); assert s5 is s4 and fx6 == ()  # nothing open: nothing to clear
    s6, fx7 = raise_alert(s4, 1, 'man_down', 'DANGER', 'new', T0); assert len(fx7) == 1 and open_alert(s6, 1, 'man_down').event_seq == s4.event_seq + 1

@pytest.mark.parametrize('node,type,level', [(1, 'nope', 'DANGER'), (1, 'man_down', 'HIGH'), ('1', 'man_down', 'DANGER'), (True, 'man_down', 'DANGER')])
def test_raise_alert_rejects_bad_arguments(node, type, level):
    with pytest.raises(ValueError): raise_alert(EngineState(), node, type, level, '', T0)

def test_purity_no_mutation_and_deterministic():
    def run():
        s, out = EngineState(), []
        for i, (n, t) in enumerate([(1, 'heat'), (2, 'heat'), (1, 'heat'), (3, 'checkin')]):
            s, fx = raise_alert(s, n, t, 'WARNING', f'r{i}', Now(10 + i, i)); out.append(fx)
            if i == 3: s, fx = clear_alert(s, 1, 'heat', Now(99, 99), 'end'); out.append(fx)
        return s, out
    a, b = run(), run()
    assert a == b                                                               # same inputs, same state and effects
    s0 = EngineState(); snap = copy.deepcopy(s0); raise_alert(s0, 1, 'heat', 'WARNING', 'r', T0)
    assert s0 == snap and s0.alerts == {}                                       # the input state is untouched

def test_rules_run_in_order_with_mode_and_concatenate_effects():
    calls = []
    def rule_a(state, event, now, mode): calls.append(('a', mode)); return raise_alert(state, 1, 'heat', 'WARNING', 'a', now)
    def rule_b(state, event, now, mode): calls.append(('b', mode)); return raise_alert(state, 1, 'checkin', 'WARNING', 'b', now)
    old = re_.RULES; re_.RULES = (rule_a, rule_b)
    try:
        s, fx = step(EngineState(), ev('OK', 'suspect'), T0)
        assert calls == [('a', 'raise_only'), ('b', 'raise_only')] and [x.type for x in fx] == ['heat', 'checkin'] and [x.event_seq for x in fx] == [1, 2]
        calls.clear(); s, fx = step(EngineState(), TickEvent(), T0); assert calls == [('a', 'full'), ('b', 'full')]
        calls.clear(); s, fx = step(EngineState(), ev('BAD_MAC'), T0); assert calls == [] and fx == ()   # the gate runs before any rule
        calls.clear(); s, fx = step(EngineState(), ev('OK', 'duplicate'), T0); assert calls == [] and fx == ()
    finally: re_.RULES = old

def test_core_import_rule():  # design 14.1 and the guide: core/ imports nothing from io/, services/ or api/ and does no I/O or clock access
    banned = {'time', 'datetime', 'os', 'pathlib', 'sys', 'socket', 'serial', 'sqlite3', 'subprocess', 'shutil', 'winsound', 'asyncio',
              'threading', 'urllib', 'http', 'requests', 'httpx', 'websockets', 'random', 'logging', 'tempfile', 'fastapi'}
    files = sorted((ROOT / 'host' / 'ppe_host' / 'core').glob('*.py')); assert any(f.name == 'rule_engine.py' for f in files)
    for f in files:
        for n in ast.walk(ast.parse(f.read_text(encoding='utf8'))):
            names = []
            if isinstance(n, ast.Import): names = [a.name for a in n.names]
            elif isinstance(n, ast.ImportFrom):
                mod = n.module or ''
                names = [('ppe_host.' + mod if n.level else mod)] if mod else ['ppe_host.' + a.name for a in n.names]
            for m in names:
                assert m.split('.')[0] not in banned, f'{f.name} imports {m}'
                assert not re.match(r'ppe_host\.(io|services|api)\b', m), f'{f.name} imports {m}'
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name): assert n.func.id not in ('open', 'print', 'input'), f'{f.name} calls {n.func.id}'

def test_fake_clock():
    c = FakeClock(1000, 50); assert (c.wall_ms(), c.mono_ms()) == (1000, 50) and c.now() == Now(1000, 50) == now_of(c)
    c.advance(250); assert (c.wall_ms(), c.mono_ms()) == (1250, 300)
    c.set_wall(5); assert (c.wall_ms(), c.mono_ms()) == (5, 300)               # an NTP step moves wall time only
    c.advance(0); assert c.mono_ms() == 300
    for bad in (-1, 1.5, True, '1'):
        with pytest.raises(ValueError): c.advance(bad)
    with pytest.raises(ValueError): FakeClock(-1, 0)
    assert FakeClock().now() == Now(0, 0)
