"""P2: shared/abi.json, tools/gen_abi.py and the generated ABI files (design 12.1).
Offsets, signedness and bit positions are checked against tools/test_vectors.py and frames.json, so the layout in abi.json,
the generated C/Python/TypeScript and the independent reference decoder must all agree. If an import fails, run: just gen"""
import copy, importlib.util, json, re, sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[2]
def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / f'{name}.py'); m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m; spec.loader.exec_module(m); return m
gen, tv = _load('gen_abi'), _load('test_vectors')
try: from ppe_host import abi
except ImportError as e: raise RuntimeError('host/ppe_host/abi.py is missing: run just gen first') from e
A = json.loads((ROOT / 'shared' / 'abi.json').read_text(encoding='utf8'))
OK_FRAMES = [bytes.fromhex(f['hex']) for f in tv.D['frames'] if f['expect']['result'] != 'BAD_LEN']
def field(b, name, table=None):
    o, n, signed = (table or abi.FRAME_FIELDS)[name]
    return int.from_bytes(b[o:o + n], 'little', signed=signed)
def bit(b, fld, name):
    sh, w = abi.BITS[fld][name]; return (field(b, fld) >> sh) & ((1 << w) - 1)
def test_generated_files_are_current():
    for rel, text in gen.render_all(A).items():
        p = ROOT / rel
        assert p.exists(), f'{rel} missing: run just gen'
        assert p.read_bytes().decode('utf8') == text, f'{rel} is stale: run just gen'
def test_frame_offsets_match_reference_decoder():
    assert abi.FRAME_BYTES == 23 and abi.CRC8_POLY == 7 and len(OK_FRAMES) == 22
    for b in OK_FRAMES:
        ref = tv.decode(b)
        for k in ('seq', 'co_x10', 'temp_x100', 'hum', 'hr', 'motion_x100', 'bat', 'status2', 'flags', 'id_mode', 'uptime_s', 'status3', 'status4', 'boot_ctr'):
            assert field(b, k) == ref[k], (b.hex(), k)
        for k in ('scba_on', 'link_ok'): assert bit(b, 'id_mode', k) == ref[k]
        assert bit(b, 'id_mode', 'evt_unsent') == ref['evt_unsent'] and bit(b, 'id_mode', 'node_id') == b[12] & 7
def test_crc_and_mac_positions_on_valid_frames():
    a, z = abi.FRAME_CRC_RANGE
    for f in tv.D['frames']:
        b = bytes.fromhex(f['hex'])
        if f['expect']['result'] in ('OK', 'REJECT_ROSTER'):
            o, n, _ = abi.FRAME_FIELDS['mac4']
            assert tv.crc8(b[a:z]) == field(b, 'crc8') and tv.cmac(bytes([tv.D['sys_id']]) + b[a:z])[:4] == b[o:o + n]
def test_temperature_is_signed():
    f24 = next(bytes.fromhex(f['hex']) for f in tv.D['frames'] if f['id'] == 'F-24')
    assert abi.FRAME_FIELDS['temp_x100'] == (4, 2, True) and field(f24, 'temp_x100') == -500
    assert 'temp_x100: { offset: 4, size: 2, signed: true }' in (ROOT / gen.OUT['ts']).read_text(encoding='utf8')
    assert 'ABI_FRAME_TEMP_X100_SIGNED = 1' in (ROOT / gen.OUT['c']).read_text(encoding='utf8')
def test_beacon_layout_matches_reference():
    for bc in tv.D['beacons']:
        b = bytes.fromhex(bc['hex']); a, z = abi.BEACON_CRC_RANGE
        assert len(b) == abi.BEACON_BYTES and field(b, 'sys_id', abi.BEACON_FIELDS) == tv.D['sys_id']
        assert field(b, 'abi_ver', abi.BEACON_FIELDS) == bc['expect']['abi_ver'] and field(b, 'crc8', abi.BEACON_FIELDS) == (tv.crc8(b[a:z]) if bc['id'] != 'B-02' else b[8])
        if bc['id'] == 'B-01': assert [field(b, k, abi.BEACON_FIELDS) for k in ('base_id', 'beacon_seq', 'heard_mask', 'ack1')] == [1, 10, 2, 100] and abi.BEACON_ABI_VER == 3
def test_bit_positions_match_technical_summary():
    want = {'id_mode': {'node_id': (0, 3), 'scba_on': (3, 1), 'posture': (4, 2), 'link_ok': (6, 1), 'evt_unsent': (7, 1)},
            'flags': {'node_level': (0, 2), 'mandown': (2, 1), 'fault': (3, 1), 'co_sat': (4, 1), 'activity': (5, 2), 'checkin': (7, 1)},
            'status2': {'hr_ok': (0, 1), 'wrist_ok': (1, 1), 'bat_low': (2, 1), 'reboot_hint': (3, 1), 'co_fault': (4, 1), 'imu_fault': (5, 1), 'temp_fault': (6, 1), 'cancel_ack': (7, 1)},
            'status3': {'btn_stuck': (0, 1), 'clear_armed': (1, 1), 'co_warmup': (2, 1), 'scba_expired': (3, 1), 'restored': (4, 1), 'reset_cause': (5, 2), 'still_now': (7, 1)},
            'status4': {'wrist_conn_open': (0, 1), 'latch_restored': (1, 1), 'mayday': (4, 1)}}
    assert abi.BITS == want and abi.RESERVED_MASK == {'status4': 0xEC} and abi.ENUMS['node_level']['INVALID'] == 3
def test_c_header_matches_json():
    c = {k: int(v, 0) for k, v in re.findall(r'(ABI_\w+) = (0x[0-9A-Fa-f]+|\d+)', (ROOT / gen.OUT['c']).read_text(encoding='utf8'))}
    assert c['ABI_FRAME_BYTES'] == 23 and c['ABI_BEACON_BYTES'] == 13 and c['ABI_FRAME_MAC4_OFF'] == 19 and c['ABI_BEACON_MAC4_OFF'] == 9
    for k, (o, n, s) in abi.FRAME_FIELDS.items(): assert (c[f'ABI_FRAME_{k.upper()}_OFF'], c[f'ABI_FRAME_{k.upper()}_SIZE'], c[f'ABI_FRAME_{k.upper()}_SIGNED']) == (o, n, int(s))
    for fl, d in abi.BITS.items():
        for k, (sh, w) in d.items(): assert (c[f'ABI_{fl.upper()}_{k.upper()}_SHIFT'], c[f'ABI_{fl.upper()}_{k.upper()}_MASK']) == (sh, ((1 << w) - 1) << sh)
    assert c['ABI_STATUS4_RESERVED_MASK'] == 0xEC and c['ABI_STATUS4_MAYDAY_MASK'] == 0x10
@pytest.mark.parametrize('mutate', [lambda a: a['frame']['fields'][3].update(offset=7), lambda a: a['frame'].update(bytes=24), lambda a: a['bits']['flags'].append(['x', 4, 1]),
    lambda a: a['bits']['status4'].append(['x', 8, 1]), lambda a: a['enums']['posture'].update(BAD=4), lambda a: a['enums'].update(nobits={'A': 0}), lambda a: a['frame']['fields'][0].update(size=3)])
def test_validator_rejects_broken_layouts(mutate):
    bad = copy.deepcopy(A); mutate(bad)
    with pytest.raises(ValueError): gen.validate(bad)
def test_valid_layout_passes_and_is_deterministic():
    gen.validate(A); assert gen.render_all(A) == gen.render_all(copy.deepcopy(A))
