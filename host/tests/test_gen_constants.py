"""P3: constants/settings split and tools/gen_constants.py (design 12.1). If the ppe_host.constants import fails, run: python tools/gen_constants.py"""
import copy, importlib.util, json, re, sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[2]
def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / f'{name}.py'); m = importlib.util.module_from_spec(spec)
    sys.modules[name] = m; spec.loader.exec_module(m); return m
gen = _load('gen_constants')
try: from ppe_host import constants as K
except ImportError as e: raise RuntimeError('host/ppe_host/constants.py is missing: run python tools/gen_constants.py first') from e
C, S = gen.load(gen.SRC), gen.load(gen.SETTINGS)
def table_rows():  # (key, default text, deleted) from the host-only table of design Section 1
    rows = []
    for line in (ROOT / 'docs' / 'design' / 's01-settings.md').read_text(encoding='utf8').splitlines():
        cells = [x.strip() for x in line.strip().strip('|').split('|')]
        if line.startswith('|') and len(cells) >= 3 and not set(cells[0]) <= set('-') and cells[0] != 'Setting':
            rows.append((cells[0].replace(' (deleted)', ''), cells[1], cells[2].startswith('Deleted')))  # description says Deleted
    return rows
def test_move_list_keys_exist_where_12_1_says():
    for k in gen.MOVED: assert k in S and k not in C, k
    assert len(gen.MOVED) == 16
def test_deleted_keys_are_in_neither_file():
    assert len(gen.DELETED) == 8
    for k in gen.DELETED: assert k not in C and k not in S, k
def test_firmware_keys_are_in_constants_json():
    assert len(gen.FIRMWARE) == 12
    for k in gen.FIRMWARE: assert k in C, k
    assert (C['scba_confirm_s'], C['resend_wait_ms'], C['beacon_period_s'], C['unresolved_label_s']) == (300, 1650, 4, 300)
def test_files_share_no_key_and_validate_passes():
    assert not set(C) & set(S); gen.validate(C, S)
def test_profile_a_literals_15_60_5_5_exact():
    a = gen.derive(gen.PERIODS['A'])
    assert (a['signal_lost_s'], a['link_lost_adverse_s'], a['link_lost_max_s'], a['shadow_grace_s'], a['beacon_period_s']) == (15, 15, 60, 5.5, 4)
    assert type(a['signal_lost_s']) is int and type(a['shadow_grace_s']) is float
    assert all(C[k] == v and type(C[k]) is type(v) for k, v in a.items())
def test_derived_times_scale_with_routine_period():
    b, a = gen.derive(8), gen.derive(2)
    for k in gen.DERIVED: assert b[k] == a[k] * 4, k
    assert (b['link_lost_max_s'], b['shadow_grace_s']) == (240, 22.0)  # "about 8 s ... roughly fourfold" (Summary duty-cycle rule)
def test_validate_rejects_a_literal_that_is_not_profile_a():
    bad = copy.deepcopy(C); bad['link_lost_max_s'] = 61
    with pytest.raises(ValueError, match='link_lost_max_s'): gen.validate(bad, S)
def test_validate_rejects_a_moved_key_left_in_constants():
    bad = copy.deepcopy(C); bad['commit_wait_ms'] = 120
    with pytest.raises(ValueError, match='commit_wait_ms'): gen.validate(bad, S)
def test_validate_rejects_a_deleted_key_in_settings():
    bad = copy.deepcopy(S); bad['token_grace_h'] = 8
    with pytest.raises(ValueError, match='token_grace_h'): gen.validate(C, bad)
def test_generated_files_match_the_generator():  # the CI "regenerate, git diff is empty" check
    for rel, text in gen.render_all(C, S).items(): assert (ROOT / rel).read_text(encoding='utf8') == text, rel + ' is stale: run python tools/gen_constants.py'
def test_generated_key_counts_equal_the_files():
    assert (len(C), len(S)) == (78, 36)        # settings.json 35 keys + second_drive_dir (P26-3, ADR 0040; the design line for it is still to be written)
    assert len(K.CONSTANTS) == len(C) and K.CONSTANTS == C
    assert all(getattr(K, k.upper()) == v for k, v in C.items())
    c_src, ts_src = (ROOT / gen.OUT['c']).read_text(encoding='utf8'), (ROOT / gen.OUT['ts']).read_text(encoding='utf8')
    assert len(re.findall(r'^#define PPE_(?!PROFILE_)', c_src, re.M)) == len(C)
    assert json.loads(re.search(r'CONSTANTS = (\{.*?\n\}) as const;', ts_src, re.S).group(1)) == C
    assert K.PROFILES['A']['link_lost_max_s'] == 60 and K.PROFILES['B']['routine_period_s'] == 8
def test_settings_json_holds_every_table_key_with_the_table_default():
    rows = table_rows(); live = [(k, d) for k, d, deleted in rows if not deleted]
    assert len(rows) == 28 and len(live) == 26
    for k, d in live: assert k in S and S[k] == json.loads(d), k
    assert {k for k, _, deleted in rows if deleted} == {'zero_socket_alarm_s', 'no_audio_alarm_s'}
def test_settings_json_holds_the_section_1_connection_keys():
    conn = {'serial_port': 'COM4', 'db_path': 'data/ppe.db', 'test_db_path': 'data/ppe_test.db', 'backup_dir': 'backups/', 'bind_host': '127.0.0.1', 'bind_port': 8420, 'sys_id': 1, 'base_id': 1, 'log_dir': 'logs/'}
    assert all(S[k] == v for k, v in conn.items())
    assert S['co_rising_enabled'] is False and S['weak_signal_enabled'] is False  # co_rising stays disabled
    assert not any(k in S for k in ('key_hex', 'server_salt', 'cmac_key'))  # secrets live only in config/secrets.json
