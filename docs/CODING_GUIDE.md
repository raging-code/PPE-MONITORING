# PPE Monitoring System: Coding Guide for AI (Software Design Rev 3.45)

**What this file is.** A build order for an AI (Claude chat, free plan) that writes the code one small part per session. It is a guideline, not the design. The design of record is `PPE_Software_Design_Compact_Rev3_45.docx`, frozen at Rev 3.45. When this guide and the design disagree, the design wins, and the AI must say so instead of guessing.

**How to use it (3 steps per session).**
1. Open a new chat. Paste Section 1 (Ground rules) and Section 2 (Patch format) once, then the one Part block you are on (Section 5), then the last HANDOFF note.
2. Upload only the files that Part lists under "Upload". Never upload the whole design Word file (about 317 KB of text). Part 1 splits it into small section files so later parts can upload just the sections they need.
3. Run what the AI gives you, run the "Done when" check, and copy the HANDOFF note it prints. If the check fails, do not move on; paste the failure back in the same chat.

Part 1 is delivered as a **zip** (unzip at the repo root). Every later part is a **patch script** (`patches/partNN_name.mjs`, run with `node`) that creates or edits files.

---

## 1. Ground rules (paste at the top of every session)

```
You are writing code for the PPE Monitoring System. Follow these rules.

SCOPE
- Do only the Part I name. Do not start the next part, refactor earlier parts, or add features.
- Keep the whole answer small: one patch script of at most about 350 lines, plus at most 10 lines of
  explanation, plus the HANDOFF note. If the Part will not fit, stop at a natural boundary and say
  "PART Na done, Nb remains". Do not print the same code twice.

THE DESIGN IS FROZEN (Rev 3.45)
- Do not change: the 23-byte frame, the 13-byte beacon, host/migrations/0001.sql, constants.json,
  any threshold or any setting key. If you think one is wrong, STOP and tell me what test or
  evidence shows it. Do not fix it silently. Design changes go in docs/adr/NNNN.md.
- Never invent a number. Thresholds and times come from shared/constants.json (generated
  constants.py / constants.h / constants.ts) or host/config/settings.json. Never hard-code them.
- Rules the design marks Proposed or OPEN stay as the design states them. co_rising stays disabled.

BYTE-LEVEL FACTS (easy to get wrong)
- Frame 23 bytes, little-endian. CRC-8 poly 0x07 init 0 over bytes 0-17 (byte 18).
  MAC = first 4 bytes of AES-128-CMAC(key, sys_id || bytes 0-17) (bytes 19-22).
- Beacon 13 bytes. CRC-8 over bytes 0-7 (byte 8). MAC = first 4 bytes of CMAC(key, bytes 0-7)
  (bytes 9-12). abi_ver is byte 3, value 3 is accepted, others are IGNORE_ABI.
- temp_x100 (bytes 4-5) is a SIGNED 16-bit value (int16_t in C). F-24 (-500) tests this.
- node_id = id_mode & 0x07; node_id 0 is REJECT_ROSTER.
- shared/vectors/frames.json (24 frames, 4 beacons) and tools/test_vectors.py are the cross-check.

STACK
- Host: Python 3.12, FastAPI + Uvicorn, Pydantic v2, pyserial, SQLite (WAL), winsound for audio,
  pytest + Hypothesis. Dashboard: React + Vite + Tailwind (shadcn/ui), Vitest.
  Node firmware and base: ESP-IDF 5.x + RadioLib on a classic ESP32. Patch scripts: Node ESM (.mjs).
- Host listens on 127.0.0.1:8420 only. Time zone Asia/Manila (UTC+8). Data root is PPE_HOME.

ARCHITECTURE RULES
- host/ppe_host/core/ imports nothing from io/, services/ or api/, and does no file, serial,
  network, audio or clock access. The rule engine is step(state, event, now) -> (state, effects).
- Module file names and folders are the ones in design 14.5. Do not rename or add folders.
- The host alarm is never gated by Start monitoring. Acknowledge never closes a safety alert.
- Every behaviour you write needs a test in the same Part. Name tests with the REQ or GV id when
  the design gives one.

WHEN IN DOUBT
- Ask me one short question and stop. Do not guess a design decision.
- A failing golden vector (GV-01 to GV-27) is NOT proof the design is broken: those vectors are
  hand-derived. Show me the failing case, say whether the vector or the rule looks wrong and why,
  and propose an ADR. Do not edit the vector or the rule to make it pass without telling me.
```

---

## 2. Patch format (paste once per session, after Section 1)

Every part after Part 1 is **one file**: `patches/partNN_name.mjs`. Run it from the repo root:

```
node patches/part05_engine_skeleton.mjs --dry    # shows what it would do, writes nothing
node patches/part05_engine_skeleton.mjs          # applies it
```

Behaviour of the header: it works out every change in memory first. If any step fails (a file that
already exists, an edit anchor that is not found exactly once, a missing file) it writes **nothing**
and exits with an error. `--force` allows overwriting an existing file. A patch is meant to run once;
running it twice fails safely.

**The AI must copy this header exactly, then write only the `run()` body:**

```
// patches/partNN_name.mjs  (run from repo root: node patches/partNN_name.mjs [--dry] [--force])
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
  put('host/ppe_host/core/example.py', String.raw`...file text...`);
  replace('justfile', 'test:\n', 'test:\n    pytest host/tests\n');   // old text must occur exactly once
  append('docs/PROGRESS.md', '- Part NN done: <one line>');
}
```

Rules for the `run()` body:
- New file: `put(path, String.raw\`...\`)`. If the file text contains a backtick or `${`, use `putB64(path, '<base64>')` instead.
- Edit an existing file: `replace(path, oldStr, newStr)` with an `oldStr` copied from that file, long enough to occur **once**. If you have not been shown the file, ask me to paste it. Do not guess its text.
- Every patch ends with an `append('docs/PROGRESS.md', ...)` line so the repo remembers where you are.
- Never use `--force` unless I say so.

---

## 3. Session prompt (paste after Sections 1 and 2)

```
Do PART <N> of CODING_GUIDE.md only. Here is the Part block, the HANDOFF note from the last part,
and the files it lists. Write patches/part<NN>_<name>.mjs. When done, print:
1) the exact commands to run, 2) the "Done when" check, 3) a HANDOFF note (format below).
```

**HANDOFF note (the AI prints this at the end; at most 12 lines; you paste it into the next session).**

```
HANDOFF after PART <N>
- Created: <paths>
- Edited: <paths>
- Public names the next part needs: <function/class names with file>
- Decisions or ADRs needed: <none | list>
- Tests added and how to run them: <command>
- Known gaps / TODO left on purpose: <list>
```

---

## 4. Order and sizing

Order keeps everything that runs on the laptop first, then firmware, then API, dashboard and operations. The design numbers the slices S1 to S6 (13.1). **[FW]** parts are firmware C; **[BENCH]** needs the real boards and is not for chat.

The cut line from the design still holds: S1, S1b and S2 to S5 are the Tier 1 trial minimum. **S6 (export, backup, purge) is required before any real responder data is stored.** S7 (replay, 3D jacket, Tier 2) is optional and has no parts here.

Size target per part: one patch script, about 350 lines or fewer including tests, three or four files at most. If a Part grows past that while you work, split it (Na / Nb) instead of enlarging the answer. Where Na / Nb would collide with an existing part (P7b, P12b, P19b), name the halves P7-1 / P7-2. Likely splits: P7 (man-down, MAYDAY, `node_danger` | battery, link and signal loss, `unauth_alert`), P7c (episodes | `checkin`, `heat`, shadow estimator), P10 (GV-01 to GV-20 | GV-21 to GV-27), P22c (watchdog, siren, Start monitoring gate | banners, Resolve dialog, sessions, layout). **Proposed golden-vector map (check each id against 14.4 before the part; where it differs from the P6 and P7 upload lists, this map wins):** P6 GV-01, GV-07, GV-09, GV-15, GV-18, GV-19; P7 GV-02 and GV-03 (alerts; the episode half is P7c), GV-04, GV-06, GV-08, GV-10, GV-12 (link half), GV-17; P7b GV-21, GV-22, GV-23, GV-26, GV-27; P7c GV-05, GV-16 (needs the `heat` rule, so it cannot pass before P7c), GV-20, GV-24, GV-25; P8 GV-11, GV-12 (classifier half), GV-13, GV-14.

---

## 5. Parts

"Upload" lists what to give the chat. `docs/design/sNN.md` are the section files made by Part 1. "Done when" is the check you run yourself.

### Phase A: foundation (slice S1)

| Part | Delivers | Upload | Done when |
|---|---|---|---|
| **P1** (zip) | Repo skeleton from the 14.5 layout, `justfile`, `pyproject.toml` (dependencies include `tzdata`, because Windows has no time-zone database and Asia/Manila needs it), `.gitignore`, `shared/` files, `host/migrations/0001.sql`, `tools/`, `docs/design/` section files, `docs/PROGRESS.md`, `patches/` | The design .docx, `frames.json`, `test_vectors.py`, `doc_lint.py` | `python tools/test_vectors.py` prints 24 frames and 4 beacons, all match; `sqlite3 :memory: < host/migrations/0001.sql` runs; `python tools/doc_lint.py` passes |
| **P2** | `shared/abi.json` and `tools/gen_abi.py` writing `components/abi/abi.h`, `host/ppe_host/abi.py`, `dashboard/src/gen/abi.ts`; generator test | `docs/design/s12.md`, the Technical Summary frame table and status bits (Section 4, "Status bits and node faults"; paste only that part, never the whole summary), `frames.json` | `just gen` then `git diff --exit-code` is empty; test checks offsets against `test_vectors.py` |
| **P3** | `tools/gen_constants.py`, the constants/settings split of 12.1 (`shared/constants.json` + `host/config/settings.json`), generated `constants.h/py/ts`, generator tests | `docs/design/s12.md`, `docs/design/s01-settings.md` | Test: every key of the move list exists; Profile A literals 15, 60, 5.5 reproduced exactly; regenerate gives empty diff; the deleted keys (`token_grace_h`, `shift_duration_h`, `retry_buffer_max`, `token_expiry_warn_min`, `sound_check_interval_min`, `sound_check_amber_min`, `no_audio_alarm_s`, `zero_socket_alarm_s`) are in neither file; the firmware keys of 12.1 are in `constants.json` (`scba_confirm_s`, `scba_confirm_high_co_s`, `scba_response_s`, `resend_wait_ms`, `node_min_send_gap_ms`, `evt_slot_ms`, `evt_jit_ms`, `beacon_period_s`, `lbt_backoff_min_ms`, `lbt_backoff_max_ms`, `unresolved_pulse_s`, `unresolved_label_s`); the generated key counts equal the two files; derived times are computed from `routine_period_s` per profile |
| **P4** | `host/ppe_host/core/crypto_abi.py` (verify, classify, decode, signed temp) and `host/tests/test_codec_vectors.py` | `docs/design/s14-4.md`, `frames.json`, generated `abi.py` | `pytest host/tests/test_codec_vectors.py` passes all 28 vectors including F-24; frames of 0 and of 17 to 20 bytes are BAD_LEN, a beacon of the wrong length is rejected, and a frame whose id_mode node bits are 0 is REJECT_ROSTER |

P1 notes for the AI: split the .docx with `extract-text`, one markdown file per top-level section (and per 14.x), so later parts upload 5 to 30 KB instead of 317 KB. **File names (every part below uses exactly these):** `sNN.md` is top-level Section NN as one file (s04, s05, s07, s08, s12, s13). Sections 2, 3, 11 and 14 are split per numbered subsection as `sNN-M.md` (s02-1, s02-5, s02-10, s03-8, s11-2, s14-4, and so on; 14.1b stays inside s14-1). Section 1 has no numbers, so split it by its bold lead-in: `s01-ingest.md` (per-frame order, serial layer, frozen JSON ABI including host_tick), `s01-sequence.md` (sequence classifier), `s01-writer.md` (commit-before-broadcast, write durability), `s01-recovery.md` (restart and recovery, time handling), `s01-config.md` (lifecycle, host configuration, packaging, host health, mode isolation, stall and watchdog timing), `s01-settings.md` (host-only settings table). Also write `docs/design/INDEX.md` (file, source heading, size). If a later part names a file that is not in the index, say so; do not guess. Extract the three JSON blocks of Section 12 and the DDL of Section 11 **verbatim**. Do not tidy them. If you can not make a zip, fall back to a patch script with `putB64`.

### Phase B: rule engine (slice S3, pure Python, no hardware)

The grouping below is proposed. Before writing a Part, list the GV ids that the design sections cover; if a group is bigger than the size target, split it.

| Part | Delivers | Upload | Done when |
|---|---|---|---|
| **P5** | `core/rule_engine.py` skeleton: state, event and effect types, `step(state, event, now)`, `event_seq`, "one open alert per node and type"; golden-vector test harness (table of cases to pytest); `clock.py` with `Clock(wall_ms, mono_ms)` and a `FakeClock` for the injected clock of 14.1 (P12b adds the real clock to this file) | `s14-1.md`, `s14-6.md`, constants | Harness runs with 0 cases failing and at least 2 placeholder GV cases; no I/O imports in `core/` (import-rule test passes) |
| **P6** | CO rules: `co_threshold`, `co_range` (signed temp), hold rule, SHT40 CO rule, `sensor_fault`; `co_rising` present but disabled; above 500 ppm sets `co_over_range = 1`, display clamps to 500.0, raw `co_x10` stored; node object carries `co_validity` (VALID, DERATED, UNRELIABLE) and `co_reason` (14.2) | `s14-2.md`, GV-15, GV-16, GV-18, GV-19 | Those GV cases pass; F-15, F-23, F-24 behave as the design says; boundary tests (Summary D5, test values only, never in code): CO 494.9, 495, 500 and 520 ppm (495 or more is saturation DANGER, above 500 sets `co_over_range` and clamps the display); CO held at 34 to 36 and at 198 to 202 ppm for 10 min gives at most one level rise and no clear; `sensor_fault` DANGER condition (i) uses `last_co_ge_warn_mono`, and condition (ii) reads `last_heat_alert_mono`, which P7c sets (until then it is never true) |
| **P7** | Man-down, MAYDAY, `node_danger`, battery, link-loss and `unauth_alert` rules | `s14-1.md`, `s14-3.md`, matching GV | Their GV cases pass; battery latch test (at or below 10% latches WARNING until power cycle or charge, even if voltage rises) |
| **P7b** | Notice and badge types of 14.1b, all level NONE: `wrist_open`/`wrist_close`, `node_reboot`, `button_stuck`, `missed_event`, `co_warmup`, `latch_restored`, `watchdog_recovery`; `weak_signal` and `estimate` present but disabled | `s14-1.md` (14.1b), constants | Each type has a test for its trigger bit, its timer from constants, and its end condition; none changes a node level or opens an episode; persistent notices (`wrist_open`, `button_stuck`, `missed_event`, `co_warmup`) give exactly 1 open row after 30 consecutive frames with the condition true, still exactly 1 after a host restart and an End shift in the middle of it, and a new rising edge after the clear opens a new row; one-shot notices (`latch_restored`, `watchdog_recovery`, `node_reboot`) are inserted with `cleared_ts` equal to `raised_ts`, add no row while the condition is held, and are not returned by the open-alert query after a restart (`suspect_frame` is P8) |
| **P7c** | Episode lifecycle (MAN_DOWN and MAYDAY: OPEN, ACKNOWLEDGED, RESOLVED, `EPISODE_ESCALATED`, resolve reasons), `checkin`, `scba_expired` (host side), `heat`, and the 14.2 shadow estimator and `shadow_notice`; the MAN_DOWN label rule (chest movement above STILL_G for 5 s changes the label to "movement detected", 15 s of renewed stillness reverts it to "no response", each change emits an incremental episode WebSocket message; card, siren and level never reduce; MAYDAY has no such label) | `s14-1.md`, `s14-2.md`, `s03-4.md`, GV text | Matching GV cases pass; one active episode per node; Acknowledge never closes a safety alert; a node reboot while man-down adds the card note; a first-seen `mandown=1` opens an episode; a MAN_DOWN to MAYDAY upgrade keeps one episode; a latch cleared on the jacket keeps the episode open until an operator Resolves it (no auto-resolve); the 5 s and 15 s label test above; heat boundaries (Summary D5, test values only): 60 C for 119 s no alert and 121 s WARNING, a 20 C rise in 25 s WARNING and in 35 s none, it clears after 10 s once the 30 s rise is under 15 C and the temperature under 55 C, 100 C for 9 s none and 11 s WARNING, heat never raises DANGER, and a temperature fault freezes heat evaluation and holds an open heat alert; after Resolve and a jacket latch clear, a new `mandown=1` rising edge opens a new episode |
| **P8** | `core/seq_classifier.py` (wrap, reboot, duplicate, step) and raise-only handling of suspect frames; the one-shot `suspect_frame` notice of 14.1b (level NONE, `cleared_ts` equal to `raised_ts`, raised once per event) | `s01-sequence.md`, GV-11 to GV-14 | GV-11 to GV-14 pass; a suspect frame never clears or lowers an alert; a verified suspect frame gives exactly 1 `suspect_frame` row and 30 more frames with the same condition add none |
| **P9** | `core/advisory.py` (14.3 table, rows on change plus 300 s heartbeat; evaluated every 30 s per active node and on any level transition, first match from the top wins and every non-NORMAL level gets a row; `quality` is high with no fault and at least 80% of the window, medium with no fault and 50 to 80%, low with any fault or under 50%; the design gives no value for `window_s`, so ask me before writing one) and **rebuild mode** (flag returns state and no effects) | `s14-3.md`, `s14-6.md` | Hypothesis property tests of 14.6 pass: no suspect clear, one open alert per node and type, `event_seq` strictly increasing, replay is deterministic, rebuild returns no effects |
| **P10** | Remaining golden vectors: GV-01 to GV-20 byte-level through `crypto_abi`, GV-21 to GV-27 field-level | `s14-4.md`, all GV text | All 27 vectors run. **Any failure is reported, not silently fixed** (see Section 1, last rule). Output ends with a pass/fail table and ADR proposals |

### Phase C: storage and ingest (slice S2, host side)

| Part | Delivers | Upload | Done when |
|---|---|---|---|
| **P11** | `io/db_writer.py` (single SQLite writer thread, bounded ordered queue, constraint error not retried forever), migration runner, the minimal `settings.py` loader (PPE_HOME, `settings.local.json` override, `config/secrets.json`; P24 extends it), `io/backup.py` core (`online_backup`, `verify_backup`; P26 adds scheduling, the second drive and purge), `cli.py` with a command registry and `seed-roster --db` and `backup-verify --file` (later parts add commands to it with `replace`), `event_seq` init (1 + max of all six columns), schema-dump-equals-`0001.sql` test | `s02-1.md`, `s02-10.md`, `s01-writer.md`, `0001.sql` | Tests: schema equals file; roster trigger rejects a frame with an unknown node; `foreign_key_check` empty; seeds 25/18/29; migration test (fresh and upgraded give the same schema, one backup restored); open-session index test (second open session rejected, close plus insert in one transaction accepted); open-alert index test (second open `co_threshold` per node rejected); `event_seq` stays unique after a forced queue overflow; write-failure policy (Rev 3.36): a constraint-failed row is skipped and counted in `write_rejected`, and an alert that cannot be saved stays live with `unpersisted=1` and keeps the host alarm on; CHECK and index tests (Section 8, Rev 3.20 and 3.38): `node_level` 'BANANA', `base_verify` 'XYZ' and `verify` 'OK' with `node_id` NULL are rejected, the boolean columns reject 2, `idx_alerts_session_cleared` exists, two open `unauth_alert` rows are NOT blocked by the DDL, an UPDATE that sets an episode RESOLVED without `resolved_ts` or sets a session `ended_ts` without `end_kind` (or the reverse) is rejected; the `alert_types` seed equals the types in `alert_catalog.json`; commit-before-broadcast writer behaviour (`commit_wait_ms` 120, queue maximum 500, transient fault retried in place at the head of the queue with an alert flagged `unpersisted=1`, full queue drops the oldest routine units first and counts `retry_buffer_dropped`); after a simulated disk stall the buffered units drain in strict `event_seq` order with zero FOREIGN KEY failures; `seed-roster` fills nodes 1 to 3 and `backup-verify` accepts a good backup and rejects a damaged file. connection factory PRAGMAs (WAL, `synchronous=FULL`, `foreign_keys=ON` on every connection, tested; `FULL` stays unless the 2.10 benchmark in Section 6 says otherwise) and a refusal to start when the database version is newer than the code. operator actions (Acknowledge, Resolve, End shift, SCBA correction) commit with `synchronous=FULL` even if the benchmark later moves the default to WAL with `NORMAL` (set the pragma on the writer connection before BEGIN, then set it back); `constants_hash` and `settings_hash` over canonical sorted-key UTF-8 JSON, where `settings_hash` ignores `serial_port`, `serial_baud`, `db_path`, `test_db_path`, `backup_dir`, `log_dir`, `bind_host` and `bind_port` (a test changes `serial_port` and the hash stays the same). If P11 is over the size target split it P11-1 (writer, runner, schema tests) and P11-2 (settings loader, backup core, cli) |
| **P12** | `io/serial_reader.py` line parser (readline of at most 513 bytes), ingest pipeline (parse, verify, classify, queue to writer) driven by a fake port that replays `frames.json`; parser fuzz test; the CMAC key (32-char hex) is read from `config/secrets.json` and `sys_id` from settings, never from the repo; tests seed roster nodes 1 to 3 with the P11 `seed-roster` code | `s01-ingest.md`, `s05.md`, generated `abi.py` | Fuzz test passes; feeding all vectors gives the stored `verify` results the design lists; bad length, CRC, MAC and roster rows are counted in `rejected_frames`; host and base MAC results compared (`MAC_DISAGREE` logged); a humidity byte outside 0 to 100 (SHT40 failure) is stored raw and the frame is neither rejected nor marked suspect; at most 20 bad frames per minute kept; more than 512 bytes of boot garbage increments `serial_framing_errors` without blocking the reader; the port opens with `dtr=False, rts=False` (a test checks the open call); a verified frame with flags level 3 or a set reserved bit in status4 is stored, marked `seq_class` suspect and logged; `backend_ms` stored per frame; host-share timing test (serial line to broadcast within the 200 ms budget of design 5, median and maximum, fake port; budget value in the test only, not in code) |
| **P12b** | the real clock in `clock.py` (file made in P5), `io/serial_writer.py` (1 Hz `host_tick` writer thread with write timeout, never on the event loop), `base_health` rows, `COUNTERS`, `SERIAL_LOST/BACK`, `BASE_OFFLINE/BACK` events | the `s01` files on host_tick and health (names from P1's `docs/design/`), `s05.md`, `0001.sql` | Tests: `host_tick` carries `recovering` and is written off-loop with a fake port; a blocked port times out and logs `SERIAL_LOST`; counters match `rejected_frames`; base offline detected within 5 s of the last valid beacon or frame (fake clock) |

### Phase D: node firmware (slice S1b; [FW] parts are pure C, built with gcc on a PC)

| Part | Delivers | Upload | Done when |
|---|---|---|---|
| **P13** [FW] | `shared/vectors/fw_scenarios.json` (first task of S1b, same JSON style as `frames.json`) | `s11-2.md`, Technical Summary Section 9 rows D1, D2, D4 only (paste only those rows), `frames.json` | File parses; every D-FW row of 8 has at least one scenario; ids are unique; there is a scenario for each case the rows name: CANCEL with a motionless chest during a check-in (pending 10 s, rejected, prompt re-issued, stillness and check-in timers still running); a fall-started check-in not auto-cleared by 3 s of motion; three presses in 2 s give MAYDAY, also retroactively after Press 1 cleared an SCBA or degraded prompt; MAYDAY while man-down is latched upgrades the stored cause and sets status4 bit 4; an SCBA prompt deferred by a check-in or degraded prompt while the SCBA clock keeps running; `scba_expired` set with no prompt during a latched man-down or MAYDAY |
| **P14** [FW] | `components/frame` (pack, CRC-8, AES-CMAC, decode with `int16_t`, no ESP-IDF includes) and a gcc test runner over `frames.json` | `s14-4.md`, `s11-2.md`, `frames.json`, generated `abi.h` | `gcc` build in CI gives the listed result and decoded fields for F-01 to F-24 and B-01 to B-04, and the packer rebuilds F-01 to F-15 byte for byte from their decoded fields with the test key; frames of 0 and of 17 to 20 bytes and a beacon of the wrong length are rejected |
| **P15** [FW] | `components/rules_fw`: man-down and MAYDAY state machines as `step(state, event, now_ms)` | `s11-2.md`, `fw_scenarios.json`, constants | D-FW state-machine scenarios for these two machines pass |
| **P16** [FW] | SCBA machine (300, 120, 20 s timers from constants), `components/nvs_latch` with a mocked NVS, reset test | same as P15 | 1000 `step()` calls with an unchanged latch record 0 NVS writes; each latch set and clear records exactly 1; a simulated watchdog timeout and a simulated brown-out each give `boot_ctr+1`, `seq 0`, reboot hint status2 bit 3, status3 bit 4 = 1 for 60 s with the cause in status3 bits 5 to 6, and a latch restored from the mocked NVS with status4 bit 1 = 1; a corrupt stored latch comes back latched; erased flash comes back unlatched; a power cut before the write commits comes back unlatched and the latch is set again after the stillness timer; an injected NVS write failure or slow write still starts the alarm within one 10 Hz loop and logs `nvs_fault` (a firmware log, not a host event); a latch stored as MAYDAY comes back as MAYDAY; `boot_ctr` rises over 20 simulated power cycles and survives a failed NVS read |
| **P17** [BENCH] | `components/radio`, sensors, ui, task table, RadioLib settings, and the **base station firmware** (S2: pin map 11.1, serial line format that P12 parses) | Not for chat | Done at the bench; record final values in design 11.2 |

### Phase E: API and dashboard (slice S4)

| Part | Delivers | Upload | Done when |
|---|---|---|---|
| **P18** | `api/models.py` (Pydantic v2 discriminated union on `type`), export of `shared/ws.schema.json`, generated TypeScript types | `s03-8.md`, `s03-13.md` | Schema export test; TS types regenerate with empty diff; also export `shared/openapi.json` (P27 hashes it); message contract test (unknown `v` rejected); models cover client `auth` and `hb`, server `tick` and `snapshot` (with `epoch`, `srv_seq`, `recovering`, `monitoring_active`), and the REST error envelope `{error_code, detail, retry_after_s}`; the models also cover the server messages `reading`, `alert`, `episode`, `link`, `system`, `advisory` and `tick` (and `ml` for Tier 2, defined but unused) with the main fields of 3.8; every message has `v`, `type`, `srv_seq` and `srv_ts`; the snapshot carries `roster`, nodes with `co_validity`, `co_reason` and `scba_correction`, open episodes with `man_down_motion_state`, `co_history_30m`, `banners` and the whole `constants.json`; no WebSocket message carries a key or token |
| **P19** | `api/api_rest.py`: login, session start/end, Acknowledge, Resolve, `GET /api/events`; status-code tests | `s03-8.md`, `s04.md`, `s03-4.md` | Endpoint status-code test passes (incl. `STATE_CONFLICT`, idempotent session start); REST reads run off the event loop; `EXPLAIN QUERY PLAN` of the `GET /api/events` query shows no scan of `frames`; Acknowledge of an already auto-cleared alert returns 200; End shift conflict test (second call 409 `STATE_CONFLICT`, wrong `confirm_text` 400); error-code test: every 4xx/5xx body uses the envelope and a code from the design 3.8 list (BAD_REQUEST, UNAUTHENTICATED, ORIGIN_REJECTED, NOT_FOUND, RECOVERING with `retry_after_s`, STATE_CONFLICT, VALIDATION_ERROR, INTERNAL_ERROR), `retry_after_s` null otherwise; episode resolve returns `latch_still_set`; `GET /api/events` never splits rows that share one `event_seq`, returns `last_seq`, holds no frame rows, no `raw_hex` and no measurement columns, and writes no audit row; `GET /api/sessions` rows carry `alert_count`, `unresolved_episodes` and `highest_level_by_node`; `POST /api/session/start` sets `operator_id` only while it is NULL |
| **P19b** | Security and operators (Section 4): `server_salt` and `secrets.json`, hashed tokens with `hmac.compare_digest`, failed-login delay, Origin/Host checks, token on REST and WebSocket, disabled operator rejected and open socket closed; CLI `create-operator --name`, `rotate-token --operator-id`, `disable-operator --operator-id` (design 2.8 and 4 call the first one `create-operator`) (audit `OPERATOR_ADDED`, `TOKEN_ROTATED`, `OPERATOR_DISABLED`), `cli ack --node N` | `s04.md`, `s03-8.md`, `0001.sql` | Section 8 tests: old token 401 after rotate; disabled operator rejected on login, REST and WS; missing or invalid token rejected on dashboard, WS and CSV; tokens never expire (after a simulated 12 h open sockets, REST calls and a new login with the same token still work and no expiry banner appears); `server_salt` is created once by whichever of the host or `create-operator` runs first; `create-operator` shows the token once and stores only its HMAC |
| **P19c** | Remaining REST endpoints of the frozen list (3.8): `GET /api/sessions`, `POST /api/dashboard-outage` (422 rules), `POST /api/scba-correction`, `POST /api/system-banners/{kind}/ack` (incl. `host_gap`), alert/episode ack and resolve if not already in P19 | `s03-8.md`, `s03-10.md` | The table-driven status-code test (design 8, Rev 3.31) covers every endpoint in the frozen list, with no endpoint missing and no extra endpoint in the code (`GET /api/export.csv` is listed in the table but its route is added by P26, so mark it pending until then); REST read test (`GET /api/sessions` on a 24 h database moves no liveness stamp by more than 500 ms); banner ack allowlist is `host_gap` and `logging_fault` only (other known kinds 400, unknown 404); `scba-correction` is re-applied from `audit_events` after a restart and neither clears `scba_expired` nor suppresses ambient CO alerts, and the latest correction of each node, from any session, applies until a later frame changes that node's SCBA bit (id_mode bit 3) or scba_expired bit (status3 bit 3) |
| **P20** | `api/ws_hub.py`: `/ws` snapshot, heartbeat, per-client sender, 1 Hz tick; second tick-only socket `/ws/tick` for the Web Worker (3.8, Spec); auth frame within `ws_auth_timeout_s` or close with code 4401 | `s03-8.md`, `s05.md` | Test client receives snapshot then heartbeat; a slow client does not block others; `/ws` rejects frames sent before the auth message; `/ws/tick` sends only `tick` messages at 1 Hz and closes with 4401 when no auth arrives in time; close codes 4403 (Origin/Host rejected), 4408 (slow client, send timeout over 1 s) and 1000 (clean shutdown) each have a test; the `/ws` client `hb` message is accepted; a frozen client causes no tick gap over 1 s and no restart; the hub broadcasts `reading` (each verified frame, with the raw status bytes), `alert` (each raise, clear, in-place level change and Acknowledge; an episode Acknowledge sends one message per linked alert, also for one that already cleared; coalesced `unauth_alert` repeats at most once per second), `episode`, `link`, `system` (banner state and `BANNER_ACK`) and `advisory` messages; one epoch UUID per host start; each connection's `srv_seq` starts at 0 on its snapshot and coalescing never leaves a gap |
| **P21** | Dashboard scaffold: Vite + React + Tailwind + shadcn/ui, WebSocket store, NO LIVE DATA state, constants from generated `constants.ts` | `s03-6.md`, `s03-7.md` | `npm run build` and Vitest pass; page shows NO LIVE DATA with the server off; a gap in `srv_seq` triggers a snapshot and a reconnect shows the snapshot first; close code 4401 clears `sessionStorage` and shows Login, 4408 reconnects and reloads the snapshot; the main thread passes `{type:'INIT_AUTH', token, ws_tick_url}` to the Web Worker with `postMessage` on login and on reload |
| **P22** | Node cards, alert tray, Acknowledge and Resolve buttons, wording from `alert_catalog.json` | `s03-1.md` to `s03-4.md`, `alert_catalog.json` | Vitest component tests; every alert type renders its catalog text; alert tray test (3 responders in alert plus 1 advisory, no overlapping boxes); Acknowledge persists across reload, second tab and host restart; message-to-pop-up latency within the constant; repeat alert joins its card with a count; minimize chip; a new alert never switches the selected jacket; Resolve needs node, episode ID and a reason; estimate and advisory cards use a dashed border and grey label, never a level colour; card colour comes from the level only; at most 2 badges per node, ordered by (level_rank DESC, `badge_order` ASC, `alert_id` ASC), so a `co_threshold` DANGER plus two WARNING alerts shows `co_threshold` first; a threshold alert that clears before anyone acknowledges it stays on screen as "cleared" until acknowledged; a safety card can be minimized but never closed, an estimate or advisory card can be dismissed; catalog test: `alert_catalog.json`, the `alert_types` seed and table 3.4 list the same types, every row has a class, a sound and a Shows-as value, `badge_order` values are unique and run 1 to 32, and the 7 banners (including `audio_fault`) each have a 3.4 row |
| **P22b** | Flat component grid (the shipped jacket view, 3.1 and 3.13) with the fault map from `hotspots.json` (3.10 bit table), error-boundary fallback so readings and Resolve never depend on it | `s03-1.md`, `s03-10.md`, `hotspots.json` | Vitest: each hotspot reacts only to its listed bits; grid failure leaves cards and pop-ups working |
| **P22c** | Dashboard states and flows: Web Worker NO LIVE DATA watchdog with its own socket and siren (Web Lock, 4 s), Test sound and Start monitoring gate with wake lock, system banners (BASE OFFLINE, LOGGING FAULT, AUDIO FAULT, HOST ON BATTERY, `host_gap`/db_restored), TEST/REPLAY banner, empty states and NOT READY, Resolve dialog (reason required), Sessions list and End shift summary, CO chart, 1366x768 and 150% zoom layout | `s03-5.md` to `s03-10.md` (names from P1), `alert_catalog.json` | Vitest and Playwright rows of design 8: NO LIVE DATA at 4 s with tab hidden; banners map to catalog text; Resolve refused without reason; Inter font bundled offline, 44 px buttons, Acknowledge and Resolve work from the keyboard, reduced-motion gives a steady border, hidden-tab return banner, token survives a tab reload; Silence 60 s silences NO LIVE DATA and it re-arms after 60 s; an Acknowledge during a socket drop silences at once, shows `ack pending` and syncs on reconnect with no new sound; NO LIVE DATA also shows at 4 s with only the data socket blocked; after a reconnect the page reports the outage with `POST /api/dashboard-outage`; a "Screen may sleep" badge shows when the wake lock is lost; with every banner active the danger cards and the 8 reading rows stay visible at 1366x768 and 150% zoom, the tray is at most 40% of the height and the wake lock is re-acquired after the tab is hidden and shown again; a greyscale screenshot still separates the levels by icon and word, contrast is at least 4.5:1, nothing is under 14 px, flashing is under 3 per second; banners (`host_gap`, `logging_fault`, BASE OFFLINE) create no `alerts` rows and a `host_gap` acknowledge persists across reload; the CO chart loads its history from the snapshot and draws lines at 35 and 200 ppm; the read-only Model status panel is Tier 2 and has no part |
| **P22d** | Dashboard shell of 3.1 and 3.2 that no other part builds: top strip (responder switcher with alias, level colour, battery and last seen; session mode LIVE or TEST; Start monitoring and End shift buttons with the END confirmation that lists every open alert, open episode and latched node; minimized chips), the side panel with at most 8 rows (CO; temperature and humidity; chest motion and stillness; battery; SCBA; link and last seen; HR and COHb status; Details collapsed with posture, RSSI and SNR) and one CO chart slot, the event log with its CSV button (an authenticated `fetch` of `/api/export.csv` turned into a blob download, not a plain link) | `s03-1.md`, `s03-2.md`, `s03-7.md`, `s03-8.md`, `s03-10.md`, `s03-11.md` | Vitest: "HR not fitted" and COHb "unavailable" show in Tier 1; the 30 s stillness timer is labelled "backend estimate"; "last seen" is relative under 60 s and clock time after that, all times Asia/Manila 24-hour; the event log fills from `GET /api/events` after a reload or reconnect and then follows live messages; rejected frames show as one count with the "check key" message and the diagnostics view is off by default; the End shift dialog needs the typed text END and never blocks while an alert is active; hotspot and 3D parts are not built here; the advisory shows as one line (risk and action) in the side panel and as a slim card, with its quality as a word and three dots, greyed when low; temperature is labelled "ambient" and heat is never shown as the wearer's condition; an unreliable CO shows "low confidence: CO sensor out of range" |

### Phase F: alarm, recovery, operations (slices S5 and S6)

| Part | Delivers | Upload | Done when |
|---|---|---|---|
| **P23** | `io/audio_watchdog.py`, AudioThread, WAV manifest and priority order (use the full Rev 3.17 priority list of 3.3, which also ranks NO LIVE DATA and BASE OFFLINE; do not shorten it to MAYDAY > man-down > DANGER > WARNING), audio self-check, and `tools/gen_sounds.py` (writes `siren.wav`, `beep.wav`, `one_beep.wav`, `chime.wav`, `host_chime.wav` at the relative volumes of 3.4: chime about a quarter of beep, beep quieter than siren) | `s03-3.md`, `s03-12.md`, `s03-9.md`, `s14-5.md` | Tests with a fake audio backend; Acknowledge stops that card's sound only; CLI host test alarm for the shift speaker check (3.12); alarm before Start monitoring test (verified man-down frame sounds the host alarm with no operator click); hidden or closed browser for 10 min still sounds the host alarm (mocked sink); broadcast to host alarm start within 300 ms with a mocked audio sink (design 5, median and maximum); every WAV named in `alert_catalog.json` exists and `gen_sounds.py` regenerates them with the volume order above; two-note chime every `host_chime_interval_min` while no safety alert is unacknowledged; a failed or restored self-check (`audio_check_interval_s`) writes `AUDIO_FAULT` / `AUDIO_OK`; the WAVs are committed in `host/sounds/` with a SHA-256 manifest checked at start-up, and a missing or altered file raises `AUDIO_FAULT`; the "every sound name has a WAV" test skips `none` and `siren_60s_silence` (the browser siren has no WAV); with every tab hidden or closed the beeps repeat every 10 s within 1 s; a second DANGER during an acknowledged one restarts the sound; `python -m ppe_host.cli ack --node N` stops that card's sound with no browser open, writes `ACK_ALERT`, and a removed operator's token is refused; while no alarm sounds the 60 s self-check plays a 100 ms silent WAV synchronously and a `RuntimeError` counts as `AUDIO_FAULT`; the 1 kHz 400 ms pulse every 2 s plays when a WAV is missing or cannot be decoded; the design contradicts itself on a laptop warning after 10 s with zero connected `/ws` sockets (the Section 1 packaging text and the "Browser freeze and headless alarm" row of design 8 keep it, but `zero_socket_alarm_s` was deleted in Rev 3.30 and 9.1 asks whether a stop rule is wanted): neither build nor skip it, ask me and record the answer in an ADR |
| **P24** | `main.py`, `settings.py` (extends the P11 loader: PPE_HOME, `settings.local.json` override, `serial_port: auto`), lockfile (holds the PID and the process start time; stale if the PID is gone or the start time differs; SIMULATOR and REPLAY would use the same file), startup sequence steps 1 to 10 (the `HOST_START` row records `host_boot_id` and `mono_base_ms`), `cli.py doctor` (prints pass or fail for the release version, base serial device, audio device, free disk against `host_disk_min_gb`, port 8420, `dashboard/dist/index.html`, `secrets.json`, `PRAGMA quick_check` and the lockfile, and changes nothing), `scripts/run_supervisor.py` (crash-loop guard: after 5 non-zero exits within 60 s it waits 5 s between respawns, shows a local error window with the last crash marker, plays the local alarm and keeps trying; exit code 0 never respawns; respawn within 500 ms on a non-zero exit, tested with a fake child); at host start `fw_version` and the ABI version are recorded and checked against `abi.json` (11.2 note 4; if the design does not say what a mismatch does, ask me) | `s14-5.md`, `s01-config.md` | Start-up failure policy tests (stale lockfile, quick_check fail, failed migration restores the pre-migration backup of step 4 and exits with code 2; missing or unreadable `secrets.json`, or missing `server_salt` while operators exist, exits with code 2; exit 2 counts toward the crash-loop guard; a live lockfile makes the new process exit 0); start-up failure test: a failed `quick_check` renames the database with its `-wal` and `-shm` to `<name>.corrupt-<UTC ts>` and never resumes it, restores the newest backup that passes `backup-verify` (or creates a fresh database if none passes) and writes `INTEGRITY_FAIL` and `DB_RESTORED` (session_id NULL) with the `host_gap` banner reason `db_restored`; changed `settings_hash` logs `CONFIG_CHANGED`; feature-flag test (`co_rising_enabled`, `weak_signal_enabled` false: no such alert is ever raised) |
| **P24b** | `OSWatchdogThread` (250 ms liveness stamps, a crash marker file is written, then `os._exit(1)`, at >3 s stall), `LIVENESS_RESTART`, `TICK_STALL`, host health checks (`HOST_BATTERY`, `DISK_LOW`, `LOGGING_FAULT`), `QUEUE_OVERFLOW` and `CLIENT_DROPPED` events | `s14-5.md`, `s01-config.md`, `s03-10.md` | Tests with a fake clock: stall >3 s exits; each health event is written once per condition; thresholds read from `settings.json` |
| **P25** | `services/recovery.py` (chunked rebuild, `RECOVERING_ENTER/EXIT`, `HOST_GAP`), sessions (`close_session(kind)` for ENDED, CLEAN_SHUTDOWN and ABANDONED, each one atomic `BEGIN IMMEDIATE` transaction: the `END_SHIFT` audit row or the `CLEAN_SHUTDOWN` or `SESSION_ABANDONED` system row first, then `ended_ts` and `end_kind`, then any new session; resume under 30 min; stored monotonic times rebased with the `host_boot_id` and `mono_base_ms` of `HOST_START`, so a reboot inside the 30 min window never corrupts timers; a full `integrity_check` off-loop after `RECOVERING_EXIT`) | `s01-recovery.md`, `s14-5.md`, `s14-6.md` | Recovery test: rebuild over the last 30 min gives the same state as live; no effects during rebuild; End shift opens a new session at once, carries open alerts and episodes, and a backup follows (Section 1, item 3); startup order test (first snapshot has `recovering=true` and the open alerts, `POST /api/session/end` 409, `host_tick` recovering=1); pre-replay queue test (`pre_replay_queue_max` 5, 20 live frames: only NORMAL frames with no event bits drop, a `mandown=1` frame survives); recovery across sessions (End shift then restart within 30 min); timing check: replay of a 24 h database finishes within 3 s with open alerts shown at once (design 5, Proposed: measure and report, as the soak test of 2.9); no node shows SIGNAL LOST or LINK LOST from the restart gap alone; `HOST_GAP` starts at the last committed row, not the restart time; the rebuild window is anchored at the last committed frame (after a 25-minute outage every node that sent a frame in the 30 minutes before it is restored); a node silent for more than 30 minutes that returns with `mandown=1` opens a new episode; a node resolved while still latched opens no new episode on its first live frame; a changed `constants_hash` or `settings_hash` closes the session ABANDONED, opens a new one and logs `CONFIG_CHANGED` with open alerts and episodes unchanged; a missing, truncated or hash-mismatched checkpoint row is ignored; a live frame during recovery is queued, not evaluated, and processed first after `RECOVERING_EXIT`; commit-first test: no alert is broadcast before its SQLite commit unless the writer queue is faulted; each of the three `close_session` kinds writes its rows in the order above; after the gap each node shows grey "unconfirmed (host gap)" until its first fresh frame, which restarts the 15 s and 60 s timers; after a restart the banners show only conditions that are still faulted, not cleared historical ones |
| **P26** | `services/csv_export.py`, `io/backup.py` (online backup, 250 pages per step, off-loop at each session end; backup files read-only; copy to a second drive at End shift; full `integrity_check` at session end), the `GET /api/export.csv` route (token and Origin checked, `CSV_EXPORT` audit row), purge-session CLI with audit rows (offline only: refused while the host PID lockfile is live or a session is monitoring, and exits with code 2 with an audit row while any alert or episode opened in the purged session still has `cleared_ts` NULL or is unresolved, or when a foreign-key violation (for example a row of a later session) rolls the transaction back, which runs with `foreign_keys=ON`; `PRAGMA secure_delete=ON`, then `wal_checkpoint(TRUNCATE)` and `VACUUM` after the commit; also deletes `exports/session_<id>_*.csv`; the audit row has `session_id` NULL and the purged id as reason; child rows deleted in foreign-key order; covers the live database and its backups) | `s02-5.md`, `s02-6.md`, `s02-8.md` | Export of `v_full_log`; backup passes integrity check; purge writes `SESSION_PURGED` audit row. Needs disk encryption and `docs/data-governance.md` before real data; CSV safety test (fields starting `=`, `+`, `-` or `@` get a leading apostrophe); export holds all 6 `v_full_log` record types; frame rows carry decoded telemetry and `raw_hex`, and the export excludes `base_health`, keys, tokens and audit rows whose `session_id` is NULL; rows are in strict `event_seq` order, so an alert raised at `event_seq` 10 and cleared at 45 appears after the events between; tab and CR also get the leading apostrophe, `raw_hex` is written as an Excel-safe text literal and numeric columns such as a negative RSSI stay plain numbers; the export streams in 500-row chunks on a read-only connection in a worker thread; purge of a closed session exits with code 2 while its episode is open and succeeds after Resolve with `PRAGMA foreign_key_check` empty |
| **P27** | `.github/workflows` CI (generate and fail on non-empty `git diff`, pytest, Vitest, gcc tests, import rule, `doc_lint`), `tools/build_manifest.py` writing `build_manifest.json` (13), `e2e/` Playwright tests from design 8, `justfile` targets `lint`, `build`, `package` | `s14-5.md`, `s08.md`, `s13.md` (names from P1) | CI config parses; manifest has every key of 13 with real hashes (`stl_sha256` is null until the optional `jacket_model.stl` exists; tell me if you want another value); Playwright run: NO LIVE DATA at 4 s, Start monitoring unlocks audio |
| **P27b** | `requirements/requirements.yaml` (one `REQ-<area>-<nnn>` per statement a test covers, with status; hazards H1 to H22 map to REQ ids, design 8.1), a CI check that fails when a test names an ID missing from the file or a Spec item has no test, `requirements.lock` and `package-lock.json` (design 8, Lock files), one lint tool per language | `s08.md` (8.1), `s07.md` (names from P1) | CI check fails on a test with an unknown REQ id; both lock files exist and P27's manifest hashes them; `requirements.lock` pins `tzdata` (Rev 3.40) |

Not given a Part on purpose: design Section 6 (Tier 2 models, training, motion classifier) and the Model status panel (Tier 2 only, 3.11), `core/checkpoint.py` (dormant in Tier 1, 2.10, create only as an empty stub in P1), `services/simulator.py`, `services/replay.py` and `0002.sql` (S7, optional), SIMULATOR and REPLAY mode isolation with their own `test_db_path` and `LIVE_FRAME_IN_TEST_MODE` (S7), `TIER2_TIMEOUT` (Tier 2), the release folder and `doctor` test on a second PC (Section 6).

---

## 6. Not for chat (do these yourself, record the results in the design or an ADR)

- Weak-signal RSSI/SNR floors, ESP-IDF stack sizes and priorities, cross-chip radio settings (SX1262 node, SX1276 base; gate before any other D9 run: 100 valid frames each way at the lowest and highest TX power with matching CRC, MAC and beacon decode, 11.1), bit positions confirmed against built firmware.
- The 130,000-frame benchmark (decides `synchronous=FULL` or WAL: keep FULL if commit p99 with antivirus running is 50 ms or less, otherwise WAL with `synchronous=NORMAL`; chunked recovery of 3 s or less; soak at `commit_wait_ms` 120) and the audio probe, both on the laptop.
- Sign-off: provisional thresholds, `co_rising` values (the rule stays disabled without them), the decision that the host alarm is not gated by Start monitoring, pycaw volume check with `host_volume_min_pct` (3.12; if rejected, only the chime and shift-start check detect mute), `advisory_heartbeat_s`, confirmation that `zero_socket_alarm_s` needs no stop rule, humidity byte when the SHT40 fails (firmware owner).
- Before the trial or any real responder data: sign-offs, benchmarks, P26, `docs/data-governance.md`, disk encryption (BitLocker or VeraCrypt), the release folder and `doctor` tested on a second PC.

- Node and base firmware details of 11.2 (P17): per-system AES key and node_id written once to NVS by a USB provisioning script (never in the repo), optional flash and NVS encryption, task watchdog on `fsm_task` and `radio_task`, brownout reset, task table priorities and stack sizes, `components/serial_bridge` and `components/base_panel`, base panel text LAPTOP OFFLINE after 5 s without a host tick, and the pinned ESP-IDF commit in `build_manifest.json`.
- Bench timing gates of design 5, none of which a chat can prove: man-down latch to dashboard (100 events in the room, camera at 120 fps or more), base panel alarm within 2 s with the host killed, panel and dashboard showing the same link-loss state at 15 s and 60 s, routine silence per node-hour (D9), host task stall back within 5 s, and D8 with the tab hidden.

## 7. If something goes wrong

- **Patch fails with ANCHOR or MISSING:** nothing was written. Paste the error and the current text of that file back into the same chat; do not start a new session.
- **A test from an earlier part now fails:** stop. Paste the failure; the AI fixes only the part that broke it.
- **The chat gets cut off:** start a new chat, paste Sections 1 and 2, the Part block, the last HANDOFF note, and say "continue PART N from where the patch stopped; here is `git diff`".
- **A golden vector fails:** treat as evidence, not as a design break. Decide per case whether the vector or the rule is wrong, then write `docs/adr/NNNN.md`.
