"""P24-5d (ADR 0049): the ABI check at host start. abi.py, which parses every frame, must hold exactly what shared/abi.json says; any difference refuses the start with exit 2. Requirements: REQ-REC-007."""
import json
import pytest
from ppe_host import abi, main as M
from ppe_host.services import abi_check as A

KEY = '000102030405060708090a0b0c0d0e0f'

def altered(tmp_path, edit):
    """A copy of shared/abi.json after edit(parsed) has changed it."""
    a = json.loads(A.ABI_JSON.read_text(encoding='utf-8')); edit(a); p = tmp_path / 'abi_copy.json'; p.write_text(json.dumps(a), encoding='utf-8'); return p

def home(tmp_path):
    (tmp_path / 'config').mkdir(exist_ok=True); (tmp_path / 'config' / 'secrets.json').write_text(json.dumps({'cmac_key': KEY, 'server_salt': 'ab' * 32})); return tmp_path

def start(h, mode='LIVE'): return M.startup(str(h), mode, now_ms=lambda: 1_700_000_000_000, proc_start={4_000_001: 1}.get, pid=4_000_001)

def test_the_committed_abi_py_matches_the_committed_abi_json():
    assert A.mismatches() == []

def test_expected_values_cover_every_name_of_abi_py():
    assert set(A.expected(A.load())) == {n for n in dir(abi) if n.isupper()}

def test_a_changed_abi_version_is_named_with_both_values(tmp_path):
    p = altered(tmp_path, lambda a: a['beacon'].update(abi_ver=4)); assert A.mismatches(p) == ['BEACON_ABI_VER (abi.py 3, abi.json 4)']

@pytest.mark.parametrize('edit, found', [
    (lambda a: a['frame'].update(bytes=24), ['FRAME_BYTES (abi.py 23, abi.json 24)']),
    (lambda a: a['frame']['crc8'].update(poly=9), ['CRC8_POLY (abi.py 7, abi.json 9)']),
    (lambda a: a['frame']['crc8'].update(range=[0, 17]), ['FRAME_CRC_RANGE']),
    (lambda a: a['frame']['fields'][3].update(type='i16'), ['FRAME_FIELDS']),                              # hum turned signed
    (lambda a: a['beacon']['fields'][3].update(offset=4), ['BEACON_FIELDS']),
    (lambda a: a['bits']['flags'][1].__setitem__(1, 3), ['BITS']),                                         # mandown moved from bit 2 to bit 3
    (lambda a: a['bits']['status4'][2].__delitem__(3), ['BITS', 'RESERVED_MASK']),                         # a reserved bit becomes a named one
    (lambda a: a['enums']['node_level'].update(DANGER=3, INVALID=2), ['ENUMS']),
])
def test_every_kind_of_difference_is_found(tmp_path, edit, found):
    assert A.mismatches(altered(tmp_path, edit)) == found

def test_a_stale_abi_py_is_found_by_comparing_with_the_file(monkeypatch):
    monkeypatch.setattr(abi, 'BEACON_ABI_VER', 2); assert A.mismatches() == ['BEACON_ABI_VER (abi.py 2, abi.json 3)']

def test_an_unreadable_or_malformed_abi_json_is_an_error_not_a_pass(tmp_path):
    with pytest.raises(A.AbiError, match='cannot read abi.json'): A.mismatches(tmp_path / 'missing.json')
    bad = tmp_path / 'bad.json'; bad.write_text('{not json', encoding='utf-8')
    with pytest.raises(A.AbiError, match='cannot read abi.json'): A.mismatches(bad)
    odd = tmp_path / 'odd.json'; odd.write_text('{"frame": {}}', encoding='utf-8')
    with pytest.raises(A.AbiError, match='layout of design 12.1'): A.mismatches(odd)
    lst = tmp_path / 'list.json'; lst.write_text('[]', encoding='utf-8')
    with pytest.raises(A.AbiError, match='layout of design 12.1'): A.mismatches(lst)

def test_start_up_refuses_exit_2_on_a_different_abi_version_and_leaves_nothing_behind(tmp_path, monkeypatch):
    h = home(tmp_path); monkeypatch.setattr(A, 'ABI_JSON', altered(tmp_path, lambda a: a['beacon'].update(abi_ver=4)))
    with pytest.raises(M.StartupExit) as e: start(h)
    assert e.value.code == M.EXIT_CONFIG == 2 and 'ABI mismatch' in e.value.message and 'BEACON_ABI_VER (abi.py 3, abi.json 4)' in e.value.message and 'gen_abi.py' in e.value.message
    assert not (h / M.LOCK_NAME).exists() and not (h / 'data').exists()                                   # refused before the lockfile and before any database file

def test_start_up_refuses_in_every_mode(tmp_path, monkeypatch):
    h = home(tmp_path); monkeypatch.setattr(abi, 'FRAME_BYTES', 22)
    for mode in ('LIVE', 'SIMULATOR', 'REPLAY'):
        with pytest.raises(M.StartupExit) as e: start(h, mode)
        assert e.value.code == 2 and 'FRAME_BYTES (abi.py 22, abi.json 23)' in e.value.message

def test_start_up_refuses_exit_2_when_abi_json_cannot_be_read(tmp_path, monkeypatch):
    h = home(tmp_path); monkeypatch.setattr(A, 'ABI_JSON', tmp_path / 'gone.json')
    with pytest.raises(M.StartupExit) as e: start(h)
    assert e.value.code == 2 and e.value.message.startswith('ABI check failed: cannot read abi.json') and not (h / M.LOCK_NAME).exists()

def test_main_returns_2_and_prints_the_reason_on_stderr(tmp_path, monkeypatch, capsys):
    h = home(tmp_path); monkeypatch.setattr(abi, 'BEACON_ABI_VER', 2)
    assert M.main(['--home', str(h)], serve=lambda *args: pytest.fail('the server must not start')) == 2
    assert 'ABI mismatch' in capsys.readouterr().err

def test_matching_files_start_normally(tmp_path):
    h = home(tmp_path); st = start(h); assert st.db_path == h / 'data' / 'ppe.db'; st.close()
