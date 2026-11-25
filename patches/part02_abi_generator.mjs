// patches/part02_abi_generator.mjs  (run from repo root: node patches/part02_abi_generator.mjs [--dry] [--force])
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
  put('shared/abi.json', String.raw`{
 "schema_version": 1,
 "note": "Single machine-readable frame and beacon layout (design 12.1). Source: Technical Summary Rev 2.9.11 frame table and status bits, design 14.4. Little-endian. temp_x100 is signed (Rev 3.45). Field names equal the frames.json decoded keys. Bit entries are [name, lsb, width] with an optional 4th item 'reserved'.",
 "frame": {
  "bytes": 23,
  "crc8": {"poly": 7, "init": 0, "range": [0, 18]},
  "mac4": {"range": [0, 18], "prefix": "sys_id"},
  "fields": [
   {"name": "seq", "offset": 0, "size": 2, "type": "u16"},
   {"name": "co_x10", "offset": 2, "size": 2, "type": "u16"},
   {"name": "temp_x100", "offset": 4, "size": 2, "type": "i16"},
   {"name": "hum", "offset": 6, "size": 1, "type": "u8"},
   {"name": "hr", "offset": 7, "size": 1, "type": "u8"},
   {"name": "motion_x100", "offset": 8, "size": 1, "type": "u8"},
   {"name": "bat", "offset": 9, "size": 1, "type": "u8"},
   {"name": "status2", "offset": 10, "size": 1, "type": "u8"},
   {"name": "flags", "offset": 11, "size": 1, "type": "u8"},
   {"name": "id_mode", "offset": 12, "size": 1, "type": "u8"},
   {"name": "uptime_s", "offset": 13, "size": 2, "type": "u16"},
   {"name": "status3", "offset": 15, "size": 1, "type": "u8"},
   {"name": "status4", "offset": 16, "size": 1, "type": "u8"},
   {"name": "boot_ctr", "offset": 17, "size": 1, "type": "u8"},
   {"name": "crc8", "offset": 18, "size": 1, "type": "u8"},
   {"name": "mac4", "offset": 19, "size": 4, "type": "bytes"}
  ]
 },
 "beacon": {
  "bytes": 13,
  "abi_ver": 3,
  "crc8": {"poly": 7, "init": 0, "range": [0, 8]},
  "mac4": {"range": [0, 8], "prefix": null},
  "fields": [
   {"name": "sys_id", "offset": 0, "size": 1, "type": "u8"},
   {"name": "base_id", "offset": 1, "size": 1, "type": "u8"},
   {"name": "beacon_seq", "offset": 2, "size": 1, "type": "u8"},
   {"name": "abi_ver", "offset": 3, "size": 1, "type": "u8"},
   {"name": "heard_mask", "offset": 4, "size": 1, "type": "u8"},
   {"name": "ack1", "offset": 5, "size": 1, "type": "u8"},
   {"name": "ack2", "offset": 6, "size": 1, "type": "u8"},
   {"name": "ack3", "offset": 7, "size": 1, "type": "u8"},
   {"name": "crc8", "offset": 8, "size": 1, "type": "u8"},
   {"name": "mac4", "offset": 9, "size": 4, "type": "bytes"}
  ]
 },
 "bits": {
  "id_mode": [["node_id", 0, 3], ["scba_on", 3, 1], ["posture", 4, 2], ["link_ok", 6, 1], ["evt_unsent", 7, 1]],
  "flags": [["node_level", 0, 2], ["mandown", 2, 1], ["fault", 3, 1], ["co_sat", 4, 1], ["activity", 5, 2], ["checkin", 7, 1]],
  "status2": [["hr_ok", 0, 1], ["wrist_ok", 1, 1], ["bat_low", 2, 1], ["reboot_hint", 3, 1], ["co_fault", 4, 1], ["imu_fault", 5, 1], ["temp_fault", 6, 1], ["cancel_ack", 7, 1]],
  "status3": [["btn_stuck", 0, 1], ["clear_armed", 1, 1], ["co_warmup", 2, 1], ["scba_expired", 3, 1], ["restored", 4, 1], ["reset_cause", 5, 2], ["still_now", 7, 1]],
  "status4": [["wrist_conn_open", 0, 1], ["latch_restored", 1, 1], ["rsv_2", 2, 2, "reserved"], ["mayday", 4, 1], ["rsv_5", 5, 3, "reserved"]]
 },
 "enums": {
  "node_level": {"NORMAL": 0, "WARNING": 1, "DANGER": 2, "INVALID": 3},
  "posture": {"UPRIGHT": 0, "LOW_LEANING": 1, "HORIZONTAL": 2, "UNKNOWN": 3},
  "activity": {"STILL": 0, "ACTIVE": 1, "FALL_SUSPECTED": 2, "UNCERTAIN": 3},
  "reset_cause": {"POWER_ON": 0, "BROWN_OUT": 1, "WATCHDOG": 2, "SOFTWARE": 3}
 }
}
`);
  put('tools/gen_abi.py', String.raw`#!/usr/bin/env python3
"""tools/gen_abi.py: writes the generated ABI files from shared/abi.json (design 12.1). Run: python tools/gen_abi.py
Outputs: firmware/components/abi/abi.h, host/ppe_host/abi.py, dashboard/src/gen/abi.ts. Never edit those by hand."""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = 'shared/abi.json'
OUT = {'c': 'firmware/components/abi/abi.h', 'py': 'host/ppe_host/abi.py', 'ts': 'dashboard/src/gen/abi.ts'}
TYPES = {'u8': (1, False), 'u16': (2, False), 'i16': (2, True), 'bytes': (None, False)}
HEAD = 'GENERATED by tools/gen_abi.py from shared/abi.json. Do not edit.'
def load():
    with open(os.path.join(ROOT, SRC), encoding='utf8') as f: return json.load(f)
def validate(a):
    for kind in ('frame', 'beacon'):
        s, pos, names = a[kind], 0, [f['name'] for f in a[kind]['fields']]
        for f in s['fields']:
            size, _ = TYPES[f['type']]
            if f['offset'] != pos or f['size'] < 1 or (size and size != f['size']): raise ValueError(f"{kind}.{f['name']}: bad offset or size")
            pos += f['size']
        if pos != s['bytes'] or len(set(names)) != len(names): raise ValueError(f'{kind}: fields do not fill {s["bytes"]} bytes once')
        by = {f['name']: f for f in s['fields']}
        if s['crc8']['range'] != [0, by['crc8']['offset']] or by['mac4']['offset'] != by['crc8']['offset'] + 1 or by['mac4']['offset'] + by['mac4']['size'] != s['bytes']: raise ValueError(f'{kind}: crc8 or mac4 position')
    fr = {f['name']: f for f in a['frame']['fields']}
    for field, bits in a['bits'].items():
        used = 0
        if fr[field]['size'] != 1: raise ValueError(f'{field}: bit field must be one byte')
        for b in bits:
            m = ((1 << b[2]) - 1) << b[1]
            if b[2] < 1 or b[1] + b[2] > 8 or used & m: raise ValueError(f'{field}.{b[0]}: out of range or overlap')
            used |= m
    widths = {b[0]: b[2] for bits in a['bits'].values() for b in bits}
    for e, vals in a['enums'].items():
        if e not in widths or max(vals.values()) >= 1 << widths[e]: raise ValueError(f'enum {e}: no bit field of that name or value too wide')
def bit_rows(a):  # (field, name, shift, width, mask) for named bits; reserved masks per field
    rows = [(fl, b[0], b[1], b[2], ((1 << b[2]) - 1) << b[1]) for fl, bits in a['bits'].items() for b in bits if len(b) < 4]
    rsv = {fl: sum(((1 << b[2]) - 1) << b[1] for b in bits if len(b) > 3) for fl, bits in a['bits'].items()}
    return rows, {k: v for k, v in rsv.items() if v}
def render_c(a):
    o = [f'/* {HEAD} */', '#pragma once', 'enum {', f'  ABI_FRAME_BYTES = {a["frame"]["bytes"]}, ABI_BEACON_BYTES = {a["beacon"]["bytes"]}, ABI_BEACON_ABI_VER = {a["beacon"]["abi_ver"]},',
         f'  ABI_CRC8_POLY = 0x{a["frame"]["crc8"]["poly"]:02X}, ABI_CRC8_INIT = {a["frame"]["crc8"]["init"]},']
    for kind in ('frame', 'beacon'):
        for f in a[kind]['fields']:
            p = f'ABI_{kind.upper()}_{f["name"].upper()}'
            o.append(f'  {p}_OFF = {f["offset"]}, {p}_SIZE = {f["size"]}, {p}_SIGNED = {int(TYPES[f["type"]][1])},')
    rows, rsv = bit_rows(a)
    for fl, n, sh, w, m in rows: o.append(f'  ABI_{fl.upper()}_{n.upper()}_SHIFT = {sh}, ABI_{fl.upper()}_{n.upper()}_MASK = 0x{m:02X},')
    for fl, m in rsv.items(): o.append(f'  ABI_{fl.upper()}_RESERVED_MASK = 0x{m:02X},')
    for e, vals in a['enums'].items(): o.append('  ' + ' '.join(f'ABI_{e.upper()}_{k} = {v},' for k, v in vals.items()))
    return '\n'.join(o + ['};', '']).replace(',\n};', '\n};')
def render_py(a):
    o = [f'"""{HEAD}"""', f'FRAME_BYTES = {a["frame"]["bytes"]}', f'BEACON_BYTES = {a["beacon"]["bytes"]}', f'BEACON_ABI_VER = {a["beacon"]["abi_ver"]}',
         f'CRC8_POLY = 0x{a["frame"]["crc8"]["poly"]:02X}', f'CRC8_INIT = {a["frame"]["crc8"]["init"]}',
         f'FRAME_CRC_RANGE = {tuple(a["frame"]["crc8"]["range"])}  # CRC-8 and MAC input: bytes[start:stop] (the frame MAC also takes sys_id first)', f'BEACON_CRC_RANGE = {tuple(a["beacon"]["crc8"]["range"])}']
    for kind in ('frame', 'beacon'):
        o.append(f'{kind.upper()}_FIELDS = {{  # name: (offset, size, signed)')
        o += [f"    '{f['name']}': ({f['offset']}, {f['size']}, {TYPES[f['type']][1]})," for f in a[kind]['fields']] + ['}']
    rows, rsv = bit_rows(a)
    o.append('BITS = {  # byte field: {name: (shift, width)}')
    for fl in a['bits']: o.append(f"    '{fl}': {{" + ', '.join(f"'{r[1]}': ({r[2]}, {r[3]})" for r in rows if r[0] == fl) + '},')
    o += ['}', f'RESERVED_MASK = {rsv}', 'ENUMS = {']
    return '\n'.join(o + [f"    '{e}': {v}," for e, v in a['enums'].items()] + ['}', ''])
def render_ts(a):
    o = [f'// {HEAD}', f'export const FRAME_BYTES = {a["frame"]["bytes"]} as const;', f'export const BEACON_BYTES = {a["beacon"]["bytes"]} as const;', f'export const BEACON_ABI_VER = {a["beacon"]["abi_ver"]} as const;',
         f'export const CRC8 = {{ poly: 0x{a["frame"]["crc8"]["poly"]:02x}, init: {a["frame"]["crc8"]["init"]} }} as const;']
    for kind in ('frame', 'beacon'):
        o.append(f'export const {kind.upper()}_FIELDS = {{')
        o += [f'  {f["name"]}: {{ offset: {f["offset"]}, size: {f["size"]}, signed: {str(TYPES[f["type"]][1]).lower()} }},' for f in a[kind]['fields']] + ['} as const;']
    rows, rsv = bit_rows(a)
    o.append('export const BITS = {')
    for fl in a['bits']: o.append(f'  {fl}: {{ ' + ', '.join(f'{r[1]}: {{ shift: {r[2]}, width: {r[3]} }}' for r in rows if r[0] == fl) + ' },')
    o += ['} as const;', 'export const RESERVED_MASK = { ' + ', '.join(f'{k}: 0x{v:02x}' for k, v in rsv.items()) + ' } as const;', 'export const ENUMS = {']
    o += [f'  {e}: {{ ' + ', '.join(f'{k}: {v}' for k, v in vals.items()) + ' },' for e, vals in a['enums'].items()]
    return '\n'.join(o + ['} as const;', ''])
def render_all(a):
    validate(a)
    return {OUT['c']: render_c(a), OUT['py']: render_py(a), OUT['ts']: render_ts(a)}
def main():
    for rel, text in render_all(load()).items():
        p = os.path.join(ROOT, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf8', newline='\n') as f: f.write(text)
        print('wrote', rel)
if __name__ == '__main__': main()
`);
  put('host/tests/test_gen_abi.py', String.raw`"""P2: shared/abi.json, tools/gen_abi.py and the generated ABI files (design 12.1).
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
`);
  replace('justfile', 'test:\n', 'test:\n    python -m pytest host/tests -q\n');
  replace('justfile', '@echo "gen: no generators yet"', 'python tools/gen_abi.py');
  append('docs/PROGRESS.md', '- Part 2 done: shared/abi.json, tools/gen_abi.py (writes abi.h, abi.py, abi.ts: run just gen), host/tests/test_gen_abi.py');
}
