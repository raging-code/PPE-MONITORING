// patches/part23a_sounds_priority.mjs  (run from repo root: node patches/partNN_name.mjs [--dry] [--force])
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
  putB64('tools/gen_sounds.py', 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJ0b29scy9nZW5fc291bmRzLnB5IChQMjNhLCBkZXNpZ24gMy4xMiAnU291bmQgZmlsZXMnKTogd3JpdGVzIHRoZSBob3N0IGFsYXJtIFdBViBmaWxlcyBhbmQgaG9zdC9zb3VuZHMvbWFuaWZlc3QuanNvbiAoU0hBLTI1NiBvZiBldmVyeSBmaWxlKS4KU3RhbmRhcmQgbGlicmFyeSBvbmx5LCBhbmQgZGV0ZXJtaW5pc3RpYzogdGhlIHNhbWUgY29kZSBhbHdheXMgZ2l2ZXMgdGhlIHNhbWUgYnl0ZXMsIHNvIGAtLWNoZWNrYCBjYW4gcHJvdmUgdGhlIGNvbW1pdHRlZCBmaWxlcyBhcmUgdGhlIGdlbmVyYXRvcidzIG91dHB1dC4KUnVuOiBweXRob24gdG9vbHMvZ2VuX3NvdW5kcy5weSBbLS1vdXQgRElSXSBbLS1jaGVja10uIFdpdGhvdXQgLS1vdXQgdGhlIGZpbGVzIGdvIHRvIGhvc3Qvc291bmRzLy4KVm9sdW1lcyAoZGVzaWduIDMuNDogY2hpbWUgYWJvdXQgYSBxdWFydGVyIG9mIGJlZXAsIGJlZXAgcXVpZXRlciB0aGFuIHNpcmVuKSBhcmUgcGVhayBsZXZlbHMgYXMgYSBmcmFjdGlvbiBvZiBmdWxsIHNjYWxlLCBzZXQgaW4gU1BFQyBiZWxvdy4KVGhleSBhcmUgc291bmQgZGVzaWduLCBub3Qgc2FmZXR5IHRocmVzaG9sZHMsIGFuZCBhcmUgbGlzdGVkIGluIEFEUiAwMDI2IGZvciBjb25maXJtYXRpb24uIFRoZSAxMDAgbXMgc2lsZW50IHByb2JlIGlzIHRoZSBhdWRpbyBzZWxmLWNoZWNrIGZpbGUgb2YgMy4xMi4iIiIKaW1wb3J0IGFyZ3BhcnNlLCBoYXNobGliLCBqc29uLCBtYXRoLCBzdHJ1Y3QsIHN5cywgd2F2ZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKClJBVEUgPSAyMjA1MApPVVRfREVGQVVMVCA9IFBhdGgoX19maWxlX18pLnJlc29sdmUoKS5wYXJlbnRzWzFdIC8gJ2hvc3QnIC8gJ3NvdW5kcycKTEVWRUwgPSB7J3NpcmVuJzogMC45MCwgJ2JlZXAnOiAwLjUwLCAnY2hpbWUnOiAwLjEyNX0gICAjIGNoaW1lID0gYmVlcCAvIDQ7IGhvc3RfY2hpbWUgdXNlcyB0aGUgY2hpbWUgbGV2ZWw7IG9uZV9iZWVwIHVzZXMgdGhlIGJlZXAgbGV2ZWwKCmRlZiB0b25lKGZyZXEsIG1zLCBwZWFrLCBkZWNheT1GYWxzZSwgZmFkZV9tcz04KToKICAgIG4gPSBpbnQoUkFURSAqIG1zIC8gMTAwMCk7IG91dCA9IFtdCiAgICBmb3IgaSBpbiByYW5nZShuKToKICAgICAgICBlbnYgPSBtaW4oMS4wLCBpIC8gKFJBVEUgKiBmYWRlX21zIC8gMTAwMCksIChuIC0gMSAtIGkpIC8gKFJBVEUgKiBmYWRlX21zIC8gMTAwMCkgaWYgZmFkZV9tcyBlbHNlIDEuMCkgICAjIHNob3J0IGZhZGUgaW4gYW5kIG91dDogbm8gY2xpY2tzCiAgICAgICAgaWYgZGVjYXk6IGVudiAqPSBtYXRoLmV4cCgtMy4wICogaSAvIG4pCiAgICAgICAgb3V0LmFwcGVuZChwZWFrICogZW52ICogbWF0aC5zaW4oMiAqIG1hdGgucGkgKiBmcmVxICogaSAvIFJBVEUpKQogICAgcmV0dXJuIG91dApkZWYgZ2FwKG1zKTogcmV0dXJuIFswLjBdICogaW50KFJBVEUgKiBtcyAvIDEwMDApCgpTUEVDID0geyAgICMgbmFtZSAtPiBzYW1wbGVzIChmbG9hdHMgaW4gLTEuLjEpLiBMZW5ndGhzOiBzaXJlbiBvbmUgMS42IHMgY3ljbGUgKHRoZSBob3N0IHJlcGVhdHMgaXQpOyBiZWVwIG9uZSBkb3VibGUgYmVlcCAodGhlIGhvc3QgcmVwZWF0cyBpdCBldmVyeSAxMCBzKQogICAgJ3NpcmVuJzogbGFtYmRhOiBzdW0oKHRvbmUoZiwgMjAwLCBMRVZFTFsnc2lyZW4nXSkgZm9yIGYgaW4gKDcwMCwgOTUwLCA3MDAsIDk1MCwgNzAwLCA5NTAsIDcwMCwgOTUwKSksIFtdKSwKICAgICdiZWVwJzogbGFtYmRhOiB0b25lKDEwMDAsIDE1MCwgTEVWRUxbJ2JlZXAnXSkgKyBnYXAoMTAwKSArIHRvbmUoMTAwMCwgMTUwLCBMRVZFTFsnYmVlcCddKSwKICAgICdvbmVfYmVlcCc6IGxhbWJkYTogdG9uZSgxMDAwLCAxNTAsIExFVkVMWydiZWVwJ10pLAogICAgJ2NoaW1lJzogbGFtYmRhOiB0b25lKDY2MCwgNDAwLCBMRVZFTFsnY2hpbWUnXSwgZGVjYXk9VHJ1ZSksCiAgICAnaG9zdF9jaGltZSc6IGxhbWJkYTogdG9uZSg1MjMsIDI1MCwgTEVWRUxbJ2NoaW1lJ10pICsgdG9uZSg3ODQsIDM1MCwgTEVWRUxbJ2NoaW1lJ10sIGRlY2F5PVRydWUpLCAgICMgdHdvIG5vdGVzLCByaXNpbmc6IHVubGlrZSBldmVyeSBhbGFybQogICAgJ3Byb2JlJzogbGFtYmRhOiBnYXAoMTAwKSwgICAjIDEwMCBtcyBvZiBzaWxlbmNlIGZvciB0aGUgNjAgcyBzZWxmLWNoZWNrCn0KRklMRVMgPSB0dXBsZShmICsgJy53YXYnIGZvciBmIGluIFNQRUMpCgpkZWYgd2F2X2J5dGVzKHNhbXBsZXMpOgogICAgaW1wb3J0IGlvCiAgICBidWYgPSBpby5CeXRlc0lPKCkKICAgIHdpdGggd2F2ZS5vcGVuKGJ1ZiwgJ3diJykgYXMgdzoKICAgICAgICB3LnNldG5jaGFubmVscygxKTsgdy5zZXRzYW1wd2lkdGgoMik7IHcuc2V0ZnJhbWVyYXRlKFJBVEUpCiAgICAgICAgdy53cml0ZWZyYW1lcyhiJycuam9pbihzdHJ1Y3QucGFjaygnPGgnLCBtYXgoLTMyNzY3LCBtaW4oMzI3NjcsIHJvdW5kKHMgKiAzMjc2NykpKSkgZm9yIHMgaW4gc2FtcGxlcykpCiAgICByZXR1cm4gYnVmLmdldHZhbHVlKCkKCmRlZiByZW5kZXIoKToKICAgICIiIntmaWxlIG5hbWU6IGJ5dGVzfSBmb3IgZXZlcnkgV0FWIHBsdXMgJ21hbmlmZXN0Lmpzb24nLiIiIgogICAgZmlsZXMgPSB7bmFtZSArICcud2F2Jzogd2F2X2J5dGVzKGZuKCkpIGZvciBuYW1lLCBmbiBpbiBTUEVDLml0ZW1zKCl9CiAgICBtYW5pZmVzdCA9IHsncmF0ZV9oeic6IFJBVEUsICdmaWxlcyc6IHtrOiBoYXNobGliLnNoYTI1Nih2KS5oZXhkaWdlc3QoKSBmb3IgaywgdiBpbiBzb3J0ZWQoZmlsZXMuaXRlbXMoKSl9fQogICAgZmlsZXNbJ21hbmlmZXN0Lmpzb24nXSA9IChqc29uLmR1bXBzKG1hbmlmZXN0LCBpbmRlbnQ9MSwgc29ydF9rZXlzPVRydWUpICsgJ1xuJykuZW5jb2RlKCd1dGYtOCcpCiAgICByZXR1cm4gZmlsZXMKCmRlZiBtYWluKGFyZ3Y9Tm9uZSk6CiAgICBwID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoKTsgcC5hZGRfYXJndW1lbnQoJy0tb3V0JywgZGVmYXVsdD1zdHIoT1VUX0RFRkFVTFQpKTsgcC5hZGRfYXJndW1lbnQoJy0tY2hlY2snLCBhY3Rpb249J3N0b3JlX3RydWUnLCBoZWxwPSdjb21wYXJlLCB3cml0ZSBub3RoaW5nJykKICAgIGEgPSBwLnBhcnNlX2FyZ3MoYXJndik7IG91dCA9IFBhdGgoYS5vdXQpOyB3YW50ID0gcmVuZGVyKCkKICAgIGlmIGEuY2hlY2s6CiAgICAgICAgYmFkID0gW2sgZm9yIGssIHYgaW4gd2FudC5pdGVtcygpIGlmIG5vdCAob3V0IC8gaykuZXhpc3RzKCkgb3IgKG91dCAvIGspLnJlYWRfYnl0ZXMoKSAhPSB2XQogICAgICAgIHByaW50KCdnZW5fc291bmRzOiAnICsgKCdmaWxlcyBkaWZmZXI6ICcgKyAnLCAnLmpvaW4oYmFkKSBpZiBiYWQgZWxzZSAnYWxsICVkIGZpbGVzIG1hdGNoJyAlIGxlbih3YW50KSkpOyByZXR1cm4gMSBpZiBiYWQgZWxzZSAwCiAgICBvdXQubWtkaXIocGFyZW50cz1UcnVlLCBleGlzdF9vaz1UcnVlKQogICAgZm9yIGssIHYgaW4gd2FudC5pdGVtcygpOiAob3V0IC8gaykud3JpdGVfYnl0ZXModikKICAgIHByaW50KCdnZW5fc291bmRzOiB3cm90ZSAlZCBmaWxlcyB0byAlcycgJSAobGVuKHdhbnQpLCBvdXQpKTsgcmV0dXJuIDAKaWYgX19uYW1lX18gPT0gJ19fbWFpbl9fJzogc3lzLmV4aXQobWFpbigpKQo=');
  put('host/ppe_host/io/audio_watchdog.py', String.raw`"""io/audio_watchdog.py (P23a: sound files and priority; P23b adds the AudioThread, the self-check, the zero-socket warning and the fallback pulse).
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
`);
  put('host/tests/test_audio_files.py', String.raw`"""P23a: host WAV files, manifest check at start-up, volume order and the full Rev 3.17 priority list (design 3.12, 3.3, 3.4).
If a sound test says the files are missing or differ, run: python tools/gen_sounds.py"""
import importlib.util, shutil, struct, sys, wave
from pathlib import Path
import pytest
from ppe_host.io import audio_watchdog as aw
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('gen_sounds', ROOT / 'tools' / 'gen_sounds.py'); gs = importlib.util.module_from_spec(spec)
sys.modules['gen_sounds'] = gs; spec.loader.exec_module(gs)
CAT = aw.load_catalog()
def samples(name):
    with wave.open(str(aw.SOUNDS_DIR / (name + '.wav'))) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, gs.RATE)
        raw = w.readframes(w.getnframes())
    return struct.unpack('<%dh' % (len(raw) // 2), raw)
def peak(name): return max(abs(x) for x in samples(name))
def crossings(xs): return sum(1 for a, b in zip(xs, xs[1:]) if (a < 0) != (b < 0))

def test_every_catalog_sound_name_has_a_wav_and_skips_none_and_browser_siren():   # design 3.12 (D8)
    names = aw.catalog_sound_names(CAT)
    assert names == {'beep', 'chime', 'one_beep', 'siren'}
    for n in names: assert (aw.SOUNDS_DIR / (n + '.wav')).is_file(), n
def test_committed_files_pass_the_startup_manifest_check(): assert aw.check_sounds() == []
def test_gen_sounds_regenerates_the_committed_files_exactly(): assert gs.main(['--check']) == 0
def test_gen_sounds_writes_to_another_folder_and_the_check_passes_there(tmp_path):
    assert gs.main(['--out', str(tmp_path)]) == 0 and gs.main(['--out', str(tmp_path), '--check']) == 0
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(gs.FILES + ('manifest.json',))
def test_missing_file_raises_audio_fault_reason(tmp_path):
    gs.main(['--out', str(tmp_path)]); (tmp_path / 'beep.wav').unlink()
    assert aw.check_sounds(tmp_path, CAT) == [('beep.wav', 'missing')]
def test_altered_file_raises_audio_fault_reason(tmp_path):
    gs.main(['--out', str(tmp_path)]); b = bytearray((tmp_path / 'siren.wav').read_bytes()); b[100] ^= 1; (tmp_path / 'siren.wav').write_bytes(bytes(b))
    assert aw.check_sounds(tmp_path, CAT) == [('siren.wav', 'altered')]
def test_missing_or_broken_manifest_is_a_fault(tmp_path):
    gs.main(['--out', str(tmp_path)]); (tmp_path / 'manifest.json').write_text('{not json')
    assert aw.check_sounds(tmp_path, CAT) == [('manifest.json', 'unreadable')]
    (tmp_path / 'manifest.json').unlink(); assert aw.check_sounds(tmp_path, CAT) == [('manifest.json', 'missing')]
def test_catalog_sound_missing_from_manifest_is_a_fault(tmp_path):
    import json
    gs.main(['--out', str(tmp_path)]); m = json.loads((tmp_path / 'manifest.json').read_text()); del m['files']['chime.wav']; (tmp_path / 'manifest.json').write_text(json.dumps(m))
    assert aw.check_sounds(tmp_path, CAT) == [('chime.wav', 'not in manifest')]
def test_volume_order_siren_over_beep_and_chime_about_a_quarter_of_beep():   # design 3.4
    s, b, c = peak('siren'), peak('beep'), peak('chime')
    assert s > b > c and abs(c - b / 4) <= b / 4 * 0.1
    assert peak('one_beep') == b and peak('host_chime') <= b
def test_host_chime_is_two_notes_rising_and_unlike_every_alarm():
    x = samples('host_chime'); half = len(x) * 250 // 600   # note 1 is 250 ms of 600 ms
    first, second = x[:half - 50], x[half + 50:]
    assert crossings(second) / len(second) > crossings(first) / len(first) * 1.3
    assert len(x) != len(samples('chime'))
def test_probe_is_100_ms_of_silence():
    x = samples('probe'); assert len(x) == gs.RATE // 10 and not any(x)
def test_siren_has_two_tones(): 
    x = samples('siren'); step = gs.RATE * 200 // 1000
    assert crossings(x[step + 20:2 * step - 20]) / (step - 40) > crossings(x[20:step - 20]) / (step - 40) * 1.2

@pytest.mark.parametrize('t, lvl, want', [('mayday', 'DANGER', (2, 'siren')), ('man_down', 'DANGER', (2, 'siren')), ('base_offline', 'DANGER', (3, 'siren')),
    ('co_threshold', 'DANGER', (4, 'siren')), ('link_lost', 'DANGER', (4, 'siren')), ('node_danger', 'DANGER', (4, 'siren')), ('sensor_fault', 'DANGER', (4, 'siren')), ('scba_expired', 'DANGER', (4, 'siren')),
    ('co_threshold', 'WARNING', (5, 'beep')), ('heat', 'WARNING', (5, 'beep')), ('logging_fault', 'WARNING', (5, 'beep')), ('host_power', 'WARNING', (5, 'beep')),
    ('unauth_alert', 'NONE', (6, 'beep')), ('recovering', 'NONE', (7, 'one_beep')), ('host_gap', 'NONE', (7, 'one_beep')), ('estimate', 'NONE', (8, 'chime'))])
def test_full_rev_3_17_priority_list(t, lvl, want): assert aw.host_rank(t, lvl, CAT) == want
@pytest.mark.parametrize('t, lvl', [('no_live_data', 'DANGER'), ('audio_fault', 'WARNING'), ('audio_fault', 'NONE'), ('node_reboot', 'NONE'), ('shadow_notice', 'NONE'), ('host_power', 'NONE'), ('no_such_type', 'DANGER'), ('man_down', 'WARNING')])
def test_host_is_silent_for_browser_only_notice_and_unknown(t, lvl): assert aw.host_rank(t, lvl, CAT) is None
def test_every_catalog_row_with_a_sound_has_a_rank_except_the_browser_siren():
    for t, e in CAT.items():
        for lvl, snd in e['sound_by_level'].items():
            r = aw.host_rank(t, lvl, CAT)
            if snd in aw.NO_FILE: assert r is None, (t, lvl)
            else: assert r is not None and r[1] == snd, (t, lvl)
def it(t, lvl, acked=False): return {'alert_type': t, 'level': lvl, 'acknowledged': acked}
def test_pick_takes_the_highest_class_and_never_the_browser_siren():
    items = [it('estimate', 'NONE'), it('host_gap', 'NONE'), it('unauth_alert', 'NONE'), it('heat', 'WARNING'), it('co_threshold', 'DANGER'), it('base_offline', 'DANGER'), it('man_down', 'DANGER'), it('no_live_data', 'DANGER')]
    order = []
    while items:
        p = aw.pick(items, CAT); order.append(p[0]); items = [i for i in items if i['alert_type'] != p[2] and i['alert_type'] != 'no_live_data']
    assert order == [2, 3, 4, 5, 6, 7, 8]
def test_pick_skips_acknowledged_and_returns_none_when_nothing_sounds():
    assert aw.pick([it('man_down', 'DANGER', True), it('heat', 'WARNING')], CAT) == (5, 'beep', 'heat')
    assert aw.pick([it('man_down', 'DANGER', True)], CAT) is None and aw.pick([], CAT) is None
`);
  putB64('docs/adr/0026.md', 'IyBBRFIgMDAyNjogaG9zdCBzb3VuZCBmaWxlcywgcHJpb3JpdHkgYW5kIHRoZSB6ZXJvLXNvY2tldCB3YXJuaW5nIChQMjNhKQoKU3RhdHVzOiBQcm9wb3NlZCAoZGVjaWRlZCBpbiB0aGUgUDIzIHNlc3Npb247IGNvbmZpcm0gYXQgdGhlIG5leHQgZGVzaWduIHJldmlldykuCkRlc2lnbjogUmV2IDMuNDUgaXMgZnJvemVuLiBOb3RoaW5nIGluIHRoZSBmcmFtZSwgdGhlIG1pZ3JhdGlvbiBvciBgY29uc3RhbnRzLmpzb25gIGNoYW5nZXMuCgotICoqWmVyby1zb2NrZXQgd2FybmluZzogQlVJTEQgKG9wZXJhdG9yIGRlY2lzaW9uLCBQMjMgc2Vzc2lvbikuKiogVGhlIGRlc2lnbiBjb250cmFkaWN0cyBpdHNlbGY6IFNlY3Rpb24gMSAocGFja2FnaW5nKSBhbmQgdGhlIEQ4IHJvdyAiQnJvd3NlciBmcmVlemUgYW5kIGhlYWRsZXNzIGFsYXJtIiBrZWVwIGEgbGFwdG9wIHdhcm5pbmcgd2hlbiBubyBhdXRoZW50aWNhdGVkIGAvd3NgIHNvY2tldCBoYXMgYmVlbiBjb25uZWN0ZWQgZm9yIG1vcmUgdGhhbiAxMCBzIHdoaWxlIGBtb25pdG9yaW5nX2FjdGl2ZT10cnVlYDsgMy4xMiByZW1vdmVkIHRoZSBvbGRlciAiemVybyB0YWJzIHJlcG9ydCBhdWRpb191bmxvY2tlZCIgcnVsZSAoYSBkaWZmZXJlbnQgdGVzdCkgYW5kIHNheXMgdGhlIGhvc3QgYWxhcm0gInBsYXlzIHJlZ2FyZGxlc3MiOyBhbmQgYHplcm9fc29ja2V0X2FsYXJtX3NgIHdhcyBkZWxldGVkIGluIFJldiAzLjMwLiBUaGUgb3BlcmF0b3IgY2hvc2UgdG8gYnVpbGQgaXQuIEl0IGlzIGJ1aWx0IGluIFAyM2IgYXMgYSBmaXhlZCAxMCBzIGluIGBhdWRpb193YXRjaGRvZy5weWAsIG5vdCBhIHNldHRpbmdzIGtleSwgYmVjYXVzZSB0aGUgc2V0dGluZ3Mga2V5cyBhcmUgZnJvemVuIGFuZCB0aGUga2V5IHdhcyBkZWxldGVkLiBXaGV0aGVyIDkuMSB3YW50cyBhIHN0b3AgcnVsZSBmb3IgaXQgc3RheXMgb3BlbjogUDIzYiBnaXZlcyBpdCBub25lIChpdCBzdG9wcyB3aGVuIGEgdGFiIHJlY29ubmVjdHMgb3IgbW9uaXRvcmluZyBlbmRzKSwgYmVjYXVzZSBBY2tub3dsZWRnZSBpcyBmb3IgYWxlcnRzIGFuZCB0aGlzIHdhcm5pbmcgaGFzIG5vIGFsZXJ0LgotICoqU291bmQgZmlsZXM6KiogYHRvb2xzL2dlbl9zb3VuZHMucHlgIChzdGFuZGFyZCBsaWJyYXJ5IG9ubHksIGRldGVybWluaXN0aWMpIHdyaXRlcyBgc2lyZW4ud2F2YCwgYGJlZXAud2F2YCwgYG9uZV9iZWVwLndhdmAsIGBjaGltZS53YXZgLCBgaG9zdF9jaGltZS53YXZgIGFuZCBgcHJvYmUud2F2YCAoMTAwIG1zIG9mIHNpbGVuY2UgZm9yIHRoZSA2MCBzIHNlbGYtY2hlY2spIHBsdXMgYGhvc3Qvc291bmRzL21hbmlmZXN0Lmpzb25gIChTSEEtMjU2IG9mIGVhY2ggZmlsZSkgaW50byBgaG9zdC9zb3VuZHMvYC4gYC0tY2hlY2tgIHByb3ZlcyB0aGUgY29tbWl0dGVkIGZpbGVzIGFyZSB0aGUgZ2VuZXJhdG9yJ3Mgb3V0cHV0LiBBIHBhdGNoIHdyaXRlcyB0ZXh0IG9ubHksIHNvIHJ1biBgcHl0aG9uIHRvb2xzL2dlbl9zb3VuZHMucHlgIG9uY2UgYW5kIGNvbW1pdCB0aGUgZmlsZXMgKGAuZ2l0YXR0cmlidXRlc2AgYWxyZWFkeSBtYXJrcyBgKi53YXZgIGJpbmFyeSkuCi0gKipWb2x1bWVzIChwcm9wb3NhbHMsIHNvdW5kIGRlc2lnbiBhbmQgbm90IHNhZmV0eSB0aHJlc2hvbGRzKToqKiBwZWFrIGFzIGEgZnJhY3Rpb24gb2YgZnVsbCBzY2FsZTogc2lyZW4gMC45MCwgYmVlcCAwLjUwLCBvbmVfYmVlcCAwLjUwLCBjaGltZSAwLjEyNSAoYSBxdWFydGVyIG9mIGJlZXAsIGFzIDMuNCBzYXlzKSwgaG9zdF9jaGltZSAwLjEyNS4gMy40IGdpdmVzIG9ubHkgdGhlIHJhdGlvczsgYGhvc3RfY2hpbWVgIGhhcyBubyBzdGF0ZWQgbGV2ZWwsIHNvIGl0IHVzZXMgdGhlIGNoaW1lIGxldmVsLiBUaGUgb3BlcmF0b3IgbXVzdCBoZWFyIHRoZSAxNSBtaW51dGUgY2hpbWUgKDMuOSksIHNvIGNoZWNrIGl0IG9uIHRoZSByZWFsIHNwZWFrZXJzIGF0IHRoZSBiZW5jaCBhbmQgcmFpc2UgaXQgaGVyZSBpZiBpdCBpcyB0b28gcXVpZXQuCi0gKipTdGFydC11cCBjaGVjazoqKiBgY2hlY2tfc291bmRzKClgIGNvbXBhcmVzIGV2ZXJ5IGZpbGUgd2l0aCB0aGUgbWFuaWZlc3QgYW5kIHJldHVybnMgYChmaWxlLCByZWFzb24pYCBwYWlyczogYG1pc3NpbmdgLCBgYWx0ZXJlZGAsIGBub3QgaW4gbWFuaWZlc3RgIChhIGNhdGFsb2cgc291bmQgdGhlIG1hbmlmZXN0IGxhY2tzKSwgb3IgYSBgbWFuaWZlc3QuanNvbmAgdGhhdCBpcyBtaXNzaW5nIG9yIHVucmVhZGFibGUuIFAyM2IgcmFpc2VzIGBBVURJT19GQVVMVGAgZm9yIGEgbm9uLWVtcHR5IGxpc3QuCi0gKipQcmlvcml0eSAoMy4zLCBSZXYgMy4xNyBjb21wbGV0ZSBsaXN0KToqKiBgaG9zdF9yYW5rKClgIHJldHVybnMgMiBNQVlEQVkgYW5kIG1hbi1kb3duLCAzIEJBU0UgT0ZGTElORSwgNCBvdGhlciBEQU5HRVIgKHNpcmVuKSwgNSBXQVJOSU5HIGFuZCB0aGUgTE9HR0lORyBGQVVMVCBhbmQgSE9TVCBCQVRURVJZIGJhbm5lcnMgKGJlZXApLCA2IFVOQVVUSEVOVElDQVRFRCBBTEVSVCAoYmVlcCksIDcgUkVDT1ZFUklORyBhbmQgSE9TVF9HQVAgKG9uZSBiZWVwKSwgOCBlc3RpbWF0ZSAoY2hpbWUpLiBSYW5rIDEsIE5PIExJVkUgREFUQSwgaXMgdGhlIGJyb3dzZXIgc2lyZW4gYW5kIHRoZSBob3N0IHN0YXlzIHNpbGVudCBmb3IgaXQsIGFzIGl0IGRvZXMgZm9yIEFVRElPIEZBVUxUICh2aXN1YWwgb25seSksIG5vdGljZXMgYW5kIHVua25vd24gdHlwZXMuCi0gKipDbGVhcmVkIGJ1dCBub3QgYWNrbm93bGVkZ2VkICh0byBjb25maXJtKToqKiBgcGljaygpYCBrZWVwcyBzb3VuZGluZyBhbiBhbGVydCB0aGF0IGhhcyBjbGVhcmVkIGJ1dCBpcyBub3QgYWNrbm93bGVkZ2VkLCBmb2xsb3dpbmcgMy4zICgic291bmQgY29udGludWVzIHdoaWxlIGFueSBzYWZldHkgY2FyZCBpcyB1bmFja25vd2xlZGdlZCIpIGFuZCB0aGUgU2VjdGlvbiAxIHRleHQgKCJhbnkgdW5hY2tub3dsZWRnZWQgREFOR0VSL1dBUk5JTkcgYWxlcnQiKS4gMy4zIGFsc28gc2F5cyBzdWNoIGEgY2FyZCBzdGF5cyBzbyBhIHNob3J0IHNwaWtlIGlzIG5ldmVyIG1pc3NlZCwgd2hpY2ggY291bGQgbWVhbiBvbmx5ICJzZWVuIi4gSWYgdGhlIG9wZXJhdG9yIHdhbnRzIHRoZSBzb3VuZCB0byBzdG9wIGF0IGNsZWFyaW5nLCBjaGFuZ2Ugb25lIGNvbmRpdGlvbiBpbiBgcGljaygpYC4KLSAqKkNMSToqKiBgY2xpIGFjayAtLW5vZGUgTmAgc3RheXMgd2l0aCBQMjQgYXMgQURSIDAwMDkgc2F5cyAoaXQgbmVlZHMgdGhlIHJ1bm5pbmcgaG9zdCkuIFAyM2IgYWRkcyB0aGUgb2ZmbGluZSBgdGVzdC1hbGFybWAgY29tbWFuZCBmb3IgdGhlIHNoaWZ0IHNwZWFrZXIgY2hlY2suCg==');
  replace('justfile', '    python tools/gen_ws_schema.py\n\n# P1: design document consistency', '    python tools/gen_ws_schema.py\n    python tools/gen_sounds.py\n\n# P1: design document consistency');
  append('docs/PROGRESS.md', '- Part 23a done: host sound files and priority (tools/gen_sounds.py writes siren, beep, one_beep, chime, host_chime and a 100 ms silent probe WAV plus host/sounds/manifest.json, deterministic, with --check; io/audio_watchdog.py: check_sounds start-up check of every file against the manifest, host_rank and pick with the full Rev 3.17 priority list, no sound card used; host/tests/test_audio_files.py; docs/adr/0026.md records the operator answer to BUILD the zero-socket warning in P23b); run python tools/gen_sounds.py and commit host/sounds/; next is P23b (AudioThread, self-check, zero-socket warning, fallback pulse, test-alarm command)');
}
