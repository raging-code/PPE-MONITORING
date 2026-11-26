"""P18b: tools/gen_api_types.py exports shared/ws.schema.json and shared/openapi.json from api/models.py and
generates dashboard/src/gen/ws_messages.ts. The schema export and TS regeneration tests are the CI
"regenerate, git diff is empty" check (design 12.1), same pattern as test_gen_abi.py / test_gen_constants.py."""
import importlib.util, json, re, sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[2]
def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / f'{name}.py'); m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m; spec.loader.exec_module(m); return m
gen = _load('gen_api_types')
sys.path.insert(0, str(ROOT / 'host'))
from ppe_host.api import models as M

WS_SCHEMA = json.loads((ROOT / gen.OUT['schema']).read_text(encoding='utf8'))
OPENAPI = json.loads((ROOT / gen.OUT['openapi']).read_text(encoding='utf8'))
TS_SRC = (ROOT / gen.OUT['ts']).read_text(encoding='utf8')
MESSAGE_NAMES = [c.__name__ for c in M.SERVER_TYPES + M.CLIENT_TYPES]

def test_generated_files_match_the_generator():  # the CI regenerate-and-diff-is-empty check
    ws_schema = M.WS_ADAPTER.json_schema()
    expected = {gen.OUT['schema']: json.dumps(ws_schema, indent=2, sort_keys=False) + '\n',
                gen.OUT['openapi']: json.dumps(gen.render_openapi(ws_schema), indent=2, sort_keys=False) + '\n',
                gen.OUT['ts']: gen.render_ts(ws_schema) + '\n'}
    for rel, text in expected.items():
        assert (ROOT / rel).read_text(encoding='utf8') == text, rel + ' is stale: run python tools/gen_api_types.py'

def test_ws_schema_is_the_discriminated_union_with_every_message_defined():
    assert WS_SCHEMA['discriminator']['propertyName'] == 'type'
    assert set(WS_SCHEMA['$defs']) >= set(MESSAGE_NAMES)
    assert len(WS_SCHEMA['oneOf']) == len(MESSAGE_NAMES)

def test_ws_schema_forbids_extra_properties_on_every_message():
    for name in MESSAGE_NAMES:
        assert WS_SCHEMA['$defs'][name]['additionalProperties'] is False, name

def test_openapi_wraps_the_same_schemas_with_no_paths_yet():
    assert OPENAPI['openapi'].startswith('3.1')
    assert OPENAPI['paths'] == {}  # REST routes are P19 and P19c
    assert OPENAPI['components']['schemas'] == WS_SCHEMA['$defs']

def test_ts_has_one_interface_per_defs_entry_and_the_three_unions():
    for name in WS_SCHEMA['$defs']:
        assert re.search(rf'export interface {name} \{{', TS_SRC), name
    assert 'export type ServerMessage =' in TS_SRC and 'export type ClientMessage =' in TS_SRC and 'export type WsMessage = ServerMessage | ClientMessage;' in TS_SRC
    for name in (c.__name__ for c in M.SERVER_TYPES):
        assert re.search(rf'\b{name}\b', TS_SRC.split('export type ServerMessage =')[1].split(';')[0])
    for name in (c.__name__ for c in M.CLIENT_TYPES):
        assert re.search(rf'\b{name}\b', TS_SRC.split('export type ClientMessage =')[1].split(';')[0])

def test_ts_renders_literal_and_enum_fields_as_string_literal_unions():
    assert 'type: "snapshot";' in TS_SRC and 'type: "auth";' in TS_SRC
    assert '"NORMAL" | "WARNING" | "DANGER" | null' in TS_SRC  # NodeSnap.level
    assert 'v: 1;' in TS_SRC and 'srv_seq: 0;' in TS_SRC  # SnapshotMsg's v and literal-0 srv_seq

def test_ts_renders_bit_fields_as_0_1_union_not_boolean():
    assert 'authenticated: 0 | 1;' in TS_SRC  # AlertBody.authenticated is a DB 0/1 column, not a TS boolean

def test_ts_renders_nested_objects_and_arrays_and_maps():
    assert 'session: SessionInfo;' in TS_SRC and 'roster: RosterRow[];' in TS_SRC and 'open_alerts: AlertBody[];' in TS_SRC
    assert 'co_history_30m: Record<string, number[][]>;' in TS_SRC
    assert 'constants: Record<string, unknown>;' in TS_SRC  # the whole constants.json; no field is hard-coded

def test_ts_compiles_with_strict_tsc_if_available():
    import shutil, subprocess
    tsc = shutil.which('tsc') or shutil.which('npx')
    if tsc is None: pytest.skip('no TypeScript compiler on PATH')
    args = [tsc, '--noEmit', '--strict', str(ROOT / gen.OUT['ts'])] if tsc.endswith('tsc') else ['npx', 'tsc', '--noEmit', '--strict', str(ROOT / gen.OUT['ts'])]
    r = subprocess.run(args, capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stdout + r.stderr

def test_schema_version_constant_matches_models():
    assert gen.M.SCHEMA_VERSION == 1 and f'SCHEMA_VERSION = {gen.M.SCHEMA_VERSION} as const;' in TS_SRC
