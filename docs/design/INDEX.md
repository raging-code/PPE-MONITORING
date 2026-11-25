# Design section files (INDEX)

These files are a plain-text split of `docs/PPE_Software_Design_Compact_Rev3_45.docx` (Rev 3.45), made so a chat session can be given 5 to 30 KB instead of the whole design. They are **not** the design of record: if a file and the .docx disagree, the .docx wins. Text is verbatim; tables are Markdown pipe tables; bold and italic are dropped.

Naming: `sNN.md` is top-level Section NN. Sections 2, 3, 11 and 14 are split per numbered subsection (`sNN-M.md`; 14.1b is inside `s14-1`). Section 1 has no numbers, so it is split by its bold lead-in into `s01-*.md`.

Where this split needed a choice the Coding Guide did not spell out:

- `s01-config.md` also holds the two firmware paragraphs at the end of Section 1 (core pinning and GPIO2 safety; button stuck-at-boot guard).
- `s11-0.md` is the Section 11 intro and base pin table; `s11-1.md` is 11.1; `s11-2.md` is 11.2.
- `s11-ddl.md` holds the Migration 0002 (Tier 2) DDL. The Migration 0001 DDL is not repeated there: by the Rev 3.28 repository rule, `host/migrations/0001.sql` is the only copy.
- The three JSON blocks of Section 12 are inside `s12.md` and are also extracted verbatim to `shared/constants.json`, `shared/alert_catalog.json` and `shared/hotspots.json`.
- There is no file for the Technical Summary: when a Part says so, paste only the named part of `docs/PPE_Monitoring_System_Compact_Technical_Summary_Rev2_9_11.docx`.

| File | Source heading | Size (bytes) |
|---|---|---|
| `s01-ingest.md` | 1. Host processing: per-frame order; serial layer and frozen Base-to-Host JSON ABI (incl. host_tick); slow clients | 4359 |
| `s01-sequence.md` | 1. Host processing: sequence classifier | 3003 |
| `s01-writer.md` | 1. Host processing: commit-before-broadcast and bounded write durability | 2867 |
| `s01-recovery.md` | 1. Host processing: restart and deterministic recovery sequence; time handling and monotonic epoch rebasing | 6180 |
| `s01-config.md` | 1. Host processing: stall/watchdog timing; lifecycle; host configuration; packaging and supervisor; disk encryption; host health; mode isolation and clock; firmware core pinning and button-stuck guard | 11998 |
| `s01-settings.md` | 1. Host processing: host-only settings table | 5220 |
| `s02-1.md` | 2.1 Engine and rules | 3453 |
| `s02-2.md` | 2.2 Tables | 1549 |
| `s02-3.md` | 2.3 Columns | 18096 |
| `s02-4.md` | 2.4 Relationships | 333 |
| `s02-5.md` | 2.5 Export and integrity | 1741 |
| `s02-6.md` | 2.6 Backup and restore (all Proposed) | 493 |
| `s02-7.md` | 2.7 Size estimate (confirm in the soak test, see 2.9) | 548 |
| `s02-8.md` | 2.8 Retention and privacy | 1508 |
| `s02-9.md` | 2.9 Tests that cover the database | 2131 |
| `s02-10.md` | 2.10 Durability and the commit path | 2296 |
| `s02-11.md` | 2.11 Database changes since Rev 3.26 | 3525 |
| `s03-1.md` | 3.1 Main screen and wireframes (Proposed) | 2188 |
| `s03-2.md` | 3.2 Readings shown | 2551 |
| `s03-3.md` | 3.3 Alert pop-ups | 5043 |
| `s03-4.md` | 3.4 Alert rules and wording (Proposed) | 8269 |
| `s03-5.md` | 3.5 Estimates and advisory (Proposed) | 510 |
| `s03-6.md` | 3.6 Look and accessibility (Proposed) | 1513 |
| `s03-7.md` | 3.7 System states, empty states and fallback (Spec unless marked) | 3906 |
| `s03-8.md` | 3.8 Host and dashboard interface (Proposed) | 11900 |
| `s03-9.md` | 3.9 Alarm reliability (Proposed) | 2099 |
| `s03-10.md` | 3.10 Fault map, time and sessions (Proposed) | 3478 |
| `s03-11.md` | 3.11 Decisions (23 Nov 2026) | 2255 |
| `s03-12.md` | 3.12 Alarm model: host is primary | 5065 |
| `s03-13.md` | 3.13 Dashboard and WebSocket types | 722 |
| `s04.md` | 4. Operators, keys and security | 4237 |
| `s05.md` | 5. Timing and link budgets | 4259 |
| `s06.md` | 6. ML and DL | 10910 |
| `s07.md` | 7. Hazard to software traceability | 6300 |
| `s08.md` | 8. Tests and tooling (Proposed) | 26150 |
| `s09.md` | 9. Open decisions and unwritten parts | 8351 |
| `s10.md` | 10. Consolidated Audit Changelog & Technical Summary Errata Queue (Rev 3.1 – Rev 3.25; Rev 3.26 to 3.45 are logged in 10.2 to 10.19) | 45000 |
| `s11-0.md` | 11. Frozen Base Station Pin Map (intro and pin table) | 1447 |
| `s11-1.md` | 11.1 Radio PHY profile and cross-chip rule | 1474 |
| `s11-ddl.md` | 11. Canonical Migration 0001 (link) and 0002 Starter DDL | 960 |
| `s11-2.md` | 11.2 Firmware design | 4152 |
| `s12.md` | 12. Canonical JSON Contracts: constants.json, alert_catalog.json & hotspots.json (Rev 3.17) | 14598 |
| `s13.md` | 13. Build-Execution & Pre-Trial Sign-Off Checklist (Rev 3.16; updated through Rev 3.31) | 5054 |
| `s14-1.md` | 14.1 Alert Lifecycle & Deterministic Rule State Table (with 14.1b Notice, badge and Tier 2 types) | 13143 |
| `s14-2.md` | 14.2 CO & SHT40 Validity Classes, co_range, Hold Rules & Shadow Estimator | 3846 |
| `s14-3.md` | 14.3 Fixed Tier 1 advise(level, reasons) Lookup Table | 1975 |
| `s14-4.md` | 14.4 Golden Test Vectors | 21252 |
| `s14-5.md` | 14.5 Runtime Architecture, Module Layout & Startup Sequence | 6069 |
| `s14-6.md` | 14.6 Rule engine as a pure core | 904 |
- p6a-extract.md, p6b-extract.md, p6c-extract.md: verbatim extracts of 14.1, 14.2 and GV text for stages P6a to P6c (added by docs06_guide_stages)