# Design review agenda

Purpose: take the Proposed ADRs one by one and confirm, change or reject each. At the time of writing there are 69 ADRs: 3 Decided and 66 Proposed. The design .docx (Rev 3.45) stays frozen; where an ADR changes the design, the change is recorded in the ADR and folded in at the next design revision.

How to use it: tick "Confirmed" when the group agrees. Write what to change in the last column. An ADR that is changed or rejected gets a new ADR or a status edit afterwards; nothing here edits an ADR by itself.

Meeting: [FILL IN: date, place, who attends, who writes the minutes.]

## Before the meeting

These are checks, not decisions; several ADRs below rest on them.

- [ ] S7-6 Ctrl+C exit code: `python -m ppe_host.main --mode SIMULATOR`, Ctrl+C once, then `echo $LASTEXITCODE` (ADR 0060 and 0063).
- [ ] The Pause and speed controls against a real REPLAY host in a browser (ADR 0062, 0065).
- [ ] The alert-card heading button by keyboard: Tab to it, Enter, the matching node card highlights (ADR 0068).
- [ ] Unplug the charger on the field laptop and wait a minute: the host-on-battery notice and a HOST_BATTERY row appear (ADR 0069).
- [ ] The status line of ADR 0049 still reads as if its open item were unresolved; ADR 0050 decided it. Tidy the line.

## Group 1: decisions already taken in preparation (10)

Taken on 2026-11-28 on the project owner's instruction to decide. Confirm or reverse each.

| ADR | Title | Confirmed | Change or note |
|---|---|---|---|
| 0003 | SCBA machine and IMU-degraded mode, values and readings the constants file does not hold | ☐ | values from the Technical Summary kept; sign-off is the hardware bench |
| 0004 | nvs_latch (P16b), values and readings the constants file does not hold | ☐ | same as 0003 |
| 0032 | The dashboard messages and the snapshot (P24-3b-2a) and the split of P24-3b-2 | ☐ | `unpersisted`: interim rule kept, design 1 wording to amend |
| 0033 | Link, system and advisory messages (P24-3b-2b) and what stays open | ☐ | points to the 0032 decision |
| 0036 | The OS watchdog, the crash marker and the host health events (P24b) | ☐ | 60 s intervals accepted; battery decision built in 0069; DISK_LOW stays log-only |
| 0042 | browser tests under e2e/ (P27-3) | ☐ | 500 ms share stays provisional until measured |
| 0043 | lock files, version files and lint (P27b-1) | ☐ | AlertCard keyboard decision, built in 0068 |
| 0052 | dashboard latency test, 500 ms (P27-4) | ☐ | 500 ms provisional, same as 0042 |
| 0068 | AlertCard heading button and the accessibility lint rules | ☐ | built the 0043 decision (heading button); a11y lint rules on |
| 0069 | the laptop battery is read with ctypes (GetSystemPowerStatus), not psutil | ☐ | built the 0036 battery decision (ctypes) |

## Group 2: confirm after a read (12)

These change behaviour the operators will see in the trial. Read the ADR, then confirm.

| ADR | Title | Confirmed | Change or note |
|---|---|---|---|
| 0001 | advisory window_s and the 30 s evaluation cadence | ☐ | 30 s advisory cadence |
| 0008 | security of the REST layer (P19b-1) | ☐ | REST security |
| 0019 | NO LIVE DATA watchdog, Silence 60 s and the browser siren (P22c-1) | ☐ | Silence 60 s and the browser siren |
| 0026 | host sound files, priority and the zero-socket warning (P23a) | ☐ | host sound files and priority |
| 0027 | AudioThread, self-check, zero-socket warning, fallback pulse and test-alarm (P23b) | ☐ | AudioThread; the 300 ms path, measured in ADR 0067 |
| 0028 | Start-up steps 1 to 5, lockfile and failure policy (P24-1) | ☐ | start-up failure policy (steps 1 to 5) |
| 0029 | Start-up steps 6 and 7, session start and the first system rows (P24-2) | ☐ | start-up steps 6 and 7 |
| 0037 | Restart recovery, RECOVERING_EXIT and the session close (P25) | ☐ | restart recovery; about 1 s on a 24 h database |
| 0039 | purge-session (P26-2) | ☐ | purge-session and its limits |
| 0040 | second-drive copy, read-only backups and the integrity check at session end (P26-3) | ☐ | backups and the integrity check |
| 0047 | cli doctor, the pre-shift check (P24-5b) | ☐ | cli doctor |
| 0060 | Ctrl+C and SIGTERM end the host cleanly (S7-4) | ☐ | Ctrl+C exit (needs the S7-6 exit-code check first) |

## Group 3: structural, low risk (44)

Decided while building a part; internal wiring, layout and tooling. One pass, with a skim of any title you doubt.

| ADR | Title | Confirmed | Change or note |
|---|---|---|---|
| 0002 | four firmware values the Technical Summary gives and constants.json does not hold | ☐ |  |
| 0005 | WebSocket message fields that design 3.8 leaves open (P18a) | ☐ |  |
| 0006 | REST shell decisions for P19 (P19-1) | ☐ |  |
| 0007 | REST actions of P19-2 (session start and end, Acknowledge, Resolve) | ☐ |  |
| 0009 | operator CLI commands (P19b-2) | ☐ |  |
| 0010 | sessions list and dashboard outage report (P19c-1) | ☐ |  |
| 0011 | SCBA correction and banner acknowledgement (P19c-2) | ☐ |  |
| 0012 | WebSocket hub (P20) | ☐ |  |
| 0013 | Dashboard scaffold and data socket (P21a) | ☐ |  |
| 0014 | Login page, NO LIVE DATA page and worker hand-off (P21b) | ☐ |  |
| 0015 | alert catalog loader, badge rule and tray order (P22-1) | ☐ |  |
| 0016 | node cards, alert cards, chips and selection (P22-2) | ☐ |  |
| 0017 | Acknowledge, Resolve and ack pending (P22-3) | ☐ |  |
| 0018 | flat component grid, fault map and error boundary (P22b) | ☐ |  |
| 0020 | Test sound, Start monitoring gate, Web Lock owner and screen state (P22c-2) | ☐ |  |
| 0021 | system banners, TEST or REPLAY bar, empty states and NOT READY (P22c-3) | ☐ |  |
| 0022 | Resolve dialog, Sessions list and End shift summary (P22c-4) | ☐ |  |
| 0023 | CO chart and window layout (P22c-5) | ☐ |  |
| 0024 | Top strip and side panel (P22d-1) | ☐ |  |
| 0025 | Event log and CSV (P22d-2) | ☐ |  |
| 0030 | Effect-to-row mapping (P24-3a) and the split of P24-3 | ☐ |  |
| 0031 | The host Port (P24-3b-1) and the split of P24-3b | ☐ |  |
| 0034 | Start-up step 9, loading the open alerts and episodes (P24-3c-2) | ☐ |  |
| 0035 | Start-up step 10, the 1 Hz driver, the thread bridge and the AudioThread in the host (P24-3c-3) | ☐ |  |
| 0038 | CSV export and the export route (P26-1) | ☐ |  |
| 0041 | build manifest, release folder, CI and the import rule (P27-1, P27-2) | ☐ |  |
| 0044 | requirement traceability (P27b-2) | ☐ |  |
| 0045 | requirement ids in the tests and the Spec check (P27b-3) | ☐ |  |
| 0046 | the user-session supervisor (P24-5a) | ☐ |  |
| 0048 | cli ack --node N, the CLI stop test (P24-5c) | ☐ |  |
| 0049 | the ABI check at host start (P24-5d) | ☐ |  |
| 0050 | the firmware tag and ABI in the base heartbeat, host side (P24-5e) | ☐ |  |
| 0051 | the abi_mismatch banner, host side (P24-5f) | ☐ |  |
| 0053 | two ABI rows in cli doctor (P24-5h) | ☐ |  |
| 0054 | table 3.4 gains the AUDIO FAULT and BASE FIRMWARE MISMATCH rows (P24-5i) | ☐ |  |
| 0055 | the host serves the built dashboard (P24-6) | ☐ |  |
| 0057 | SIMULATOR makes seeded traffic (S7-1) | ☐ |  |
| 0058 | serial drain and LIVE_FRAME_IN_TEST_MODE (S7-2) | ☐ |  |
| 0059 | REPLAY feeds a stored session through the normal pipeline (S7-3) | ☐ |  |
| 0061 | Pause and resume of a REPLAY host, host side (S7-5a) | ☐ |  |
| 0062 | The Pause control of a REPLAY dashboard (S7-5b) | ☐ |  |
| 0063 | The host leaves with the exit code main() chose (S7-6) | ☐ |  |
| 0064 | Live speed control of a REPLAY host, host side (S7-7a) | ☐ |  |
| 0065 | The speed selector of a REPLAY dashboard (S7-7b) | ☐ |  |

## Already Decided (3)

No review needed; listed so the count is complete.

| ADR | Title |
|---|---|
| 0056 | PIN login, login sessions and "remember me" (Part 28) |
| 0066 | The 130,000-frame write-commit benchmark (`synchronous=FULL` vs WAL) |
| 0067 | The audio probe (call latency and human-judged audible latency) |

## Not reviewable here

Measured or signed off on hardware, not in a meeting: the camera-timed man-down and base-panel bench gates, the 500 ms dashboard share (ADR 0042 and 0052), firmware values against built hardware (ADR 0003 and 0004), and the second-PC run (docs/second-pc-checklist.md).

## Outcome

Confirmed: [FILL IN: count]. Changed: [FILL IN: ADR numbers]. Rejected: [FILL IN: ADR numbers].

Signed off by: [FILL IN: name, role, date].
