"""P23a: host WAV files, manifest check at start-up, volume order and the full Rev 3.17 priority list (design 3.12, 3.3, 3.4).
If a sound test says the files are missing or differ, run: python tools/gen_sounds.py"""
import importlib.util, struct, sys, wave
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
