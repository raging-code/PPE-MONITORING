"""P28-4b (ADR 0056): the session_hours setting: default, override, range, and that it is not in settings_hash. Requirements: REQ-SEC-002."""
import json
import pytest
from ppe_host.settings import load_settings, settings_hash, HASH_EXCLUDED, SettingsError, DEFAULTS_PATH

def home(tmp_path, local=None):
    (tmp_path / 'config').mkdir(parents=True, exist_ok=True)
    if local is not None: (tmp_path / 'config' / 'settings.local.json').write_text(json.dumps(local))
    return tmp_path

def test_the_default_is_12_hours_and_a_local_override_is_read(tmp_path):
    assert load_settings(home(tmp_path))['session_hours'] == 12
    s = load_settings(home(tmp_path / 'x', {'session_hours': 2.5})); assert s['session_hours'] == 2.5
def test_a_value_outside_above_0_to_168_or_of_the_wrong_type_is_refused(tmp_path):
    for i, bad in enumerate((0, -1, 169, 1e9, True, '12', None)):
        with pytest.raises(SettingsError): load_settings(home(tmp_path / str(i), {'session_hours': bad}))
    assert load_settings(home(tmp_path / 'ok', {'session_hours': 168}))['session_hours'] == 168
def test_session_hours_is_not_in_settings_hash_so_changing_it_does_not_end_a_shift(tmp_path):
    a = load_settings(home(tmp_path)); b = load_settings(home(tmp_path / 'y', {'session_hours': 4}))
    assert 'session_hours' in HASH_EXCLUDED and settings_hash(a) == settings_hash(b)
def test_the_committed_default_file_holds_the_key():
    assert json.loads(DEFAULTS_PATH.read_text(encoding='utf8'))['session_hours'] == 12
