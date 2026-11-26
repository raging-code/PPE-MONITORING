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

# ---- P23b: AudioThread (design 3.12, 3.3, 14.5 thread map). The sound card is reached only through a backend object, so every rule below runs against a fake. ----
# Times that the design states in words and that are not keys of constants.json or settings.json are module constants here (ADR 0027), as the 10 s zero-socket time is.
import threading
BEEP_REPEAT_MS = 10_000        # beep and one_beep repeat every 10 s until Acknowledge (guide P23: beeps repeat every 10 s within 1 s)
PULSE_MS, PULSE_HZ, PULSE_LEN_MS = 2_000, 1000, 400   # fallback when a WAV is missing or cannot be played: 1 kHz, 400 ms, every 2 s
ZERO_SOCKET_MS = 10_000        # laptop warning after this long with no connected /ws socket while monitoring_active (ADR 0026)
POLL_S = 0.05                  # AudioThread wake-up period; set_items() wakes it at once, so a new alarm starts well inside 300 ms
SOUND_OF = {'siren': 'loop', 'beep': 'repeat', 'one_beep': 'repeat', 'chime': 'once'}

class WinsoundBackend:
    """The real sound card (Windows, stdlib winsound). play() raises RuntimeError when the device or file fails; elsewhere it raises RuntimeError at once. Needs the bench check of design 3.12."""
    def _ws(self):
        try: import winsound; return winsound
        except ImportError: raise RuntimeError('winsound is not available on this system')
    def play(self, path, loop=False, wait=False):
        w = self._ws(); w.PlaySound(str(path), w.SND_FILENAME | (0 if wait else w.SND_ASYNC) | (w.SND_LOOP if loop and not wait else 0))
    def beep(self, hz, ms): self._ws().Beep(hz, ms)       # synchronous; no WAV needed
    def stop(self):
        w = self._ws(); w.PlaySound(None, w.SND_PURGE)

class AudioThread(threading.Thread):
    """Plays the host alarm for open alerts, the 15 minute host_chime and the 60 s self-check. tick() holds all the logic and is called by run() about every 50 ms (tests call it directly with a FakeClock).
    items: dicts with alert_type, level, acknowledged (open alerts plus active banners), replaced whole by set_items(). sockets_fn() -> connected /ws tabs (Hub.connected_tabs), monitoring_fn() -> monitoring_active;
    without sockets_fn the zero-socket warning is off. on_event(kind, detail) gets 'AUDIO_FAULT' once per fault and 'AUDIO_OK' once when the last cause clears; the host turns them into system_events and the banner."""
    def __init__(self, backend, clock, catalog=None, sounds_dir=SOUNDS_DIR, check_interval_s=60, chime_interval_min=15, sockets_fn=None, monitoring_fn=None, on_event=None):
        super().__init__(name='AudioThread', daemon=True)
        self.backend, self.clock, self.dir = backend, clock, Path(sounds_dir); self.catalog = catalog if catalog is not None else load_catalog()
        self.check_ms, self.chime_ms = int(check_interval_s * 1000), int(chime_interval_min * 60_000)
        self.sockets_fn, self.monitoring_fn, self.on_event = sockets_fn, monitoring_fn, on_event
        self._items, self._wake, self._halt = [], threading.Event(), False
        self._sound = self._mode = self._due = None; self._next_check = 0; self._last_chime = clock.mono_ms(); self._no_socket_since = None
        self.bad, self.faults, self.last_tick, self.errors = set(), {}, clock.mono_ms(), 0     # last_tick is the liveness stamp for the OS watchdog (P24)
    @property
    def audio_fault(self): return bool(self.faults)
    @property
    def playing(self): return self._sound            # name of the sound now being sounded, or None
    def set_items(self, items): self._items = list(items); self._wake.set()
    def _emit(self, kind, detail):
        if self.on_event:
            try: self.on_event(kind, detail)
            except Exception: self.errors += 1
    def _fault(self, key, detail):
        was = bool(self.faults)
        if detail is None: self.faults.pop(key, None)
        else: self.faults[key] = detail
        if self.faults and not was: self._emit('AUDIO_FAULT', detail)
        elif was and not self.faults: self._emit('AUDIO_OK', '')
    def _path(self, name): return self.dir / (name + '.wav')
    def _try(self, name, loop=False, wait=False):
        """One play call. A RuntimeError or OSError is the device fault of 3.12; a file the start-up or 60 s check marked bad is never trusted (altered or missing)."""
        if name + '.wav' in self.bad: return False
        try: self.backend.play(self._path(name), loop=loop, wait=wait)
        except (RuntimeError, OSError) as e: self._fault('device', 'play failed: %s' % e); return False
        self._fault('device', None); return True
    def _pulse(self, now):
        try: self.backend.beep(PULSE_HZ, PULSE_LEN_MS)
        except (RuntimeError, OSError): pass        # the fault is already recorded; nothing else can sound
        self._due = now + PULSE_MS
    def _start(self, now):
        s = self._sound
        if self._try(s, loop=SOUND_OF[s] == 'loop'):
            self._mode = SOUND_OF[s]; self._due = now + BEEP_REPEAT_MS if self._mode == 'repeat' else None
        else: self._mode = 'pulse'; self._pulse(now)
    def _zero_socket(self, now):
        if self.sockets_fn is None or not (self.monitoring_fn() if self.monitoring_fn else True) or self.sockets_fn() > 0: self._no_socket_since = None; return False
        if self._no_socket_since is None: self._no_socket_since = now
        return now - self._no_socket_since >= ZERO_SOCKET_MS
    def _want(self, now):
        w = pick(self._items, self.catalog)
        if self._zero_socket(now) and (w is None or w[0] > RANK_WARNING): return RANK_WARNING, 'beep', 'zero_socket'
        return w
    def _stop_sound(self):
        try: self.backend.stop()
        except (RuntimeError, OSError): pass
        self._sound = self._mode = self._due = None
    def tick(self):
        now = self.clock.mono_ms(); self.last_tick = now
        due = now >= self._next_check
        if due:     # start-up check and every audio_check_interval_s: files against the manifest (3.12); the probe below runs only while idle
            bad = check_sounds(self.dir, self.catalog); self.bad = {f for f, _ in bad if f.endswith('.wav')}
            self._fault('files', '; '.join('%s %s' % b for b in bad) or None); self._next_check = now + self.check_ms
        w = self._want(now)
        if w is not None and w[0] <= RANK_UNAUTH: self._last_chime = now      # a sounding safety alarm is itself proof of the audio path: the 15 minute count restarts when it ends
        if w is None:
            if self._sound: self._stop_sound()
            if due: self._try('probe', wait=True)                             # 100 ms silent WAV, synchronous
        elif self._sound != w[1]:
            if self._sound: self._stop_sound()
            self._sound = w[1]; self._start(now)
        elif self._mode in ('repeat', 'pulse') and now >= self._due: self._start(now)
        if (w is None or w[0] >= RANK_ONE_BEEP) and now - self._last_chime >= self.chime_ms:
            self._last_chime = now; self._try('host_chime')                  # two-note ascending, unlike every alarm
    def run(self):
        while not self._halt:
            try: self.tick()
            except Exception: self.errors += 1       # never let one bad tick end the alarm thread
            self._wake.wait(POLL_S); self._wake.clear()
    def stop(self): self._halt = True; self._wake.set(); self._stop_sound()

def run_test_alarm(backend, seconds=3, sleep=None, sounds_dir=SOUNDS_DIR, catalog=None):
    """Shift speaker check (3.12): siren, then beep, then the 15 minute host_chime, so the operator hears all three. Returns (ok, message)."""
    import time; sleep = sleep or time.sleep; d = Path(sounds_dir)
    bad = check_sounds(d, catalog)
    if bad: return False, 'AUDIO FAULT: ' + '; '.join('%s %s' % b for b in bad)
    try:
        backend.play(d / 'siren.wav', loop=True); sleep(seconds); backend.stop()
        backend.play(d / 'beep.wav', wait=True); backend.play(d / 'host_chime.wav', wait=True)
    except (RuntimeError, OSError) as e: return False, 'AUDIO FAULT: play failed: %s' % e
    return True, 'played siren for %d s, then beep, then host_chime; record the result in the shift record' % seconds
