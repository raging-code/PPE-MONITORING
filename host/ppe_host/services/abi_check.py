"""services/abi_check.py (P24-5d, ADR 0049): the ABI check at host start (design 1, firmware note 4: "the ABI version is checked against abi.json at host start").
The host parses every frame and beacon with host/ppe_host/abi.py, which tools/gen_abi.py writes from shared/abi.json. If the two disagree (a stale or hand-edited abi.py, or a
folder mixed from two builds) the host would read safety bits from the wrong place without any error, so start-up refuses (exit 2).
expected() derives the values of abi.py from abi.json with the same rules as tools/gen_abi.py render_py (tools/ is not in a release folder, so the rules are repeated here);
mismatches() names every abi.py value that differs. Nothing is written and nothing is opened except shared/abi.json."""
import json
from pathlib import Path
from .. import abi as host_abi
from ..settings import REPO_ROOT

ABI_JSON = REPO_ROOT / 'shared' / 'abi.json'
SIGNED = {'u8': False, 'u16': False, 'i16': True, 'bytes': False}      # the same table as tools/gen_abi.py TYPES (signedness only)
SCALARS = ('FRAME_BYTES', 'BEACON_BYTES', 'BEACON_ABI_VER', 'CRC8_POLY', 'CRC8_INIT')

class AbiError(Exception):
    """abi.json cannot be read or does not have the expected shape."""

def expected(a):
    """{name: value} of host/ppe_host/abi.py for the parsed abi.json `a`. AbiError when `a` is not shaped like abi.json."""
    try:
        fr, bc = a['frame'], a['beacon']
        out = {'FRAME_BYTES': fr['bytes'], 'BEACON_BYTES': bc['bytes'], 'BEACON_ABI_VER': bc['abi_ver'], 'CRC8_POLY': fr['crc8']['poly'], 'CRC8_INIT': fr['crc8']['init'],
               'FRAME_CRC_RANGE': tuple(fr['crc8']['range']), 'BEACON_CRC_RANGE': tuple(bc['crc8']['range'])}
        for kind, s in (('FRAME', fr), ('BEACON', bc)): out[kind + '_FIELDS'] = {f['name']: (f['offset'], f['size'], SIGNED[f['type']]) for f in s['fields']}
        out['BITS'] = {fl: {b[0]: (b[1], b[2]) for b in bits if len(b) < 4} for fl, bits in a['bits'].items()}
        rsv = {fl: sum(((1 << b[2]) - 1) << b[1] for b in bits if len(b) > 3) for fl, bits in a['bits'].items()}
        out['RESERVED_MASK'] = {k: v for k, v in rsv.items() if v}
        out['ENUMS'] = {e: dict(v) for e, v in a['enums'].items()}
        return out
    except (KeyError, IndexError, TypeError, AttributeError):
        raise AbiError('abi.json does not have the layout of design 12.1') from None

def load(path=None):
    try: return json.loads(Path(path or ABI_JSON).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e: raise AbiError('cannot read abi.json (%s)' % type(e).__name__) from None

def mismatches(path=None, module=host_abi):
    """The abi.py names whose value differs from abi.json, in a fixed order; [] when they agree. A scalar shows as 'NAME (abi.py X, abi.json Y)'.
    AbiError when abi.json is unreadable or malformed (the caller treats that as a start-up failure too: the host does not run on an ABI it cannot check)."""
    want, bad = expected(load(path)), []
    for name, value in want.items():
        have = getattr(module, name, None)
        if have != value: bad.append('%s (abi.py %s, abi.json %s)' % (name, have, value) if name in SCALARS else name)
    return bad
