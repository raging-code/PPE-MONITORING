"""P27-2 (ADR 0041): the CI workflow parses and says what design 12.1 and 14.5 ask of it, and the import rule of tools/check_imports.py catches what it names.
The workflow is read as YAML (pyyaml, which P27b needs anyway: python -m pip install pyyaml); without it only the five tests that read the workflow are skipped, the import-rule tests still run."""
import importlib.util, re, sys, textwrap
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / f'{name}.py'); m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m
CI = _load('check_imports')
WORKFLOW = ROOT / '.github' / 'workflows' / 'ci.yml'
def wf():
    yaml = pytest.importorskip('yaml', reason='pyyaml is not installed: python -m pip install pyyaml')
    return yaml.safe_load(WORKFLOW.read_text(encoding='utf-8'))
def runs(job): return '\n'.join(s.get('run', '') for s in wf()['jobs'][job]['steps'])
def just_recipe(name):
    m = re.search(r'^%s:\n((?:    .*\n?)+)' % name, (ROOT / 'justfile').read_text(encoding='utf-8').replace('\r\n', '\n'), re.M); return [l.strip() for l in m.group(1).splitlines() if l.strip()]

def test_the_workflow_parses_and_has_the_three_jobs_on_push_and_pull_request():
    w = wf(); trig = w.get('on', w.get(True))                       # YAML 1.1 reads the key `on` as True
    assert set(w['jobs']) == {'host', 'firmware', 'dashboard'} and 'push' in trig and 'pull_request' in trig and w['permissions'] == {'contents': 'read'}
    for name, job in w['jobs'].items():
        assert job['runs-on'] == 'ubuntu-latest' and job['timeout-minutes'] and job['steps'][0]['uses'].startswith('actions/checkout@v')
        for s in job['steps']: assert ('run' in s) != ('uses' in s), (name, s)                    # every step does exactly one of the two

def test_every_action_is_pinned_to_a_version_and_python_is_3_12():
    for job in wf()['jobs'].values():
        for s in job['steps']:
            if 'uses' in s: assert re.fullmatch(r'actions/[a-z-]+@v\d+', s['uses']), s['uses']
            if s.get('uses', '').startswith('actions/setup-python'): assert s['with']['python-version'] == '3.12'
            if s.get('uses', '').startswith('actions/setup-node'): assert str(s['with']['node-version']) == '22'

def test_host_job_regenerates_checks_the_tree_then_runs_lint_import_rule_pytest_and_vectors_in_that_order():
    r = runs('host'); gens = re.findall(r'python tools/(gen_\w+)\.py', r)
    assert gens == [l.split('tools/')[1][:-3] for l in just_recipe('gen')]                    # the same generators, in the same order, as `just gen`
    order = [r.index(x) for x in ('tools/gen_abi.py', 'git status --porcelain', 'tools/doc_lint.py', 'tools/check_imports.py', 'pytest host/tests', 'tools/test_vectors.py')]; assert order == sorted(order)
    assert 'exit 1' in r and 'git status --porcelain' in r                                    # untracked files count, not only changed ones

def test_firmware_job_builds_with_gcc_like_just_test_fw_and_dashboard_job_uses_the_lock_file():
    assert just_recipe('test-fw') == [l.strip() for l in runs('firmware').splitlines() if l.strip().startswith('python ')]
    d = [l for l in runs('dashboard').splitlines() if l.strip()]; assert d == ['npm ci', 'npm run typecheck', 'npm test', 'npm run build'] and wf()['jobs']['dashboard']['defaults']['run']['working-directory'] == 'dashboard'

def test_every_file_a_ci_command_names_exists():
    for job in wf()['jobs']:
        for f in re.findall(r'(?:python|python -m pytest)\s+((?:tools|host)/[\w/.]+)', runs(job)): assert (ROOT / f).exists(), f
    assert (ROOT / 'dashboard' / 'package-lock.json').is_file() and (ROOT / 'pyproject.toml').is_file()

# ---- the import rule ----
def core(tmp_path, files):
    d = tmp_path / 'host' / 'ppe_host' / 'core'; d.mkdir(parents=True)
    for name, src in files.items(): (d / name).write_text(textwrap.dedent(src), encoding='utf-8')
    return tmp_path
def bad(tmp_path, src): bad_, n = CI.check(core(tmp_path, {'x.py': src})); return bad_

def test_the_real_core_folder_passes_and_the_rule_checks_every_file():
    bad_, n = CI.check(ROOT); assert bad_ == [] and n == len(list((ROOT / 'host' / 'ppe_host' / 'core').glob('*.py'))) >= 5 and CI.main() == 0

@pytest.mark.parametrize('src', ['from ..io import db_writer', 'from ..io.backup import online_backup', 'from .. import services', 'from ..services.recovery import rebuild', 'from ..api import models',
                                 'import ppe_host.io.ingest', 'from ppe_host.api.models import X', 'from ppe_host.services import sessions', 'from ... import ppe_host\nfrom ppe_host import api'])
def test_an_import_from_io_services_or_api_is_a_violation_in_every_form(tmp_path, src): assert bad(tmp_path, src)
@pytest.mark.parametrize('src', ['import os', 'from pathlib import Path', 'import sqlite3', 'import serial', 'import socket', 'import subprocess', 'import winsound', 'from urllib.request import urlopen', 'import asyncio',
                                 'def f():\n    import shutil', 'import io', 'import importlib'])
def test_an_import_of_a_module_that_does_io_is_a_violation_even_inside_a_function(tmp_path, src): assert bad(tmp_path, src)
@pytest.mark.parametrize('src', ["def f(): return open('x')", 'x = input()', "m = __import__('os')"])
def test_open_input_and_dynamic_import_calls_are_violations(tmp_path, src): assert bad(tmp_path, src)
@pytest.mark.parametrize('src', ['from .. import constants as K', 'from .. import abi', 'from .rule_engine import FULL', 'import hmac', 'from dataclasses import dataclass', 'from typing import Optional',
                                 'from cryptography.hazmat.primitives.cmac import CMAC', 'from ..clock import Clock', 'x = {"open": 1}\nprint(x["open"])'])
def test_the_imports_core_really_uses_and_a_name_that_only_looks_like_a_call_are_fine(tmp_path, src): assert bad(tmp_path, src) == []

def test_violations_name_the_file_and_line_a_subfolder_is_checked_and_a_missing_core_folder_fails(tmp_path):
    r = core(tmp_path, {'ok.py': 'import hmac\n', 'bad.py': 'import hmac\n\nfrom ..io import db_writer\n'}); (r / 'host' / 'ppe_host' / 'core' / 'sub').mkdir(); (r / 'host' / 'ppe_host' / 'core' / 'sub' / 'deep.py').write_text('import socket\n')
    out, n = CI.check(r); assert n == 3 and len(out) == 2 and any(l.startswith('host/ppe_host/core/bad.py:3: core must not import ppe_host.io') for l in out) and any('sub/deep.py:1' in l for l in out)
    assert CI.check(tmp_path / 'nothing')[0] == ['host/ppe_host/core/ not found']
    (r / 'host' / 'ppe_host' / 'core' / 'broken.py').write_text('def (:\n'); assert any('cannot parse' in l for l in CI.check(r)[0])
