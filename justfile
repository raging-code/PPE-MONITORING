# One command per task (design 14.5): setup, dev, test, gen, lint, build, package.
# Placeholders are filled in by the Part that owns them (docs/CODING_GUIDE.md, Section 5), using `replace`.
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
    @just --list

# P1, P27b-1: install the Python dependencies from the hashed lock (runtime plus pytest, Hypothesis, httpx2, pyyaml, ruff), then the host package without dependencies. Use Python 3.12 (.python-version)
setup:
    python -m pip install --require-hashes -r requirements-dev.lock
    python -m pip install --no-deps -e .

# P27b-1: regenerate both Python lock files (needs uv). The cut-off is 14 days before today, e.g. on 2026-11-27: just lock 2026-11-13 (no pin newer than the cut-off)
lock cutoff:
    uv pip compile pyproject.toml --python-version 3.12 --generate-hashes --exclude-newer {{cutoff}}T00:00:00Z --custom-compile-command "just lock {{cutoff}}" -o requirements.lock
    uv pip compile pyproject.toml --extra dev --python-version 3.12 --generate-hashes --exclude-newer {{cutoff}}T00:00:00Z --custom-compile-command "just lock {{cutoff}}" -o requirements-dev.lock

# P21 adds the dashboard dev server and P24 adds the host
dev:
    Set-Location dashboard; npm run dev

# P1: the frame and beacon vectors; later Parts add pytest, Vitest and gcc runs under this line
test:
    python -m pytest host/tests -q
    python tools/test_vectors.py

# P14: firmware unit tests built with gcc (needs gcc on PATH; CI runs this too)
test-fw:
    python tools/gen_frame_vectors.py
    python tools/gen_fw_vectors.py
    python tools/run_gcc_tests.py

# P27-3: the browser tests of design 8 (Playwright, Chromium) against dashboard/dist, so run just build first. Once: Set-Location e2e; npm ci; npx playwright install chromium
test-e2e:
    Set-Location e2e; npx playwright test

# P2, P3 and P14 add the generators here
gen:
    python tools/gen_abi.py
    python tools/gen_constants.py
    python tools/gen_frame_vectors.py
    python tools/gen_fw_vectors.py
    python tools/gen_ws_schema.py
    python tools/gen_sounds.py

# P1: design document consistency; P27-2 adds the core/ import rule and the dashboard type check; P27b-1 adds one lint tool per language (ruff rules E9 and F for Python, Biome for the dashboard; neither formats); P27b-2 adds the requirement ids check (requirements/requirements.yaml, design 8.1)
lint:
    python tools/doc_lint.py
    python tools/check_imports.py
    python tools/check_requirements.py
    python -m ruff check host tools
    Set-Location dashboard; npm run typecheck
    Set-Location dashboard; npm run lint

# P27-1: the dashboard bundle (dashboard/dist) and dist/build_manifest.json (design 13; a key whose source does not exist yet is null and named)
build:
    Set-Location dashboard; npm run build
    python tools/build_manifest.py

# P27-1: the release folder dist/release (host package, migrations, shared files, dashboard/dist, build_manifest.json); the embedded Python runtime and the launcher are added by hand (design 1)
package:
    python tools/package_release.py
