// patches/part_adr0067_audio_probe_result.mjs  (run from repo root: node patches/part_adr0067_audio_probe_result.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
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
      if (cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
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
put("docs/adr/0067.md", "# ADR 0067: The audio probe (call latency and human-judged audible latency)\n\nStatus: Decided. This closes the second half of the CODING_GUIDE.md Section 6 bullet begun by ADR 0066: \"The 130,000-frame benchmark ... and the audio probe, both on the laptop.\" ADR 0066 covers the write-commit half; this is the audio half.\n\nNo code, wire, setting, migration or constants change. This does not replace or alter `host/tests/test_audio_wiring.py`'s existing 300 ms test (alert to `backend.play()`, with a fake backend); it measures the part of the chain that test cannot reach: `backend.play()` to an actual human hearing the sound, on the real laptop speaker.\n\n## Tool\n\n`tools/audio_probe.py`, a standalone script (not imported by `ppe_host`, not wired into `cli.py`, CI or the `justfile`). It uses the host's own `WinsoundBackend` and real WAV files (`host/sounds/`), so it exercises the production code path rather than a reimplementation. Two passes:\n\n1. **Call latency** \u2014 wall-clock time from `backend.play()` to it returning, for each real alarm sound. Automatic, no human input.\n2. **Human-judged audible latency** \u2014 the script plays a sound and the operator presses Enter the instant they hear it, repeated 3 times per sound. This is the only way to answer \"is it actually audible in time\" without extra hardware (a microphone and a separate timing rig), which this script does not assume is available.\n\n## Result (field laptop, real speaker, 3 repeats per sound)\n\n| Sound | Call latency | Audible latency (median) | min | max |\n|---|---|---|---|---|\n| siren (DANGER / man-down) | 4.7 ms | 256 ms | 120 ms | 2696 ms |\n| beep (WARNING) | 0.1 ms | 112 ms | 104 ms | 136 ms |\n| one_beep (notice) | 0.2 ms | 128 ms | 128 ms | 128 ms |\n| chime (shift chime) | 0.1 ms | 136 ms | 136 ms | 144 ms |\n| probe (100 ms silent self-check) | 0.7 ms | not timed (silent by design) | \u2014 | \u2014 |\n\nMachine/speaker/room: [FILL IN: laptop model, built-in or external speaker, which room].\n\n**The siren's max (2696 ms, its first of three reps) is a mis-timed button press, not a hardware or software delay**, per the operator's own account at the time of the run. It is kept in the table above rather than dropped, since it was measured and the median (256 ms) already is not pulled meaningfully by it; a reader who wants the cleaner two-rep figure for the siren (120 ms, 256 ms) can use those instead. The other three sounds, each with three closely-clustered reps (spreads of 4 to 32 ms), had no comparable outlier.\n\n## Decision\n\n**No change.** Every sound's audible latency, including the siren's slowest clean rep, lands under the 300 ms design-5 gate with margin (worst clean figure: 256 ms). Call latency is sub-5 ms across the board, confirming the software side of the chain (already covered by the fake-backend test in `test_audio_wiring.py`) is not where any risk would come from; the real-hardware link, measured here for the first time, is not either.\n\n## Notes for the record\n\n- This probe starts its clock at `backend.play()`, not at the sensor frame. It is not the same as the \"man-down latch to dashboard ... camera at 120 fps or more\" bench timing gate of CODING_GUIDE.md Section 6, which measures the whole sensor-to-speaker chain and needs a camera; that gate remains unmeasured and open.\n- The human-timed numbers include the operator's own reaction time (pressing Enter after hearing the sound), so they are an upper bound on true audible latency, not a lower one. The real hardware-plus-perception delay is at most what is shown here, very likely less.\n- `--volume-check` was not run / was run and the operator confirmed [FILL IN: muted check, volume level, whether `cli test-alarm` was also run as the reminder suggests].\n- As with ADR 0066, this result is specific to this machine, this speaker and this room. Re-run `tools/audio_probe.py` and update this ADR if the laptop, speaker, or operating environment changes materially before a trial.\n\n## Still open\n\n- The camera-timed, end-to-end sensor-to-speaker bench gate of the same Section 6 list.\n- The pycaw volume check / `host_volume_min_pct` sign-off item (CODING_GUIDE.md Section 6, separate bullet from the audio probe).\n- [FILL IN: machine/speaker/room identification above.]\n");
replace("docs/adr/0066.md", "## Still open\n\n- The audio probe of the same Section 6 bullet.\n", "## Still open\n\n- ~~The audio probe of the same Section 6 bullet.~~ Closed by ADR 0067.\n");
append("docs/PROGRESS.md", "- ADR 0067 recorded (ADR; closes the audio half of the Section 6 benchmark bullet begun by ADR 0066): tools/audio_probe.py (a standalone script, not part of ppe_host, not wired into cli.py, CI or the justfile) was run on the field laptop against the real WinsoundBackend and real host/sounds WAVs. Call latency (backend.play() return time) was sub-5 ms for every sound. Human-judged audible latency, median of 3 reps per sound: siren 256 ms (one mis-timed first rep at 2696 ms, noted and kept rather than dropped), beep 112 ms, one_beep 128 ms, chime 136 ms, all well under the design 5 300 ms gate. No code, wire, setting or migration change. This measures backend.play()-to-audible on real hardware, a link the existing fake-backend 300 ms test in test_audio_wiring.py cannot reach. Open: the camera-timed end-to-end sensor-to-speaker bench gate, the pycaw volume sign-off item, and the machine/speaker/room identification in the ADR.\n");
}
