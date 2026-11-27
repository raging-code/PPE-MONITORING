"""P4: host codec (core/crypto_abi.py) against shared/vectors/frames.json (design 14.4, D1).
Every vector must give the listed result, node_id and decoded fields. The extra tests build frames with their own
CRC and CMAC code (not the codec's), so a shared bug cannot hide. Needs: pip install cryptography pytest"""
import ast, json
from pathlib import Path
import pytest
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.cmac import CMAC
from ppe_host.core import crypto_abi as ca

ROOT = Path(__file__).resolve().parents[2]
D = json.loads((ROOT / 'shared' / 'vectors' / 'frames.json').read_text(encoding='utf8'))
KEY, SYS = bytes.fromhex(D['key_hex']), D['sys_id']
WRONG_KEY, WRONG_SYS = bytes.fromhex(D['wrong_key_hex']), D['wrong_sys_id']
FRAMES = {f['id']: f for f in D['frames']}
BEACONS = {b['id']: b for b in D['beacons']}
F01, F20, B01 = (bytes.fromhex(FRAMES['F-01']['hex']), bytes.fromhex(FRAMES['F-20']['hex']), bytes.fromhex(BEACONS['B-01']['hex']))

def _crc(b):  # independent bitwise CRC-8, poly 0x07 init 0
    c = 0
    for x in b:
        c ^= x
        for _ in range(8): c = ((c << 1) ^ 7) & 255 if c & 128 else (c << 1) & 255
    return c
def _mac(data, key=KEY):
    m = CMAC(algorithms.AES(key)); m.update(data); return m.finalize()[:4]
def build(id_mode=0x41, key=KEY, sys_id=SYS):
    """F-01 with id_mode replaced, CRC and MAC recomputed."""
    b = bytearray(F01[:18]); b[12] = id_mode
    return bytes(b) + bytes([_crc(b)]) + _mac(bytes([sys_id]) + bytes(b), key)

def test_vector_file_shape():
    assert len(D['frames']) == 24 and len(D['beacons']) == 4  # 28 vectors

@pytest.mark.parametrize('fid', list(FRAMES))
def test_frame_vector(fid):
    f = FRAMES[fid]; r = ca.classify_frame(bytes.fromhex(f['hex']), KEY, SYS)
    assert r.result == f['expect']['result']
    if f['expect']['result'] == 'BAD_LEN': assert r.node_id is None and r.decoded is None
    else: assert r.node_id == f['expect']['node_id'] and r.decoded == f['expect']['decoded']

@pytest.mark.parametrize('bid', list(BEACONS))
def test_beacon_vector(bid):
    b = BEACONS[bid]; r = ca.classify_beacon(bytes.fromhex(b['hex']), KEY)
    assert (r.result, r.abi_ver) == (b['expect']['result'], b['expect']['abi_ver'])

def test_f24_temp_is_signed():
    r = ca.classify_frame(bytes.fromhex(FRAMES['F-24']['hex']), KEY, SYS)
    assert r.result == 'OK' and r.decoded['temp_x100'] == -500 and r.decoded['temp_x100'] != 65036
    assert ca.decode_frame(build())['temp_x100'] == 2500

@pytest.mark.parametrize('n', [0, 1, 17, 18, 19, 20, 22, 24, 46])
def test_bad_len_frames(n):
    r = ca.classify_frame((F01 * 3)[:n], KEY, SYS)
    assert r == ca.FrameResult('BAD_LEN', None, None) and ca.verify_frame((F01 * 3)[:n], KEY, SYS) == 'BAD_LEN'

@pytest.mark.parametrize('n', [0, 1, 8, 12, 14, 26])
def test_bad_len_beacons_are_rejected(n):
    r = ca.classify_beacon((B01 * 2)[:n], KEY)
    assert r.result == 'BAD_LEN' and r.abi_ver is None and r.decoded is None

@pytest.mark.parametrize('idm', [0x00, 0x40, 0x08, 0x48, 0x80, 0xC8, 0xF8])
def test_node_id_zero_is_reject_roster(idm):
    r = ca.classify_frame(build(idm), KEY, SYS)
    assert r.result == 'REJECT_ROSTER' and r.node_id == 0 and r.decoded['id_mode'] == idm
    assert ca.verify_frame(build(idm), KEY, SYS) == 'OK'  # CRC and MAC are fine; only the node id is not
    assert ca.classify_frame(F20, KEY, SYS).result == 'REJECT_ROSTER'

@pytest.mark.parametrize('node', range(1, 8))
def test_node_id_is_id_mode_low_three_bits(node):
    for high in (0x00, 0x08, 0x40, 0x80, 0xF8):
        r = ca.classify_frame(build(node | high), KEY, SYS)
        assert (r.result, r.node_id) == ('OK', node)  # roster membership (1 to 3) is a later part, not the codec

def test_id_mode_bits_decoded():
    d = ca.decode_frame(build(0xC9))  # node 1, scba_on, link_ok, evt_unsent
    assert (d['scba_on'], d['link_ok'], d['evt_unsent']) == (1, 1, 1)
    d = ca.decode_frame(build(0x41)); assert (d['scba_on'], d['link_ok'], d['evt_unsent']) == (0, 1, 0)

def test_wrong_key_and_sys_id_give_bad_mac():
    assert ca.classify_frame(F01, WRONG_KEY, SYS).result == 'BAD_MAC'
    assert ca.classify_frame(F01, KEY, WRONG_SYS).result == 'BAD_MAC'
    assert ca.classify_frame(build(key=WRONG_KEY), KEY, SYS).result == 'BAD_MAC'
    assert ca.classify_frame(build(sys_id=WRONG_SYS), KEY, SYS).result == 'BAD_MAC'
    assert ca.classify_beacon(B01, WRONG_KEY).result == 'BAD_MAC'

def test_check_order_len_then_crc_then_mac_then_roster():
    bad_both = bytearray(F01); bad_both[2] ^= 1; bad_both[22] ^= 1           # CRC and MAC both wrong
    assert ca.classify_frame(bytes(bad_both), KEY, SYS).result == 'BAD_CRC'
    bad_mac_node0 = bytearray(F20); bad_mac_node0[22] ^= 1                  # MAC wrong and node 0
    assert ca.classify_frame(bytes(bad_mac_node0), KEY, SYS).result == 'BAD_MAC'
    assert ca.classify_frame(F01 + b'\x00', KEY, SYS).result == 'BAD_LEN'

def test_every_single_bit_flip_is_rejected():
    for i in range(len(F01)):
        for bit in range(8):
            b = bytearray(F01); b[i] ^= 1 << bit
            assert ca.classify_frame(bytes(b), KEY, SYS).result in ('BAD_CRC', 'BAD_MAC'), (i, bit)
    for i in range(len(B01)):
        for bit in range(8):
            b = bytearray(B01); b[i] ^= 1 << bit
            assert ca.classify_beacon(bytes(b), KEY).result in ('BAD_CRC', 'BAD_MAC'), (i, bit)

def test_beacon_abi_ver_only_3_is_accepted():
    assert ca.classify_beacon(B01, KEY).result == 'OK'
    for v in (0, 1, 2, 4, 255):  # valid CRC and MAC, other abi_ver
        b = bytearray(B01[:9]); b[3] = v; b[8] = _crc(b[:8]); raw = bytes(b) + _mac(bytes(b[:8]))
        r = ca.classify_beacon(raw, KEY); assert (r.result, r.abi_ver) == ('IGNORE_ABI', v)
    d = ca.decode_beacon(B01)  # 5a 01 0a 03 02 64 00 00: sys_id, base_id, beacon_seq, abi_ver, heard_mask, ack1..ack3
    assert (d['sys_id'], d['base_id'], d['beacon_seq'], d['abi_ver'], d['heard_mask'], d['ack1'], d['ack2'], d['ack3']) == (90, 1, 10, 3, 2, 100, 0, 0)

def test_crc8_and_macs_match_independent_code():
    for raw in (bytes(range(18)), F01[:18], b'', b'\xff' * 18): assert ca.crc8(raw) == _crc(raw)
    assert ca.crc8(F01[:18]) == F01[18]

def test_bad_arguments_raise():
    with pytest.raises(TypeError): ca.classify_frame('64000802', KEY, SYS)
    with pytest.raises(ValueError): ca.classify_frame(F01, KEY[:15], SYS)
    with pytest.raises(ValueError): ca.classify_frame(F01, KEY, 256)
    with pytest.raises(ValueError): ca.classify_beacon(B01, b'')
    with pytest.raises(ValueError): ca.decode_frame(F01[:22])
    assert ca.classify_frame(bytearray(F01), KEY, SYS).result == 'OK' and ca.classify_frame(memoryview(F01), KEY, SYS).result == 'OK'

def test_core_import_rule_for_crypto_abi():  # design 14.1: core/ has no io/services/api and no clock, file, network or audio access
    tree = ast.parse((ROOT / 'host' / 'ppe_host' / 'core' / 'crypto_abi.py').read_text(encoding='utf8'))
    mods = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import): mods |= {a.name.split('.')[0] for a in n.names}
        if isinstance(n, ast.ImportFrom): mods.add(((n.module or '').split('.')[0]) or '.'.join(a.name for a in n.names))
    assert mods <= {'hmac', 'typing', 'cryptography', 'abi'}, mods
