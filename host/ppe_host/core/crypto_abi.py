"""core/crypto_abi.py: frame and beacon codec (design 14.4, Rev 3.45). Pure functions: no file, serial, network, audio or clock access.
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
