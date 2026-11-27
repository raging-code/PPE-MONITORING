"""P27-3 (ADR 0042): the Playwright tests of design 8 under e2e/ are wired in: the files exist, the dependencies are pinned and locked, the justfile and CI run them
after a dashboard build, the specs name the two behaviours design 8 asks for and use no fixed sleeps, and the mock host sends messages the host's own Pydantic models accept.
The browser run itself is not done here: it needs Chromium (just test-e2e, and the e2e job of CI)."""
import json, re, shutil, subprocess
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
E2E = ROOT / 'e2e'
SPECS = sorted((E2E / 'tests').glob('*.spec.ts'))

def text(p): return Path(p).read_text(encoding='utf-8')
def wf():
    yaml = pytest.importorskip('yaml', reason='pyyaml is not installed: python -m pip install pyyaml')
    return yaml.safe_load(text(ROOT / '.github' / 'workflows' / 'ci.yml'))

def test_the_e2e_files_exist_and_the_playwright_config_is_strict_about_time():
    for f in ('package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts', 'mock_host.mjs', 'tests/helpers.ts'): assert (E2E / f).is_file(), f
    cfg = text(E2E / 'playwright.config.ts')
    assert re.search(r'retries:\s*0\b', cfg) and re.search(r'workers:\s*1\b', cfg)                  # one shared mock host, and a timing failure is not retried away
    assert 'chromium' in cfg and 'mock_host.mjs' in cfg

def test_dependencies_are_exact_pins_and_the_lock_file_agrees():
    pkg = json.loads(text(E2E / 'package.json')); dev = pkg['devDependencies']
    for name in ('@playwright/test', 'ws', '@types/ws'): assert re.fullmatch(r'\d+\.\d+\.\d+', dev[name]), (name, dev[name])        # design 8, Lock files: no ranges for the test runner
    lock = json.loads(text(E2E / 'package-lock.json'))['packages']
    for name in ('@playwright/test', 'ws', '@types/ws'): assert lock['node_modules/' + name]['version'] == dev[name], name

def test_the_specs_cover_design_8_and_use_no_fixed_sleeps():
    assert len(SPECS) >= 2
    body = '\n'.join(text(s) for s in SPECS)
    assert 'NO LIVE DATA' in body and 'STALE_MS = 4000' in body                                     # NO LIVE DATA at 4 s
    assert 'Start monitoring' in body and 'Siren ON' in body                                        # Start monitoring unlocks audio
    assert 'waitForTimeout' not in body and 'setTimeout' not in body, 'wait for something to appear, never for a fixed time'
    assert 'test.skip' not in body and 'test.fixme' not in body

def test_the_justfile_has_test_e2e():
    j = text(ROOT / 'justfile').replace('\r\n', '\n')
    m = re.search(r'^test-e2e:\n((?:    .*\n?)+)', j, re.M); assert m, 'no test-e2e recipe'
    assert 'playwright test' in m.group(1) and 'e2e' in m.group(1)

def test_ci_has_an_e2e_job_that_builds_the_dashboard_first_and_keeps_the_report_on_failure():
    job = wf()['jobs']['e2e']; steps = job['steps']
    assert job['runs-on'] == 'ubuntu-latest' and job['timeout-minutes'] and steps[0]['uses'].startswith('actions/checkout@v')
    runs = [(s.get('run') or '', s.get('working-directory')) for s in steps]
    flat = '\n'.join(r for r, _ in runs)
    order = [flat.index(x) for x in ('npm ci', 'npm run build', 'playwright install', 'playwright test')]
    assert order == sorted(order)
    assert ('npm run build', 'dashboard') in runs                                                   # the tests run against the built bundle
    assert ('npx playwright test', 'e2e') in runs and 'playwright install --with-deps chromium' in flat
    up = [s for s in steps if s.get('uses', '').startswith('actions/upload-artifact@')]
    assert len(up) == 1 and up[0]['if'] == 'failure()'

def test_every_node_version_in_ci_is_22():
    for job in wf()['jobs'].values():
        for s in job['steps']:
            if s.get('uses', '').startswith('actions/setup-node'): assert str(s['with']['node-version']) == '22'

@pytest.mark.skipif(shutil.which('node') is None, reason='node is not installed')
def test_the_mock_host_sends_messages_the_host_models_accept():
    from ppe_host.api.models import SERVER_ADAPTER
    out = subprocess.run(['node', str(E2E / 'mock_host.mjs'), '--print-messages'], capture_output=True, text=True, timeout=60, cwd=str(ROOT))
    assert out.returncode == 0, out.stderr
    msgs = json.loads(out.stdout); assert [m['type'] for m in msgs] == ['snapshot', 'tick']
    for m in msgs: SERVER_ADAPTER.validate_python(m)
    consts = json.loads(text(ROOT / 'shared' / 'constants.json'))
    assert msgs[0]['constants'] == consts and consts['dashboard_stale_s'] == 4                      # the 4 s of the spec is the one the dashboard really uses
