# Data governance note (required before real responder data, design 13.2 and 2.8)

Status: DRAFT, to be filled in and signed at the pre-trial sign-off. Nothing here changes the code. The facts in sections 1, 3 and 4 were read from the repository (Rev 3.45, ADRs 0039 and 0040, `host/migrations`). Every `[FILL IN]` is a decision for people, not for the software. This note is not legal advice: the data protection contact named below should confirm it against RA 10173 (Data Privacy Act of 2012) and its rules.

## 1. What is stored, and where

| Where | What it holds | Personal data? |
|---|---|---|
| `data/ppe.db` (live database) | per responder node: CO, temperature, humidity, motion, battery, radio signal, each frame's raw hex, the alert level and alerts, episodes and who acknowledged or resolved them; the audit log; the roster (node number and alias); dashboard users | Yes: readings linked to an alias, and so to a person by whoever holds the map (section 2). Health-related readings are likely "sensitive personal information" under the Act: confirm with the contact. Heart rate is 0 in Tier 1. |
| `data/ppe_test.db` | SIMULATOR rehearsals, and REPLAY runs. A REPLAY run feeds a real stored session through the normal pipeline and writes its own copies of the frames and alerts here | Yes, after a REPLAY of a real session. Treat it like `ppe.db` |
| `backups/` and `second_drive_dir` | online copies of the database, made at each End shift, read-only files | Yes, a full copy |
| each USB backup drive | the same backup copies | Yes |
| `exports/` | CSV exports of one session or of the whole database (`export_all_*.csv`) | Yes |
| the operator's own Downloads folder | CSV files saved by the dashboard's Download CSV button | Yes. Outside the host's reach |
| the browser on the operator laptop | the dashboard login token (tab storage, or browser storage if "Remember me" is ticked) | No responder data; a stolen token is access to the dashboard |
| `logs/` | host log lines and the crash marker | Not checked line by line for aliases or readings: [FILL IN: someone reads one real log before the trial] |

The dashboard, the audit log, the logs and the exports show aliases only (for example FF-01 for the node, FFR-01 for the firefighter). Dashboard users are stored by display name, a token hash and, if set, a salted PIN hash. Since S8-1 (ADR 0070) the database also holds firefighter profiles (`firefighters`): the full name, age, height, weight, resting and maximum heart rate, smoker, years of service and the consent record (date, form version, witness), and `firefighter_assignments` (which firefighter wore which node, from when to when). The full name is shown only by `cli list-firefighters --show-names` and the Settings screen. All of it is personal data, is in every backup and in a whole-database export, and is not encrypted by the software: rule 4 is what protects it. Complete the [FILL IN] fields of sections 2 and 3 before the first real firefighter is added.

## 2. Who does what (names and dates are filled in at sign-off)

| Role | Held by |
|---|---|
| Holder of the alias-to-person map (kept outside the system, on paper or in a separate encrypted file, never in the database, a session label or an audit reason) | [FILL IN: name, role] |
| May run `purge-session` | [FILL IN: names] |
| May create, disable or reset dashboard users (`create-operator`, `set-pin`, `rotate-token`, `disable-operator`) | [FILL IN: names] |
| May export CSV and hold the exports | [FILL IN: names] |
| Data protection contact for RA 10173 (questions, access and deletion requests, incidents) | [FILL IN: name, email, phone] |
| Adviser who sets the retention period | [FILL IN: name] |

## 3. Rules

1. **Consent.** No responder is wired to a node before they have been told what is recorded (the readings in section 1), who can see it and for how long it is kept, and have agreed. The record of that consent is kept at [FILL IN: where, held by whom]. A person who withdraws is removed from the roster for later shifts, and their sessions are handled under section 5.
2. **Aliases only.** The link between a person and a node is the firefighter profile and its assignment history (ADR 0070; the name is shown only on the Settings screen and by `list-firefighters --show-names`) together with the alias map (section 2). Nobody types a responder's name into a session label, a Resolve reason, a log note or an export file name.
3. **Access.** Only the named dashboard users sign in, each under their own name. A user who leaves, or a lost token or PIN, is handled the same day with `disable-operator`, `rotate-token` or `set-pin`. The laptop is locked when unattended.
4. **Encryption.** The laptop drive is BitLocker or Device Encryption (or an encrypted VeraCrypt volume). Every USB backup drive and the second drive are BitLocker To Go (or VeraCrypt). Backups and CSV exports go only to encrypted locations. `cli doctor` does not check encryption: it is checked by a person before every trial day and recorded: [FILL IN: where].
5. **Export.** CSV leaves the host only through the dashboard or `GET /api/export.csv`, which writes a `CSV_EXPORT` audit row. The person who downloads it moves it to the encrypted `exports/` area or deletes it. Files in a Downloads folder are removed by [FILL IN: who, when].
6. **Retention.** The software has no automatic expiry. The retention period is [FILL IN: value from the adviser, for example "N days after the end of the trial"], and the person named for `purge-session` applies it by running section 5 for every session older than that. Date of each check: [FILL IN].
7. **Test data.** A REPLAY of a real session copies it into `ppe_test.db`. The copy has its own session id there: remove it with `purge-session --session-id <that id> --db data/ppe_test.db`, or delete `data/ppe_test.db` when nothing else in it is needed.
8. **Incident.** A lost or stolen laptop or drive, a token seen by the wrong person, or an export sent to the wrong place is reported to the contact in section 2 at once, who decides what to do and whether anyone else must be told.

## 4. Known limits of the software

- Deleting a session removes it from the live database, from every `*.db` in `backup_dir`, `second_drive_dir` and each USB folder named with `--usb-dir`, and the matching `exports/session_<id>_*.csv`. It does not remove a whole-database export (`export_all_*.csv`, which also holds other sessions: it is only named in a warning), a file in a Downloads folder, a copy anyone made by hand, or a drive that is not plugged in (the command stops with exit code 2 after the live purge and is run again with the drive).
- A purge is final: there is no confirmation prompt and no undo.
- A refused purge is also recorded as a `SESSION_PURGED` audit row whose reason starts with `refused`: read the reason before counting rows.
- Tokens and PIN hashes are in the database; the CMAC key is in `secrets.json`, which is not in the repository and is not encrypted by the software. The encryption in rule 4 is what protects it.

## 5. Deleting a session (offline, by a person named in section 2)

1. End the shift in the dashboard and stop the host (Ctrl+C). The command refuses while the host is running, while any session is monitoring, and while the session is still open.
2. Plug in every USB backup drive and the second drive.
3. `python -m ppe_host.cli purge-session --session-id <id>` and, for each USB drive, `--usb-dir <folder>` (add `--db`, `--home`, `--export-dir` or `--backup-dir` only if the folders are not the defaults).
4. Exit code 0 is done. Exit code 1 means nothing was deleted (read the message). Exit code 2 means a refusal that was recorded (an alert or episode of that session is still open: resolve it first) or a drive that was not found.
5. Delete by hand what the command names in its warnings (whole-database exports, Downloads), then write the session id, date and your name in the record at [FILL IN: where].

## 6. Sign-off

| | Name | Date | Signature |
|---|---|---|---|
| Data protection contact | | | |
| Adviser (retention period) | | | |
| Project lead | | | |
