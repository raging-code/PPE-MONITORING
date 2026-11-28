#!/usr/bin/env python3
"""tools/audio_probe.py -- the audio probe of CODING_GUIDE.md Section 6: "The 130,000-frame benchmark
... and the audio probe, both on the laptop." The write-commit half is covered by tools/bench_writer.py
and ADR 0066; this is the other half.

This is a standalone script, NOT a host feature. It is not part of ppe_host, not imported by it, and
it is not wired into the CLI, CI, or justfile. It is meant to be run by a person on the actual field
laptop, with its actual speaker, and the result (a reaction-time number only a human can give) copied
into an ADR, per Section 6's own rule that this decision is "not for chat".

What the design actually gates (design 5, "broadcast to host alarm start within 300 ms", referenced in
P23's CODING_GUIDE.md row) is already tested in host/tests/test_audio_wiring.py -- but only with a FAKE
audio backend: that test proves AudioThread calls backend.play() within 300 ms of an alert, not that a
sound is actually audible from the laptop speaker within 300 ms of that call. winsound.PlaySound with
SND_ASYNC returns once Windows has accepted the request, not once sound is leaving the speaker, and
nothing in the test suite times the real device. That gap -- real call-to-audible latency on the real
hardware -- is what this script measures. It uses the host's own WinsoundBackend (io/audio_watchdog.py)
and real WAV files (host/sounds/), so the measurement is of the exact code path the host uses, not a
reimplementation.

Two things this script measures:

  1. Call latency: wall-clock time from backend.play() returning to the next instruction, for each of
     the real alarm sounds (siren, beep, one_beep, chime, the 100 ms silent probe). This is fast and
     objective (winsound.PlaySound with SND_ASYNC is meant to return almost immediately), and mostly
     confirms the call itself is not blocking -- it cannot prove perceived loudness or audibility.
  2. Human-judged audible latency: the script prompts you, plays a sound, and you press Enter the
     instant you hear it. This requires a person: it is not something a script can measure on its own
     without an external microphone and a separate timing rig, and this tool does not assume you have
     one. Several repeats are averaged and the spread is shown, because human reaction time varies.

It is not a substitute for the real bench timing gates ("man-down latch to dashboard ... camera at 120
fps or more") which CODING_GUIDE.md Section 6 also lists as something a camera must measure end to end,
sensor to speaker; this script starts its clock at backend.play(), not at the sensor frame, so it is
only the audio-hardware link in that chain.

Usage (from the repo root, with the host package importable -- i.e. run from inside host/, or with
host/ on PYTHONPATH). Windows only (it uses the host's real WinsoundBackend); on any other OS it still
runs the call-latency pass against a backend stub and says so.

    cd host
    python ..\\tools\\audio_probe.py
    python ..\\tools\\audio_probe.py --repeats 5       # more human-timed repeats per sound (default 3)
    python ..\\tools\\audio_probe.py --skip-human      # call-latency pass only, no prompts
    python ..\\tools\\audio_probe.py --volume-check    # a loudness reminder for the pycaw sign-off item

Run it with the laptop set up as it will be for a real shift: same speaker (built-in or external, same
as the shift plan), same OS volume level, same room if background noise matters to you. This script
cannot check whether the volume is loud enough to be heard over a noisy environment -- that judgement,
like the whole probe, is yours to make and record.
"""
import argparse, os, statistics, sys, time

_HERE = os.path.dirname(os.path.abspath(__file__))
for _base in (os.getcwd(), _HERE, os.path.dirname(_HERE)):
    _candidate = os.path.join(_base, 'host')
    if os.path.isdir(os.path.join(_candidate, 'ppe_host')):
        sys.path.insert(0, _candidate)
        break
    if os.path.isdir(os.path.join(_base, 'ppe_host')):
        sys.path.insert(0, _base)
        break

try:
    from ppe_host.io.audio_watchdog import WinsoundBackend, SOUNDS_DIR, check_sounds
except ImportError as e:
    print("Could not import ppe_host.io.audio_watchdog (%s)." % e, file=sys.stderr)
    print("Run this from inside the host/ folder of the repo, e.g.:", file=sys.stderr)
    print("    cd host && python ..\\tools\\audio_probe.py", file=sys.stderr)
    sys.exit(1)

# The real alarm sounds in the priority order of design 3.3 (siren is DANGER, beep is WARNING, one_beep
# and chime are lower-priority notices), plus the 100 ms silent self-check probe. 'siren' loops, so it
# is stopped by hand after the timed window rather than waited on to finish.
SOUNDS = [
    ('siren.wav', 'siren (DANGER / man-down)', True),
    ('beep.wav', 'beep (WARNING)', False),
    ('one_beep.wav', 'one_beep (notice)', False),
    ('chime.wav', 'chime (shift chime)', False),
    ('probe.wav', 'probe (100 ms silent self-check)', False),
]


class StubBackend:
    """Used only on a non-Windows machine, or if winsound is unavailable, so the call-latency pass can
    still run and say clearly that nothing was actually played. The human-timed pass is skipped in that
    case: there's nothing to hear."""
    def play(self, path, loop=False, wait=False):
        if wait:
            time.sleep(0.05)
    def stop(self):
        pass


def get_backend():
    try:
        import winsound  # noqa: F401
        return WinsoundBackend(), True
    except ImportError:
        return StubBackend(), False


def call_latency_pass(backend, sounds_dir, real):
    """Time how long backend.play() itself takes to return, for each sound. Fast and objective, but
    only proves the call is non-blocking -- not that sound is audible."""
    print('\n=== Pass 1: call latency (backend.play() return time) ===')
    if not real:
        print('winsound is not available on this machine (not Windows, or no sound subsystem).')
        print('Running against a stub backend: these numbers do NOT reflect real hardware.\n')
    results = []
    for fname, label, loops in SOUNDS:
        path = os.path.join(str(sounds_dir), fname)
        if not os.path.exists(path):
            print('  %-40s SKIPPED (file not found: %s)' % (label, path))
            continue
        t0 = time.perf_counter()
        try:
            backend.play(path, loop=loops, wait=False)
        except (RuntimeError, OSError) as e:
            print('  %-40s FAILED to play: %s' % (label, e))
            continue
        dt_ms = (time.perf_counter() - t0) * 1000.0
        if loops:
            time.sleep(0.5)
            backend.stop()
        else:
            time.sleep(0.3)
        print('  %-40s call returned in %.1f ms' % (label, dt_ms))
        results.append((label, dt_ms))
    return results


def human_timed_pass(backend, sounds_dir, repeats):
    """Prompt, play, and have the person press Enter the instant they hear it. This is the only way to
    answer the real question (audible latency, on this speaker, in this room) without extra hardware."""
    print('\n=== Pass 2: human-judged audible latency ===')
    print('For each sound: press Enter, wait, then press Enter again the INSTANT you hear it.')
    print('This measures your reaction time plus real audio latency together -- a rough but honest')
    print('number, repeated a few times so you can see the spread.\n')
    summary = []
    for fname, label, loops in SOUNDS:
        if fname == 'probe.wav':
            continue  # a 100 ms silent self-check WAV has nothing to hear by design; skip it here
        path = os.path.join(str(sounds_dir), fname)
        if not os.path.exists(path):
            print('  %-40s SKIPPED (file not found)' % label)
            continue
        times_ms = []
        for i in range(repeats):
            input('  [%s] rep %d/%d: press Enter to play it...' % (label, i + 1, repeats))
            t0 = time.perf_counter()
            try:
                backend.play(path, loop=loops, wait=False)
            except (RuntimeError, OSError) as e:
                print('    FAILED to play: %s' % e)
                break
            input('    press Enter the instant you hear it...')
            dt_ms = (time.perf_counter() - t0) * 1000.0
            times_ms.append(dt_ms)
            if loops:
                backend.stop()
            print('    -> %.0f ms' % dt_ms)
        if times_ms:
            med = statistics.median(times_ms)
            print('  %-40s median %.0f ms over %d rep(s) (min %.0f, max %.0f)\n'
                  % (label, med, len(times_ms), min(times_ms), max(times_ms)))
            summary.append((label, med, min(times_ms), max(times_ms), len(times_ms)))
    return summary


def main():
    ap = argparse.ArgumentParser(description='Audio probe: real call latency and human-judged audible latency for the host alarm sounds.')
    ap.add_argument('--repeats', type=int, default=3, help='human-timed repeats per sound (default 3)')
    ap.add_argument('--skip-human', action='store_true', help='call-latency pass only, no prompts')
    ap.add_argument('--volume-check', action='store_true', help='print the pycaw/volume sign-off reminder (design 3.12) and exit')
    ap.add_argument('--sounds-dir', default=None, help='override host/sounds (default: the repo\'s own)')
    args = ap.parse_args()

    if args.volume_check:
        print('Volume sign-off reminder (CODING_GUIDE.md: "pycaw volume check with host_volume_min_pct,')
        print('3.12; if rejected, only the chime and shift-start check detect mute").')
        print('This script does not check or set system volume. Before a shift, by hand:')
        print('  1. Confirm the laptop and its speaker/output device are not muted.')
        print('  2. Confirm the OS volume is at a level you can hear over the expected background noise.')
        print('  3. Run `python -m ppe_host.cli test-alarm` (the shift speaker check) and confirm all')
        print('     three sounds (siren, beep, host_chime) are audible where the operator will be sitting.')
        print('Record the result (pass/fail, volume level, who checked) in the shift record.')
        return

    sounds_dir = args.sounds_dir or SOUNDS_DIR
    bad = check_sounds(sounds_dir)
    if bad:
        print('WARNING: check_sounds() found problems before probing:')
        for f, reason in bad:
            print('  %s: %s' % (f, reason))
        print('Fix these (see host/ppe_host/io/audio_watchdog.py check_sounds) before trusting the probe.\n')

    backend, real = get_backend()
    if not real:
        print('This machine has no winsound (not Windows). The call-latency pass will run against a')
        print('stub and prove nothing about real hardware; the human-timed pass needs a real speaker')
        print('and is skipped.\n')

    call_results = call_latency_pass(backend, sounds_dir, real)

    human_results = []
    if real and not args.skip_human:
        human_results = human_timed_pass(backend, sounds_dir, args.repeats)
    elif not real:
        print('\n(Human-timed pass skipped: no real audio backend on this machine.)')
    else:
        print('\n(Human-timed pass skipped: --skip-human.)')

    print('\n' + '=' * 60)
    print('SUMMARY')
    print('=' * 60)
    if call_results:
        print('\nCall latency (backend.play() return time):')
        for label, dt_ms in call_results:
            print('  %-40s %7.1f ms' % (label, dt_ms))
        print('(This proves the call itself does not block; it is not proof of audible latency.)')
    if human_results:
        print('\nHuman-judged audible latency (median of your repeats):')
        for label, med, lo, hi, n in human_results:
            print('  %-40s %7.0f ms  (min %.0f, max %.0f, n=%d)' % (label, med, lo, hi, n))
        print('\nThe design\'s 300 ms gate (design 5, "broadcast to host alarm start") is measured in the')
        print('test suite from the alert to backend.play() being called, with a fake backend. The numbers')
        print('above are from backend.play() to a human hearing it, on THIS machine\'s real speaker --')
        print('a different, and until now unmeasured, part of the same chain. Record both this run\'s')
        print('numbers and which machine/speaker/room they were measured in, in an ADR.')
    elif not args.skip_human and real:
        print('\n(No human-timed results recorded -- all sounds were skipped or failed.)')

    print('\nNot measured here: end-to-end sensor-to-speaker latency with a camera (CODING_GUIDE.md')
    print('Section 6, "man-down latch to dashboard ... camera at 120 fps or more"), and whether the')
    print('volume is loud enough over real background noise (use --volume-check for that reminder).')


if __name__ == '__main__':
    main()
