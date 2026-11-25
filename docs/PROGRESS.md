# Progress

One line per finished Part. Each patch script appends its line here. Design of record: `docs/PPE_Software_Design_Compact_Rev3_45.docx` (Rev 3.45, frozen).

- Part 1 done: repo skeleton (14.5 layout), shared/ contracts and vectors, host/migrations/0001.sql, tools/, docs/design section files and INDEX, justfile, pyproject.toml, .gitignore
- Part 2 done: shared/abi.json, tools/gen_abi.py (writes abi.h, abi.py, abi.ts: run just gen), host/tests/test_gen_abi.py
- Part 3 done: constants/settings split (constants.json 78 keys, host/config/settings.json 35 keys), tools/gen_constants.py (constants.h/py/ts, run just gen), host/tests/test_gen_constants.py