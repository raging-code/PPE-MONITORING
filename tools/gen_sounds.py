#!/usr/bin/env python3
"""tools/gen_sounds.py (P23a, design 3.12 'Sound files'): writes the host alarm WAV files and host/sounds/manifest.json (SHA-256 of every file).
Standard library only, and deterministic: the same code always gives the same bytes, so `--check` can prove the committed files are the generator's output.
Run: python tools/gen_sounds.py [--out DIR] [--check]. Without --out the files go to host/sounds/.
Volumes (design 3.4: chime about a quarter of beep, beep quieter than siren) are peak levels as a fraction of full scale, set in SPEC below.
They are sound design, not safety thresholds, and are listed in ADR 0026 for confirmation. The 100 ms silent probe is the audio self-check file of 3.12."""
import argparse, hashlib, json, math, struct, sys, wave
from pathlib import Path

RATE = 22050
OUT_DEFAULT = Path(__file__).resolve().parents[1] / 'host' / 'sounds'
LEVEL = {'siren': 0.90, 'beep': 0.50, 'chime': 0.125}   # chime = beep / 4; host_chime uses the chime level; one_beep uses the beep level

def tone(freq, ms, peak, decay=False, fade_ms=8):
    n = int(RATE * ms / 1000); out = []
    for i in range(n):
        env = min(1.0, i / (RATE * fade_ms / 1000), (n - 1 - i) / (RATE * fade_ms / 1000) if fade_ms else 1.0)   # short fade in and out: no clicks
        if decay: env *= math.exp(-3.0 * i / n)
        out.append(peak * env * math.sin(2 * math.pi * freq * i / RATE))
    return out
def gap(ms): return [0.0] * int(RATE * ms / 1000)

SPEC = {   # name -> samples (floats in -1..1). Lengths: siren one 1.6 s cycle (the host repeats it); beep one double beep (the host repeats it every 10 s)
    'siren': lambda: sum((tone(f, 200, LEVEL['siren']) for f in (700, 950, 700, 950, 700, 950, 700, 950)), []),
    'beep': lambda: tone(1000, 150, LEVEL['beep']) + gap(100) + tone(1000, 150, LEVEL['beep']),
    'one_beep': lambda: tone(1000, 150, LEVEL['beep']),
    'chime': lambda: tone(660, 400, LEVEL['chime'], decay=True),
    'host_chime': lambda: tone(523, 250, LEVEL['chime']) + tone(784, 350, LEVEL['chime'], decay=True),   # two notes, rising: unlike every alarm
    'probe': lambda: gap(100),   # 100 ms of silence for the 60 s self-check
}
FILES = tuple(f + '.wav' for f in SPEC)

def wav_bytes(samples):
    import io
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, round(s * 32767)))) for s in samples))
    return buf.getvalue()

def render():
    """{file name: bytes} for every WAV plus 'manifest.json'."""
    files = {name + '.wav': wav_bytes(fn()) for name, fn in SPEC.items()}
    manifest = {'rate_hz': RATE, 'files': {k: hashlib.sha256(v).hexdigest() for k, v in sorted(files.items())}}
    files['manifest.json'] = (json.dumps(manifest, indent=1, sort_keys=True) + '\n').encode('utf-8')
    return files

def main(argv=None):
    p = argparse.ArgumentParser(); p.add_argument('--out', default=str(OUT_DEFAULT)); p.add_argument('--check', action='store_true', help='compare, write nothing')
    a = p.parse_args(argv); out = Path(a.out); want = render()
    if a.check:
        bad = [k for k, v in want.items() if not (out / k).exists() or (out / k).read_bytes() != v]
        print('gen_sounds: ' + ('files differ: ' + ', '.join(bad) if bad else 'all %d files match' % len(want))); return 1 if bad else 0
    out.mkdir(parents=True, exist_ok=True)
    for k, v in want.items(): (out / k).write_bytes(v)
    print('gen_sounds: wrote %d files to %s' % (len(want), out)); return 0
if __name__ == '__main__': sys.exit(main())
