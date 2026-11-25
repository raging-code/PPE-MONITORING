# PPE Monitoring System

Design of record: `docs/PPE_Software_Design_Compact_Rev3_45.docx` (frozen at Rev 3.45). Build order: `docs/CODING_GUIDE.md`.
Small plain-text pieces of the design for uploading to a chat: `docs/design/` (see `docs/design/INDEX.md`).

Checks that work after Part 1 (run from this folder, Python 3.12 or newer, `pip install cryptography`):

    python tools/test_vectors.py     # 24 frames and 4 beacons, all match
    python tools/doc_lint.py         # design document consistency
    python -c "import sqlite3; sqlite3.connect(':memory:').executescript(open('host/migrations/0001.sql').read())"

Secrets (the CMAC key, `server_salt`) never go in this repository: see `.gitignore`.
