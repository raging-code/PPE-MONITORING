"""io/audio_watchdog.py (P23a: sound files and priority; P23b adds the AudioThread, the self-check, the zero-socket warning and the fallback pulse).
Design 3.12 (host is the primary alarm), 3.3 (the full priority list of Rev 3.17) and 'Sound files' (Rev 3.28). Nothing here touches the sound card:
this part is pure data and file checks, so it runs and tests without a speaker or winsound."""
import hashlib, json
from pathlib import Path

HOST_ROOT = Path(__file__).resolve().parents[2]            # host/
SOUNDS_DIR = HOST_ROOT / 'sounds'
CATALOG_PATH = HOST_ROOT.parent / 'shared' / 'alert_catalog.json'
NO_FILE = ('none', 'siren_60s_silence')                    # no WAV: silence, and the browser siren (3.12)

def load_catalog(path=CATALOG_PATH):
    """{type: catalog entry} from shared/alert_catalog.json."""
    return {e['type']: e for e in json.loads(Path(path).read_text(encoding='utf-8'))}

def catalog_sound_names(catalog):
    return {s for e in catalog.values() for s in e['sound_by_level'].values()} - set(NO_FILE)

def check_sounds(sounds_dir=SOUNDS_DIR, catalog=None):
    """Start-up check of 3.12: every file against manifest.json. Returns [(file, reason)], empty when all is well.
    reasons: 'missing' (not on disk), 'altered' (hash differs), 'not in manifest' (a catalog sound the manifest does not list). A missing or unreadable manifest is [('manifest.json', ...)].
    The caller raises AUDIO_FAULT for a non-empty list."""
    d = Path(sounds_dir)
    try: listed = json.loads((d / 'manifest.json').read_text(encoding='utf-8'))['files']
    except OSError: return [('manifest.json', 'missing')]
    except (ValueError, KeyError, TypeError): return [('manifest.json', 'unreadable')]
    need = set(listed) | {n + '.wav' for n in catalog_sound_names(catalog if catalog is not None else load_catalog())}
    bad = []
    for f in sorted(need):
        if f not in listed: bad.append((f, 'not in manifest')); continue
        try: h = hashlib.sha256((d / f).read_bytes()).hexdigest()
        except OSError: bad.append((f, 'missing')); continue
        if h != listed[f]: bad.append((f, 'altered'))
    return bad

# ---- priority (3.3, Rev 3.17 complete list): one sound at a time, the highest class plays ----
RANK_NO_LIVE_DATA, RANK_MAYDAY_MAN_DOWN, RANK_BASE_OFFLINE, RANK_DANGER, RANK_WARNING, RANK_UNAUTH, RANK_ONE_BEEP, RANK_CHIME = 1, 2, 3, 4, 5, 6, 7, 8
def host_rank(alert_type, level, catalog):
    """(rank, sound name) the host plays for this type at this level, or None when the host stays silent for it (sound none, the browser-only NO LIVE DATA siren, AUDIO FAULT,
    notices, or an unknown type). Rank 1 (NO LIVE DATA) is the browser siren and is never a host sound; this list orders the host alarm (3.3)."""
    e = catalog.get(alert_type)
    sound = e['sound_by_level'].get(level) if e else None
    if sound is None or sound in NO_FILE: return None
    if alert_type in ('mayday', 'man_down'): return RANK_MAYDAY_MAN_DOWN, sound
    if alert_type == 'base_offline': return RANK_BASE_OFFLINE, sound
    if alert_type == 'unauth_alert': return RANK_UNAUTH, sound
    rank = {'siren': RANK_DANGER, 'beep': RANK_WARNING, 'one_beep': RANK_ONE_BEEP, 'chime': RANK_CHIME}.get(sound)
    return (rank, sound) if rank else None

def pick(items, catalog):
    """The one item the host sounds: items are dicts with alert_type, level and acknowledged (True once Acknowledge is stored). Acknowledged items are silent.
    Returns (rank, sound, alert_type) of the highest-priority item, or None. An open item that has cleared but is not acknowledged still counts: 3.3 says the sound
    continues while any safety card is unacknowledged (ADR 0026, to confirm)."""
    best = None
    for it in items:
        if it.get('acknowledged'): continue
        r = host_rank(it['alert_type'], it['level'], catalog)
        if r is not None and (best is None or r[0] < best[0]): best = (r[0], r[1], it['alert_type'])
    return best
