"""settings.py (P11-2): the minimal loader of design 1 (Host configuration) and the two session hashes. P24 extends it (mode choice, 'auto' serial port, lockfile).
Committed defaults: host/config/settings.json. Machine-specific overrides: <PPE_HOME>/config/settings.local.json. Secrets: <PPE_HOME>/config/secrets.json.
PPE_HOME defaults to the repository folder. Secrets never appear in repr, errors, hashes or logs."""
import hashlib, json, os, re
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULTS_PATH = REPO_ROOT / 'host' / 'config' / 'settings.json'
CONSTANTS_PATH = REPO_ROOT / 'shared' / 'constants.json'
PATH_KEYS = ('db_path', 'test_db_path', 'backup_dir', 'second_drive_dir', 'log_dir')   # resolved against PPE_HOME; second_drive_dir is '' (off) unless the operator names the USB folder (P26-3)
HASH_EXCLUDED = ('serial_port', 'db_path', 'test_db_path', 'backup_dir', 'second_drive_dir', 'log_dir', 'bind_host', 'bind_port',                         # connection and path keys (Rev 3.41)
                 'host_alarm_budget_ms', 'checkpoint_interval_s', 'checkpoint_max_bytes', 'host_budget_ms', 'dashboard_budget_ms',     # the nine rows marked
                 'recovering_target_s', 'host_bat_warn_pct', 'host_disk_min_gb', 'supervisor_restart_target_s', 'session_hours')                        # 'Not in settings_hash' (Rev 3.42)

class SettingsError(ValueError): pass

def canonical_json(obj):
    """Canonical sorted-key compact UTF-8 JSON (design 1): formatting or key order never changes a hash."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':')).encode('utf-8')

def _read_json(path, what):
    try: return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e: raise SettingsError('cannot read %s (%s)' % (what, type(e).__name__)) from None

def _same_kind(default, value):
    if isinstance(default, bool) or isinstance(value, bool): return isinstance(default, bool) and isinstance(value, bool)
    if isinstance(default, (int, float)): return isinstance(value, (int, float))
    return isinstance(value, type(default))

@dataclass(frozen=True)
class Settings:
    values: dict
    home: Path
    _secrets: dict = field(default_factory=dict, repr=False)
    def __getitem__(self, k): return self.values[k]
    def get(self, k, default=None): return self.values.get(k, default)
    def path(self, key):
        if key not in PATH_KEYS: raise KeyError(key)
        return self.home / self.values[key]                      # an absolute value in settings stays as it is
    @property
    def secrets_path(self): return self.home / 'config' / 'secrets.json'
    def _hex_secret(self, name, nchars):
        v = self._secrets.get(name)
        if not (isinstance(v, str) and re.fullmatch(r'[0-9a-fA-F]{%d}' % nchars, v)): raise SettingsError('%s in config/secrets.json is missing or is not %d hex characters' % (name, nchars))
        return bytes.fromhex(v)
    def cmac_key(self): return self._hex_secret('cmac_key', 32)           # the 16-byte shared key
    def server_salt(self): return self._hex_secret('server_salt', 64)     # 32 random bytes; P19b generates it, the host never replaces a missing one

def load_settings(ppe_home=None, defaults_path=DEFAULTS_PATH, env=None):
    home = Path(ppe_home or (env if env is not None else os.environ).get('PPE_HOME') or REPO_ROOT)
    values = _read_json(defaults_path, 'settings.json')
    local = home / 'config' / 'settings.local.json'
    if local.exists():
        over = _read_json(local, 'settings.local.json')
        if not isinstance(over, dict): raise SettingsError('settings.local.json must be a JSON object')
        for k, v in over.items():
            if k not in values: raise SettingsError('unknown key in settings.local.json: %s' % k)
            if not _same_kind(values[k], v): raise SettingsError('settings.local.json: %s must be of type %s' % (k, type(values[k]).__name__))
            values[k] = v
    h = values.get('session_hours')      # P28-4b (ADR 0056): hours a PIN login session lasts
    if h is not None and not (0 < h <= 168): raise SettingsError('session_hours must be above 0 and at most 168')
    sec = home / 'config' / 'secrets.json'
    secrets = _read_json(sec, 'secrets.json') if sec.exists() else {}
    if not isinstance(secrets, dict): raise SettingsError('secrets.json must be a JSON object')
    return Settings(values, home, secrets)

def settings_hash(settings):
    """SHA-256 over the merged settings without HASH_EXCLUDED, canonical JSON (design 1; a changed hash ends the session)."""
    vals = settings.values if isinstance(settings, Settings) else settings
    return hashlib.sha256(canonical_json({k: v for k, v in vals.items() if k not in HASH_EXCLUDED})).hexdigest()

def constants_hash(path=CONSTANTS_PATH):
    """SHA-256 over the whole of shared/constants.json, canonical JSON."""
    return hashlib.sha256(canonical_json(_read_json(path, 'constants.json'))).hexdigest()
