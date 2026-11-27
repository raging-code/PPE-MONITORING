"""P27b-1 (ADR 0043): the Python lock files, the version files, and the lint set up for both languages.
Reads files only; the ruff test runs ruff when it is installed (it is a dev dependency) and is skipped when it is not."""
import json, re, subprocess, sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
PIN = re.compile(r'^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\;]+)', re.M)
def norm(n): return re.sub(r'[-_.]+', '-', n).lower()
def pins(name):
    t = (ROOT / name).read_text(encoding='utf-8'); return {norm(m.group(1)): m.group(2) for m in PIN.finditer(t)}
def blocks(name):
    """One block per pinned requirement: the pin line and its continuation lines."""
    t = (ROOT / name).read_text(encoding='utf-8'); out = {}
    for m in re.finditer(r'^([A-Za-z0-9][A-Za-z0-9._-]*)==.*(?:\n(?:    .*))*', t, re.M): out[norm(m.group(1))] = m.group(0)
    return out
def toml():
    import tomllib; return tomllib.loads((ROOT / 'pyproject.toml').read_text(encoding='utf-8'))
def req_name(spec): return norm(re.match(r'[A-Za-z0-9][A-Za-z0-9._-]*', spec).group(0))

def test_every_pin_in_both_lock_files_has_sha256_hashes():
    for name in ('requirements.lock', 'requirements-dev.lock'):
        b = blocks(name); assert len(b) >= 15, name
        for pkg, text in b.items(): assert re.search(r'--hash=sha256:[0-9a-f]{64}', text), (name, pkg)
        assert len(b) == len(pins(name)), name                                                  # no pin that the block reader missed

def test_the_dev_lock_has_everything_in_the_runtime_lock_at_the_same_version_and_the_dev_tools_on_top():
    rt, dev = pins('requirements.lock'), pins('requirements-dev.lock')
    assert set(rt) < set(dev) and all(dev[k] == v for k, v in rt.items())
    extras = {req_name(s) for s in toml()['project']['optional-dependencies']['dev']}
    assert {'pytest', 'hypothesis', 'httpx2', 'pyyaml', 'ruff'} <= extras and extras <= set(dev)
    assert not extras & set(rt)                                                                  # the runtime lock carries no test or lint tool

def test_the_runtime_lock_has_every_dependency_pyproject_names_and_pins_tzdata():
    names = {req_name(s) for s in toml()['project']['dependencies']}; rt = pins('requirements.lock')
    assert names <= set(rt) and re.fullmatch(r'\d{4}\.\d+', rt['tzdata'])                       # tzdata: Windows has no time-zone database (design 3.10)

def test_the_lock_headers_name_the_command_and_a_cut_off_date_that_is_not_in_the_future():
    import datetime
    for name in ('requirements.lock', 'requirements-dev.lock'):
        head = '\n'.join((ROOT / name).read_text(encoding='utf-8').splitlines()[:4])
        m = re.search(r'just lock (\d{4}-\d{2}-\d{2})', head); assert m, name
        assert datetime.date.fromisoformat(m.group(1)) <= datetime.date.today(), name
    assert '\r' not in (ROOT / 'requirements.lock').read_text(encoding='utf-8')                  # LF, so the manifest hash agrees on Windows and Linux

def test_python_and_node_versions_are_in_one_place_each_and_agree_with_pyproject_and_ci():
    py = (ROOT / '.python-version').read_text(encoding='utf-8').strip(); node = (ROOT / '.nvmrc').read_text(encoding='utf-8').strip()
    assert py == '3.12' and node == '22' and toml()['project']['requires-python'] == '>=' + py
    ci = (ROOT / '.github' / 'workflows' / 'ci.yml').read_text(encoding='utf-8')
    assert set(re.findall(r"python-version: '([\d.]+)'", ci)) == {py} and set(re.findall(r'node-version: (\d+)', ci)) == {node}
    assert f'--python-version {py}' in (ROOT / 'justfile').read_text(encoding='utf-8')

def test_ci_and_just_setup_install_from_the_locked_hashes_not_from_the_loose_ranges():
    ci = (ROOT / '.github' / 'workflows' / 'ci.yml').read_text(encoding='utf-8'); jf = (ROOT / 'justfile').read_text(encoding='utf-8').replace('\r\n', '\n')
    for t in (ci, jf): assert 'pip install --require-hashes -r requirements-dev.lock' in t and 'pip install --no-deps -e .' in t and '.[dev]' not in t
    assert 'cache-dependency-path: requirements-dev.lock' in ci and re.search(r'^lock cutoff:\n(?:    .*\n)+', jf, re.M)

def test_ruff_is_set_to_lint_only_with_rules_e9_and_f_and_finds_nothing_in_host_and_tools():
    r = toml()['tool']['ruff']; assert r['lint']['select'] == ['E9', 'F'] and 'format' not in r and r['target-version'] == 'py312'
    p = subprocess.run([sys.executable, '-m', 'ruff', 'check', 'host', 'tools', '--no-cache'], cwd=ROOT, capture_output=True, text=True)
    if 'No module named ruff' in p.stderr: pytest.skip('ruff is not installed: python -m pip install --require-hashes -r requirements-dev.lock')
    assert p.returncode == 0, p.stdout + p.stderr

def test_biome_lints_the_dashboard_without_a_formatter_and_keeps_the_mistake_rules_on():
    b = json.loads((ROOT / 'dashboard' / 'biome.json').read_text(encoding='utf-8')); rules = b['linter']['rules']
    assert b['formatter']['enabled'] is False and b['linter']['enabled'] is True and rules['preset'] == 'none'
    assert rules['suspicious']['noDebugger'] == 'error' and rules['suspicious']['noDoubleEquals'] == 'error' and rules['correctness']['noUnusedVariables'] == 'error' and rules['correctness']['noUnusedImports'] == 'error'
    assert '!src/gen/**' in b['files']['includes']                                               # generated files are never edited by hand (design 12.1)
    pkg = json.loads((ROOT / 'dashboard' / 'package.json').read_text(encoding='utf-8')); assert pkg['scripts']['lint'] == 'biome lint .' and re.fullmatch(r'\d+\.\d+\.\d+', pkg['devDependencies']['@biomejs/biome'])

def test_vitest_is_4_1_12_or_newer_in_the_dashboard_lock_so_the_advisories_on_3_x_stay_closed():
    pk = json.loads((ROOT / 'dashboard' / 'package-lock.json').read_text(encoding='utf-8'))['packages']
    v = tuple(int(x) for x in pk['node_modules/vitest']['version'].split('.')); assert v >= (4, 1, 12)
    assert pk['node_modules/@biomejs/biome']['version'] == json.loads((ROOT / 'dashboard' / 'package.json').read_text(encoding='utf-8'))['devDependencies']['@biomejs/biome']
