# Second-PC release checklist (design: `s01-config.md` "Release bundle and doctor", `s10.md` Rev 3.43/3.44)

Status: DRAFT, to be run and filled in before the trial, per CODING_GUIDE.md Section 6: "the release folder and `doctor` tested on a second PC" and `s10.md`: "Run the release on a second PC before the trial." This note is a checklist, not a design decision: it names the real commands and the real `cli doctor` checks so the run can be followed step by step and its result recorded. Nothing here changes the code; `tools/package_release.py` and `host/ppe_host/services/doctor.py` are unmodified.

Run this on a PC that is **not** the one the release was built on, to prove the folder is really self-contained — if it only runs correctly on the build machine, something was missed.

## 1. Before you start

- [ ] The first PC (the one with the repo, Node and Python set up for development) has `dashboard/dist/index.html` built: `just build` (or `npm run build` inside `dashboard/`, then `python tools/build_manifest.py`).
- [ ] A USB drive or network copy to carry the release folder to the second PC.
- [ ] The second PC's details, for the record: [FILL IN: make/model, Windows version, is this the actual field laptop or a stand-in].
- [ ] A copy of the pinned embedded Python 3.12 runtime (design: "the pinned embedded Python runtime and the launcher are added by hand"; `package_release.py` does not fetch it). Where it is kept: [FILL IN].
- [ ] A copy of the launcher `.bat` that starts `scripts/run_supervisor.py` from the release folder (also added by hand). Where it is kept: [FILL IN].
- [ ] A real or test CMAC key for `config/secrets.json` on the second PC. **Do not reuse the development machine's `secrets.json` if this is heading toward real responder data** — provision it fresh (see step 4).

## 2. Build and package (on the first PC)

```powershell
just build      # npm run build in dashboard/, then tools/build_manifest.py
just package     # tools/package_release.py: writes dist/release/
```

`package_release.py` refuses to run if `dashboard/dist/index.html` is missing, and always removes an older `dist/release` first. It copies only what the host needs at run time:

- `host/ppe_host`, `host/migrations`, `host/config` (settings.json, not secrets.json), `shared/`, `scripts/`
- `dashboard/dist` (the prebuilt dashboard)
- `requirements.lock` and `pyproject.toml`, if present
- `build_manifest.json`, written fresh

It does **not** copy tests, `node_modules`, data, backups, logs, exports, `secrets.json`, `settings.local.json`, or any `.db` file. If `dist/release` contains anything else, that is a packaging bug worth reporting, not something to work around by hand.

- [ ] `just package` output ends with `package: dist/release (N files, <rev_tag>); the embedded Python runtime and the launcher are added by hand`. Record N and `rev_tag`: [FILL IN].

## 3. Move the folder to the second PC

- [ ] Copy the whole `dist/release` folder to the second PC (USB drive or network share — never regenerate it there from source, since the point is to test the copied artifact).
- [ ] Add the embedded Python runtime and the launcher `.bat` into the copied folder by hand, as the design's packaging note says (step 1's checklist items).
- [ ] Do **not** copy `data/`, `logs/`, `backups/`, or any `*.db` file from the first PC. The second PC should start from nothing, the same as a real deployment.

## 4. Provision the second PC

The design's own words for this: "Moving to another laptop means copying the data folder, provisioning the CMAC key into secrets.json and running doctor; the resume rules of section 1 apply unchanged." For a first-time release test there is no data folder to carry over yet, so:

- [ ] Create `config/secrets.json` inside the release folder on the second PC with a `cmac_key` (32 hex chars encoding the 16-byte shared key). Where this key comes from (matching the actual node firmware, or a disposable test value) is a decision for the person doing the test, not for this checklist: [FILL IN: real key / test key, and who generated it].
- [ ] If `config/settings.local.json` is needed (a different `serial_port`, a different `bind_port`, etc. on this machine), create it now. It is never copied by `package_release.py`, on purpose, since it is machine-specific.
- [ ] Identify the correct serial port for the base on this PC (Windows Device Manager, or `python -c "from serial.tools import list_ports; print([p.device for p in list_ports.comports()])"` using the embedded Python) and set `serial_port` in `settings.local.json`. `serial_port: "auto"` is a `doctor` FAIL (not built yet, per ADR-tracked notes in `doctor.py`): it must be a real COM port name.

## 5. Run `cli doctor`

From inside the release folder, with the embedded Python:

```powershell
python -m ppe_host.cli doctor
```

`doctor` changes nothing: the database is opened read-only, the serial port is only looked up in the system's list (never opened — no DTR/RTS pulse reaches the node), the network port is only connected to (never bound), and the only sound played is a 100 ms silent probe WAV. It is safe to run as many times as needed. It prints one line per check, in this order, and exits 0 if nothing failed (a `WARN` does not fail the exit code), 1 otherwise:

| # | Check | PASS means | Typical FAIL / WARN / SKIP reason |
|---|---|---|---|
| 1 | release version | `build_manifest.json` exists, is readable, and its `constants_hash` matches this folder's `shared/constants.json` | missing manifest (packaging was skipped), or this folder's constants don't match what it was built from |
| 2 | host ABI | `host/ppe_host/abi.py` matches `shared/abi.json` in this folder | a mismatch means the host would refuse to start at all (exit 2) — this is the same check the host makes at every startup, run early so it's caught before the shift |
| 3 | settings | `config/settings.json` (and `settings.local.json`, if present) load without error | a malformed JSON file, or an unknown key in `settings.local.json` |
| 4 | base serial device | the configured `serial_port` is in the system's current port list | wrong COM port, device not plugged in, or `serial_port` still set to `auto` (not supported yet) |
| 5 | sound files | every WAV named in `alert_catalog.json` exists under `host/sounds/` and matches `manifest.json`'s SHA-256 | a missing or altered WAV (never ignore this — it's the same check `AUDIO_FAULT` uses live) |
| 6 | audio device | the 100 ms silent probe WAV plays | Windows only; `SKIP` elsewhere. A `FAIL` here on the real field laptop is serious — it's the primary alarm path |
| 7 | free disk | free space on the database's drive is at or above `host_disk_min_gb` | low disk space on this machine |
| 8 | port `8420` | the bind port is free, or (if the host is already running) is held by it | something else is already using the port, or a stale lockfile claims the host runs but nothing listens |
| 9 | prebuilt dashboard | `dashboard/dist/index.html` exists in this folder | packaging didn't include the built dashboard — re-run `just build` then `just package` |
| 10 | secrets.json | `config/secrets.json` exists and `cmac_key` is valid; `server_salt` is required only once an operator exists | missing or malformed secrets file — this is the step 4 provisioning above |
| 11 | database quick_check | `PRAGMA quick_check` passes on the live database (or there is no database yet, which also passes) | a corrupted database file |
| 12 | operator PINs | every active operator has a PIN set | `WARN`, not `FAIL` — operators without a PIN still sign in with the token. `SKIP` if there's no database yet or no operator yet |
| 13 | base ABI | the newest session's last `ABI_MISMATCH`/`ABI_OK` row, if any, is not a mismatch | `SKIP` with no database or no session yet (nothing has been recorded); a real `FAIL` means the base firmware reported a different ABI version in the last session |
| 14 | lockfile | no lockfile, or a live one with a real PID, or a stale one that will be replaced | — |

- [ ] Run `doctor` with **nothing else running** (no host, no dashboard open). Expect mostly `SKIP` for the database-dependent checks (11-13), since there is no database yet. Record the full output: [FILL IN: paste or attach].
- [ ] Fix every `FAIL` before moving on. A `WARN` (only possible on check 12) does not block the release but should be noted.

## 6. First start and a real shift's worth of checks

- [ ] Start the host for the first time on the second PC: `python -m ppe_host.main --mode SIMULATOR` (a SIMULATOR run exercises the full pipeline without a real base attached) or, with the real base connected, the normal start command. Confirm it reaches a running state (the dashboard loads at `http://127.0.0.1:8420`, or the configured `bind_port`).
- [ ] Stop it cleanly (Ctrl+C) and run `doctor` again. Checks 11-14 should now report real values instead of `SKIP`: a database exists, a session was recorded, and the lockfile check shows "none (the host is not running)".
- [ ] If this second PC is meant to carry real responder data later, also walk `docs/data-governance.md` (encryption, consent, the named roles) before any real data touches it — a second-PC release test with made-up data does not need that yet, but the real deployment does.
- [ ] Run `python -m ppe_host.cli test-alarm` (the shift speaker check, design 3.12) to confirm the siren, beep and host_chime are all audible on this machine's actual speaker. `tools/audio_probe.py` (ADR 0067) can be run here too if a fresh audio-latency reading on this specific machine is wanted.

## 7. What this checklist does **not** cover

- The camera-timed bench gates of CODING_GUIDE.md Section 6 (man-down latch to dashboard at 120 fps, base panel alarm within 2 s with the host killed) — those need a camera rig and are a separate exercise, not part of a doctor/release test.
- RF tuning and firmware provisioning (per-system AES key and node_id written to NVS) — those are firmware-owner tasks, not something `doctor` or this checklist touches.
- Whether `synchronous=FULL` and the audio latency are acceptable on *this* second PC specifically — ADR 0066 and ADR 0067 recorded results from the actual field laptop; if this second PC is a different machine kept only for release testing, its numbers were not re-measured here. Re-run `tools/bench_writer.py` and `tools/audio_probe.py` on it if it will also carry real shifts.

## 8. Sign-off

| | Name | Date | Result |
|---|---|---|---|
| Release built and packaged (step 2) | | | |
| `doctor` run clean on the second PC (step 5) | | | |
| First start and shutdown cycle completed (step 6) | | | |
| `test-alarm` confirmed audible on this machine | | | |
