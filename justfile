# One command per task (design 14.5): setup, dev, test, gen, lint, build, package.
# Placeholders are filled in by the Part that owns them (docs/CODING_GUIDE.md, Section 5), using `replace`.
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

default:
    @just --list

# P1: install the Python dependencies (the dev extra adds pytest and Hypothesis)
setup:
    python -m pip install -e ".[dev]"

# P21 adds the dashboard dev server and P24 adds the host
dev:
    @echo "dev: nothing to run yet"

# P1: the frame and beacon vectors; later Parts add pytest, Vitest and gcc runs under this line
test:
    python -m pytest host/tests -q
    python tools/test_vectors.py

# P14: firmware unit tests built with gcc (needs gcc on PATH; CI runs this too)
test-fw:
    python tools/gen_frame_vectors.py
    python tools/gen_fw_vectors.py
    python tools/run_gcc_tests.py

# P2, P3 and P14 add the generators here
gen:
    python tools/gen_abi.py
    python tools/gen_constants.py
    python tools/gen_frame_vectors.py
    python tools/gen_fw_vectors.py

# P1: design document consistency; P27 adds one lint tool per language
lint:
    python tools/doc_lint.py

# P27 adds the dashboard and manifest build
build:
    @echo "build: nothing to build yet"

# P27 adds the release folder
package:
    @echo "package: nothing to package yet"
