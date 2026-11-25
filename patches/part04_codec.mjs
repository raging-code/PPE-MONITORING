// patches/part04_codec.mjs  (run from repo root: node patches/part04_codec.mjs [--dry] [--force])
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
  put('host/ppe_host/core/crypto_abi.py', String.raw`"""core/crypto_abi.py: frame and beacon codec (design 14.4, Rev 3.45). Pure functions: no file, serial, network, audio or clock access.
Layout comes from the generated ppe_host.abi (offsets, signedness, bit positions); the key and sys_id are passed in by the caller.
Check order for a frame: length, CRC-8, MAC, then node id (0 is REJECT_ROSTER). Decoded fields of a frame that failed a check are
returned for logging only (design 2.3 stores them as claimed); they are NOT authenticated and must never drive a rule."""
import hmac
from typing import NamedTuple, Optional
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.cmac import CMAC
from .. import abi

KEY_BYTES = 16
MAC_BYTES = 4
_TAGS = ('crc8', 'mac4')  # in the layout but not payload fields

class FrameResult(NamedTuple):
    result: str                  # OK | BAD_LEN | BAD_CRC | BAD_MAC | REJECT_ROSTER
    node_id: Optional[int]       # id_mode bits 0 to 2; None for BAD_LEN
    decoded: Optional[dict]      # all payload fields plus scba_on, link_ok, evt_unsent; None for BAD_LEN

class BeaconResult(NamedTuple):
    result: str                  # OK | BAD_LEN | BAD_CRC | BAD_MAC | IGNORE_ABI
    abi_ver: Optional[int]       # byte 3; None for BAD_LEN
    decoded: Optional[dict]      # all payload fields; None for BAD_LEN

def _raw(data):
    if not isinstance(data, (bytes, bytearray, memoryview)): raise TypeError('frame data must be bytes')
    return bytes(data)
def _key(key):
    if not isinstance(key, (bytes, bytearray)) or len(key) != KEY_BYTES: raise ValueError('key must be 16 bytes')
    return bytes(key)
def _sys_id(sys_id):
    if not isinstance(sys_id, int) or isinstance(sys_id, bool) or not 0 <= sys_id <= 255: raise ValueError('sys_id must be 0 to 255')
    return sys_id

def crc8(data):
    """CRC-8, polynomial and init from abi.json (0x07, 0), MSB first."""
    c = abi.CRC8_INIT
    for x in data:
        c ^= x
        for _ in range(8): c = ((c << 1) ^ abi.CRC8_POLY) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c

def _cmac4(key, data):
    m = CMAC(algorithms.AES(key)); m.update(data); return m.finalize()[:MAC_BYTES]
def _field(raw, name, table):
    o, n, signed = table[name]; return int.from_bytes(raw[o:o + n], 'little', signed=signed)
def _bits(value, field, name):
    shift, width = abi.BITS[field][name]; return (value >> shift) & ((1 << width) - 1)

def node_id_of(raw):
    """node_id = id_mode & 0x07 (0 is invalid). raw must be a full 23-byte frame."""
    return _bits(_field(raw, 'id_mode', abi.FRAME_FIELDS), 'id_mode', 'node_id')

def decode_frame(data):
    """Every payload field as an integer (temp_x100 is signed) plus scba_on, link_ok, evt_unsent. Does not verify anything."""
    raw = _raw(data)
    if len(raw) != abi.FRAME_BYTES: raise ValueError(f'frame must be {abi.FRAME_BYTES} bytes, got {len(raw)}')
    d = {n: _field(raw, n, abi.FRAME_FIELDS) for n in abi.FRAME_FIELDS if n not in _TAGS}
    for n in ('scba_on', 'link_ok', 'evt_unsent'): d[n] = _bits(d['id_mode'], 'id_mode', n)
    return d

def decode_beacon(data):
    raw = _raw(data)
    if len(raw) != abi.BEACON_BYTES: raise ValueError(f'beacon must be {abi.BEACON_BYTES} bytes, got {len(raw)}')
    return {n: _field(raw, n, abi.BEACON_FIELDS) for n in abi.BEACON_FIELDS if n not in _TAGS}

def _check(raw, size, rng, fields, mac_prefix, key):
    if len(raw) != size: return 'BAD_LEN'
    body = raw[rng[0]:rng[1]]
    if crc8(body) != raw[fields['crc8'][0]]: return 'BAD_CRC'
    mo = fields['mac4'][0]
    if not hmac.compare_digest(_cmac4(key, mac_prefix + body), raw[mo:mo + MAC_BYTES]): return 'BAD_MAC'
    return 'OK'

def verify_frame(data, key, sys_id):
    """OK | BAD_LEN | BAD_CRC | BAD_MAC (the frames.verify values). MAC = CMAC(key, sys_id || bytes 0-17)[:4]."""
    return _check(_raw(data), abi.FRAME_BYTES, abi.FRAME_CRC_RANGE, abi.FRAME_FIELDS, bytes([_sys_id(sys_id)]), _key(key))

def verify_beacon(data, key):
    """OK | BAD_LEN | BAD_CRC | BAD_MAC. MAC = CMAC(key, bytes 0-7)[:4] (no sys_id prefix)."""
    return _check(_raw(data), abi.BEACON_BYTES, abi.BEACON_CRC_RANGE, abi.BEACON_FIELDS, b'', _key(key))

def classify_frame(data, key, sys_id):
    raw = _raw(data)
    res = verify_frame(raw, key, sys_id)
    if res == 'BAD_LEN': return FrameResult(res, None, None)
    node = node_id_of(raw)
    if res == 'OK' and node == 0: res = 'REJECT_ROSTER'
    return FrameResult(res, node, decode_frame(raw))

def classify_beacon(data, key):
    raw = _raw(data)
    res = verify_beacon(raw, key)
    if res == 'BAD_LEN': return BeaconResult(res, None, None)
    ver = _field(raw, 'abi_ver', abi.BEACON_FIELDS)
    if res == 'OK' and ver != abi.BEACON_ABI_VER: res = 'IGNORE_ABI'
    return BeaconResult(res, ver, decode_beacon(raw))
`);
  put('host/tests/test_codec_vectors.py', String.raw`"""P4: host codec (core/crypto_abi.py) against shared/vectors/frames.json (design 14.4, D1).
Every vector must give the listed result, node_id and decoded fields. The extra tests build frames with their own
CRC and CMAC code (not the codec's), so a shared bug cannot hide. Needs: pip install cryptography pytest"""
import ast, json
from pathlib import Path
import pytest
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.cmac import CMAC
from ppe_host import abi
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
`);
  append('docs/PROGRESS.md', '- Part 4 done: host/ppe_host/core/crypto_abi.py (verify, classify, decode, signed temp), host/tests/test_codec_vectors.py (28 vectors, length, order and bit-flip tests)');
}
