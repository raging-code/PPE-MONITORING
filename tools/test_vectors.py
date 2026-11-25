#!/usr/bin/env python3
"""tools/test_vectors.py: independent check of shared/vectors/frames.json (Rev 3.45).
Recomputes length, CRC-8 (poly 0x07, init 0), AES-128-CMAC (frames: sys_id || bytes 0-17, first 4 bytes;
beacons: bytes 0-7 only) and decodes every field, then compares with the file's "expect" block.
Needs only the 'cryptography' package. Run: python tools/test_vectors.py [path/to/frames.json]  (default shared/vectors/frames.json; exit 1 on any mismatch)
Also usable with pytest: each check is a test_* function. This proves the vectors match the byte layout below,
which is the layout of the Technical Summary frame table as read in Rev 3.42; it does not prove the layout itself."""
import json, sys, os
from cryptography.hazmat.primitives.cmac import CMAC
from cryptography.hazmat.primitives.ciphers import algorithms
PATH = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith('.json') else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'shared', 'vectors', 'frames.json')  # repo default (P1): shared/vectors/frames.json
D = json.load(open(PATH, encoding='utf8'))
KEY = bytes.fromhex(D['key_hex'])
def crc8(b):
    c = 0
    for x in b:
        c ^= x
        for _ in range(8): c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    return c
def cmac(data):
    m = CMAC(algorithms.AES(KEY)); m.update(data); return m.finalize()
def decode(b):
    u16 = lambda i: b[i] | (b[i + 1] << 8)
    i16 = lambda i: u16(i) - 65536 if u16(i) & 0x8000 else u16(i)  # Rev 3.45: temp is a signed 16-bit value (Technical Summary: i16, C x100)
    idm = b[12]
    return {'seq': u16(0), 'co_x10': u16(2), 'temp_x100': i16(4), 'hum': b[6], 'hr': b[7], 'motion_x100': b[8], 'bat': b[9],
            'status2': b[10], 'flags': b[11], 'id_mode': idm, 'uptime_s': u16(13), 'status3': b[15], 'status4': b[16], 'boot_ctr': b[17],
            'scba_on': (idm >> 3) & 1, 'link_ok': (idm >> 6) & 1, 'evt_unsent': (idm >> 7) & 1}
def classify_frame(b):
    if len(b) != 23: return 'BAD_LEN', None, None
    node = b[12] & 0x07
    if crc8(b[:18]) != b[18]: res = 'BAD_CRC'
    elif cmac(bytes([D['sys_id']]) + b[:18])[:4] != b[19:23]: res = 'BAD_MAC'
    elif node == 0: res = 'REJECT_ROSTER'
    else: res = 'OK'
    return res, node, decode(b)
def classify_beacon(b):
    if crc8(b[:8]) != b[8]: return 'BAD_CRC', b[3]
    if cmac(b[:8])[:4] != b[9:13]: return 'BAD_MAC', b[3]
    return ('OK' if b[3] == 3 else 'IGNORE_ABI'), b[3]
def check_all():
    errs = []
    for f in D['frames']:
        res, node, dec = classify_frame(bytes.fromhex(f['hex'])); e = f['expect']
        if res != e['result']: errs.append(f"{f['id']}: result {res} != {e['result']}")
        if res != 'BAD_LEN' and node != e['node_id']: errs.append(f"{f['id']}: node_id {node} != {e['node_id']}")
        if dec != e['decoded']: errs.append(f"{f['id']}: decoded fields differ: " + str({k: (dec or {}).get(k) for k in (e['decoded'] or {}) if (dec or {}).get(k) != e['decoded'][k]}))
    for bc in D['beacons']:
        res, abi = classify_beacon(bytes.fromhex(bc['hex']))
        if (res, abi) != (bc['expect']['result'], bc['expect']['abi_ver']): errs.append(f"{bc['id']}: {res}/{abi} != {bc['expect']}")
    ids = [x['id'] for x in D['frames'] + D['beacons']]
    if len(ids) != len(set(ids)): errs.append('duplicate vector ids')
    return errs
def test_vectors():
    errs = check_all(); assert not errs, '\n'.join(errs)
if __name__ == '__main__':
    errs = check_all()
    for e in errs: print('FAIL:', e)
    print(f"test_vectors: {len(D['frames'])} frames and {len(D['beacons'])} beacons,", 'FAILED (%d)' % len(errs) if errs else 'all match')
    sys.exit(1 if errs else 0)
