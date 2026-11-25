# Progress

One line per finished Part. Each patch script appends its line here. Design of record: `docs/PPE_Software_Design_Compact_Rev3_45.docx` (Rev 3.45, frozen).

- Part 1 done: repo skeleton (14.5 layout), shared/ contracts and vectors, host/migrations/0001.sql, tools/, docs/design section files and INDEX, justfile, pyproject.toml, .gitignore
- Part 2 done: shared/abi.json, tools/gen_abi.py (writes abi.h, abi.py, abi.ts: run just gen), host/tests/test_gen_abi.py
- Part 3 done: constants/settings split (constants.json 78 keys, host/config/settings.json 35 keys), tools/gen_constants.py (constants.h/py/ts, run just gen), host/tests/test_gen_constants.py
- Part 4 done: host/ppe_host/core/crypto_abi.py (verify, classify, decode, signed temp), host/tests/test_codec_vectors.py (28 vectors, length, order and bit-flip tests)
- Part 5a done: host/ppe_host/core/rule_engine.py (skeleton: types, step, 14.1 gate, event_seq, one open alert per node and type), host/ppe_host/clock.py (Clock, FakeClock), host/tests/test_rule_engine_core.py
- Part 5b done: host/tests/test_golden_vectors.py (golden-vector harness, CASES table with 4 placeholder cases, marker line for later Parts)
- Docs: CODING_GUIDE rev G2 applied (Part 6 split into P6a, P6b, P6c; stage rules; per-stage design extracts)
- Part 6a done: CO state in core/rule_engine.py (co_validity, co_reason, co_range with its 60 s clear, co_over_range and clamp, last_co_ge_warn_mono, co_mode and co_hold_ended; no alerts), host/tests/test_co_state.py
- Part 6b done: co_threshold in core/rule_engine.py (WARNING at 35 ppm, DANGER at 200 ppm or co_sat, in-place escalate and lower via ChangeAlertLevel and set_alert_level, 10 s timers, hold rule, SCBA suppression, NodeState.level via refresh_level; co_rising stays disabled), host/tests/test_co_threshold.py, GV-01 in the harness