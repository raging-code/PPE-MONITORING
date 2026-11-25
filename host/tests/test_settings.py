"""P11-2: settings loader and the two session hashes (design 1, Host configuration)."""
import json, pytest
from ppe_host.settings import (load_settings, settings_hash, constants_hash, canonical_json, SettingsError, HASH_EXCLUDED, DEFAULTS_PATH, REPO_ROOT)

DEFAULTS = json.loads(DEFAULTS_PATH.read_text(encoding='utf8'))
def home(tmp_path, local=None, secrets=None):
    (tmp_path / 'config').mkdir(exist_ok=True)
    if local is not None: (tmp_path / 'config' / 'settings.local.json').write_text(json.dumps(local), encoding='utf8')
    if secrets is not None: (tmp_path / 'config' / 'secrets.json').write_text(json.dumps(secrets), encoding='utf8')
    return tmp_path

def test_defaults_load_and_paths_resolve_against_ppe_home(tmp_path):
    s = load_settings(home(tmp_path)); assert s.values == DEFAULTS and len(s.values) == 35 and s.home == tmp_path
    assert s.path('db_path') == tmp_path / 'data/ppe.db' and s.path('backup_dir') == tmp_path / 'backups/' and s.secrets_path == tmp_path / 'config' / 'secrets.json'
    abs_dir = tmp_path / 'elsewhere'; assert load_settings(home(tmp_path, {'log_dir': str(abs_dir)})).path('log_dir') == abs_dir      # an absolute path is kept
    with pytest.raises(KeyError): s.path('sys_id')

def test_ppe_home_comes_from_the_environment_and_defaults_to_the_repository(tmp_path):
    assert load_settings(env={'PPE_HOME': str(tmp_path)}).home == tmp_path and load_settings(env={}).home == REPO_ROOT

def test_local_override_wins_unknown_keys_and_wrong_types_are_refused(tmp_path):
    s = load_settings(home(tmp_path, {'serial_port': 'COM7', 'bind_port': 8421, 'host_disk_min_gb': 2})); assert (s['serial_port'], s['bind_port'], s['host_disk_min_gb'], s['sys_id']) == ('COM7', 8421, 2, 1)
    for bad in ({'serial_prot': 'COM7'}, {'bind_port': '8421'}, {'co_rising_enabled': 1}, {'sys_id': True}, [1]):
        with pytest.raises(SettingsError): load_settings(home(tmp_path, bad))
    (tmp_path / 'config' / 'settings.local.json').write_text('{oops', encoding='utf8')
    with pytest.raises(SettingsError): load_settings(tmp_path)

def test_secrets_are_validated_and_never_shown(tmp_path):
    key, salt = '000102030405060708090a0b0c0d0e0f', 'ab' * 32
    s = load_settings(home(tmp_path, secrets={'cmac_key': key, 'server_salt': salt})); assert s.cmac_key() == bytes.fromhex(key) and s.server_salt() == bytes.fromhex(salt)
    assert key not in repr(s) and salt not in repr(s) and key not in json.dumps(s.values)
    for bad in ({}, {'cmac_key': key[:30]}, {'cmac_key': 'zz' * 16}, {'cmac_key': 5}):
        with pytest.raises(SettingsError) as e: load_settings(home(tmp_path, secrets=bad)).cmac_key()
        assert key not in str(e.value)
    with pytest.raises(SettingsError): load_settings(tmp_path / 'none').server_salt()

def test_settings_hash_ignores_connection_path_and_budget_keys_but_not_the_rest(tmp_path):
    base = DEFAULTS; h = settings_hash(base); assert len(h) == 64 and len(HASH_EXCLUDED) == 16 and set(HASH_EXCLUDED) <= set(base)
    for k in HASH_EXCLUDED:                                                                                           # 7 path keys and the nine 'Not in settings_hash' rows
        v = base[k]; assert settings_hash({**base, k: (v + 'x' if isinstance(v, str) else v + 1)}) == h, k
    for k in set(base) - set(HASH_EXCLUDED):
        v = base[k]; assert settings_hash({**base, k: (not v if isinstance(v, bool) else v + 'x' if isinstance(v, str) else v + 1)}) != h, k   # sys_id, commit_wait_ms, co_rising_enabled ...
    assert settings_hash(dict(reversed(list(base.items())))) == h                                                    # key order is irrelevant
    assert settings_hash(load_settings(home(tmp_path, {'serial_port': 'COM9'}))) == h                                # a re-plugged COM port does not end a shift

def test_constants_hash_ignores_formatting_and_follows_values(tmp_path):
    h = constants_hash(); d = json.loads((REPO_ROOT / 'shared' / 'constants.json').read_text(encoding='utf8'))
    a = tmp_path / 'a.json'; a.write_text(json.dumps(d, indent=4, sort_keys=False), encoding='utf8'); assert constants_hash(a) == h and len(h) == 64
    k = next(iter(d)); d[k] = d[k] + 1 if isinstance(d[k], (int, float)) else str(d[k]) + 'x'; a.write_text(json.dumps(d), encoding='utf8'); assert constants_hash(a) != h
    assert canonical_json({'b': 1, 'a': [1, 2]}) == b'{"a":[1,2],"b":1}'
