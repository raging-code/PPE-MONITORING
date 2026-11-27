"""P27b-2 (ADR 0044): requirements/requirements.yaml and tools/check_requirements.py (design 8.1 and 7).
Fixture ids are built from pieces (P + 'ZZZ-999'), so this file never contains an id-shaped token that the check would read as a real one."""
import importlib.util, re, shutil, subprocess, sys
from pathlib import Path
import pytest
yaml = pytest.importorskip('yaml')

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location('check_requirements', ROOT / 'tools' / 'check_requirements.py'); CR = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(CR)
P = 'REQ-'
def doc(): return yaml.safe_load((ROOT / 'requirements' / 'requirements.yaml').read_text(encoding='utf-8'))
def s08_rows():
    out = []
    for l in (ROOT / 'docs' / 'design' / 's08.md').read_text(encoding='utf-8').splitlines():
        if l.startswith('|') and not l.startswith('|---') and not l.startswith('| Item'):
            c = [x.strip() for x in l.strip('|').split('|')]; out.append((c[0], sorted(set(re.findall(r'\bD(?:\d+|-FW)\b', c[1])))))
    return out
def tree(tmp_path, d=None, tests=None):
    """A scratch repository: the requirements file (as given) and the test files (path: text)."""
    (tmp_path / 'requirements').mkdir(parents=True); (tmp_path / 'requirements' / 'requirements.yaml').write_text(yaml.safe_dump(d if d is not None else doc(), sort_keys=False), encoding='utf-8')
    for rel, text in (tests or {}).items(): (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True); (tmp_path / rel).write_text(text, encoding='utf-8')
    return tmp_path
def problems(tmp_path, d=None, tests=None): return CR.check(tree(tmp_path, d, tests))[0]

# ---- the real file ----
def test_the_real_file_and_the_real_test_folders_pass_the_check_and_the_tool_exits_0():
    bad, _ = CR.check(ROOT); assert bad == []
    p = subprocess.run([sys.executable, str(ROOT / 'tools' / 'check_requirements.py')], cwd=ROOT, capture_output=True, text=True); assert p.returncode == 0 and 'requirements ok' in p.stdout, p.stdout + p.stderr

def test_there_is_one_requirement_per_row_of_the_design_8_table_with_its_title_and_d_tests_and_each_row_is_proposed():
    rows, reqs = s08_rows(), doc()['requirements']
    assert len(rows) == 74 and len(reqs) == len(rows)
    for i, ((title, dt), r) in enumerate(zip(rows, reqs), 1):
        assert r['title'] == title and r['dtests'] == dt and r['source'] == '8, test table row %d' % i, r['id']
        assert r['status'] == 'Proposed', r['id']                                        # 8 is headed (Proposed); no row is promoted by code

def test_ids_are_numbered_from_001_without_gaps_in_each_area_and_every_area_is_used():
    d = doc(); per = {}
    for r in d['requirements']: m = CR.ID.fullmatch(r['id']); per.setdefault(m.group(1), []).append(int(m.group(2)))
    assert set(per) == set(d['areas']) and all(v == list(range(1, len(v) + 1)) for v in per.values())

def test_hazards_h1_to_h22_have_the_titles_of_design_7_and_each_maps_to_requirements():
    t7 = (ROOT / 'docs' / 'design' / 's07.md').read_text(encoding='utf-8'); d = doc()
    titles = dict(re.findall(r'^\| (H\d+) ([^|]+?) \|', t7, re.M)); assert len(titles) == 22
    assert list(d['hazards']) == ['H%d' % n for n in range(1, 23)]
    for h, e in d['hazards'].items(): assert e['title'] == titles[h] and len(e['requirements']) >= 1, h

def test_every_d_test_a_hazard_names_in_design_7_is_named_by_one_of_its_requirements_or_is_not_a_d_test_of_design_8():
    """A hazard row of design 7 names D-tests (D1, D2, D8 ...). The union over the requirements it maps to must hold D8-style tests of design 8 at least once, so the mapping is not detached from the D-tests."""
    t7 = (ROOT / 'docs' / 'design' / 's07.md').read_text(encoding='utf-8'); d = doc(); by_id = {r['id']: r for r in d['requirements']}
    for line in t7.splitlines():
        m = re.match(r'\| (H\d+) .*\| ([^|]*) \|$', line)
        if not m: continue
        named = set(re.findall(r'\bD\d+\b', m.group(2))); got = {x for rid in d['hazards'][m.group(1)]['requirements'] for x in by_id[rid]['dtests']}
        assert named & got or not (named & {x for r in d['requirements'] for x in r['dtests']}), (m.group(1), named, got)

# ---- the check catches what it names ----
def test_an_unknown_id_in_a_python_a_vitest_or_a_playwright_file_is_reported_with_file_and_line(tmp_path):
    bad = problems(tmp_path, tests={'host/tests/test_a.py': 'def test_x():\n    """%sZZZ-999"""\n' % P, 'dashboard/tests/b.test.tsx': '// ok\nit("%sUI-999", () => {})\n' % P, 'e2e/tests/c.spec.ts': 'test("%sAPI-999", async () => {})\n' % P})
    assert sorted(b.split(' is not in')[0] for b in bad) == ['dashboard/tests/b.test.tsx:2: %sUI-999' % P, 'e2e/tests/c.spec.ts:1: %sAPI-999' % P, 'host/tests/test_a.py:2: %sZZZ-999' % P]

def test_a_known_id_is_fine_and_a_typo_that_looks_like_an_id_is_still_reported(tmp_path):
    first = doc()['requirements'][0]['id']
    assert problems(tmp_path / 'a', tests={'host/tests/test_a.py': 'def test_%s_ok(): pass\n' % first.replace('-', '_').lower() + '"""%s"""\n' % first}) == []
    bad = problems(tmp_path / 'b', tests={'host/tests/test_a.py': '"""%sAPI-12 and %sapi-001"""\n' % (P, P)}); assert len(bad) == 2

def test_other_folders_and_node_modules_are_not_scanned(tmp_path):
    assert problems(tmp_path, tests={'docs/x.md': P + 'ZZZ-999', 'dashboard/tests/node_modules/p/t.ts': P + 'ZZZ-999', 'host/ppe_host/m.py': '"%sZZZ-999"' % P}) == []

@pytest.mark.parametrize('edit,words', [
    (lambda d: d['requirements'][1].update(id=d['requirements'][0]['id']), 'duplicate'),
    (lambda d: d['requirements'][0].update(id=P + 'api-001'), 'not REQ-<AREA>-<nnn>'),
    (lambda d: d['requirements'][0].update(id=P + 'QQ-001'), 'is not in areas'),
    (lambda d: d['requirements'][0].update(status='Draft'), 'status'),
    (lambda d: d['requirements'][0].update(title=' '), 'title is missing'),
    (lambda d: d['requirements'][0].pop('source'), 'source is missing'),
    (lambda d: d['requirements'][0].update(dtests=['X1']), 'dtests'),
    (lambda d: d['hazards'].pop('H7'), 'hazard H7 is missing'),
    (lambda d: d['hazards']['H3'].update(requirements=[]), 'maps to no requirement'),
    (lambda d: d['hazards']['H3'].update(requirements=[P + 'ZZZ-999']), 'not a requirement'),
    (lambda d: d['hazards']['H3'].update(requirements=[d['requirements'][0]['id']] * 2), 'twice'),
    (lambda d: d['hazards'].update(H23={'title': 'x', 'requirements': [d['requirements'][0]['id']]}), 'not a hazard of design 7')])
def test_a_malformed_requirements_file_is_reported(tmp_path, edit, words):
    d = doc(); edit(d); bad = problems(tmp_path, d); assert any(words in b for b in bad), bad

def test_a_file_without_the_three_keys_is_one_clear_problem(tmp_path): assert problems(tmp_path, {'requirements': []}) == ['requirements/requirements.yaml: needs the keys areas, requirements and hazards']

def test_all_three_statuses_are_accepted_and_scan_reports_where_an_id_is_named(tmp_path):
    d = doc()
    for r, s in zip(d['requirements'], ('Spec', 'Proposed', 'Decided')): r['status'] = s
    first = d['requirements'][0]['id']; root = tree(tmp_path, d, {'host/tests/test_a.py': '"""%s"""\n' % first})
    assert CR.check(root)[0] == [] and CR.scan(root) == {first: [('host/tests/test_a.py', 1)]}

def test_the_report_counts_the_requirements_and_hazards_that_a_test_names(tmp_path):
    first = doc()['hazards']['H9']['requirements'][0]; root = tree(tmp_path, tests={'host/tests/test_a.py': '"""%s"""\n' % first}); (root / 'tools').mkdir(); shutil.copy(ROOT / 'tools' / 'check_requirements.py', root / 'tools')
    p = subprocess.run([sys.executable, str(root / 'tools' / 'check_requirements.py'), '--report'], capture_output=True, text=True); assert p.returncode == 0, p.stdout + p.stderr
    assert '74 requirements, 22 hazards, 1 requirements named by a test' in p.stdout and 'H9: 1 of 1 requirements named by a test' in p.stdout and 'H1: 1 of 2' in p.stdout and 'H2: 0 of 3' in p.stdout and first not in p.stdout.split('not named by any test yet:')[1].splitlines()[0]

def test_the_tool_exits_1_and_names_the_problem_on_a_bad_tree(tmp_path):
    root = tree(tmp_path, tests={'host/tests/test_a.py': '"""%sZZZ-999"""\n' % P}); (root / 'tools').mkdir(); shutil.copy(ROOT / 'tools' / 'check_requirements.py', root / 'tools')
    p = subprocess.run([sys.executable, str(root / 'tools' / 'check_requirements.py')], capture_output=True, text=True); assert p.returncode == 1 and '%sZZZ-999 is not in' % P in p.stdout

# ---- wiring ----
def test_just_lint_and_the_ci_host_job_run_the_check_after_the_import_rule_and_before_ruff_and_pytest():
    jf = (ROOT / 'justfile').read_text(encoding='utf-8').replace('\r\n', '\n'); lint = re.search(r'^lint:\n((?:    .*\n)+)', jf, re.M).group(1)
    assert lint.index('check_imports') < lint.index('python tools/check_requirements.py') < lint.index('ruff')
    runs = [s['run'] for s in yaml.safe_load((ROOT / '.github' / 'workflows' / 'ci.yml').read_text(encoding='utf-8'))['jobs']['host']['steps'] if 'run' in s]
    at = lambda needle: next(i for i, r in enumerate(runs) if needle in r)
    assert at('tools/check_imports.py') < at('tools/check_requirements.py') < at('ruff check') < at('pytest host/tests')

# ---- P27b-3 (ADR 0045): ids in the test files, the Spec check, the firmware tests ----
# The ids of the requirements that tests name today, without the prefix, so that this file names none of them itself. A tag must not be dropped by accident.
NAMED_TODAY = (
    'API-001 API-002 API-003 API-004 API-005 API-006 API-007 API-008 API-009 API-010 '
    'API-011 API-012 AUD-001 AUD-002 AUD-003 AUD-004 AUD-005 DB-001 DB-002 DB-003 '
    'DB-004 DB-005 DB-006 FW-001 FW-002 FW-003 FW-004 ING-002 ING-003 ING-004 '
    'OPS-001 OPS-002 REC-001 REC-002 REC-003 REC-004 REC-005 REC-007 REC-008 RUL-001 '
    'RUL-002 RUL-003 RUL-004 RUL-005 RUL-006 RUL-007 RUL-008 RUL-009 RUL-010 RUL-011 '
    'RUL-012 SEC-001 SEC-002 SEC-003 SEC-004 SEC-005 SES-001 SES-002 SES-003 SES-004 '
    'UI-001 UI-002 UI-003 UI-004 UI-005 UI-006 UI-007 UI-008 UI-009 UI-010'
).split()
def with_status(status, rid='API-001'):
    d = doc()
    for r in d['requirements']:
        if r['id'] == P + rid: r['status'] = status
    return d

def test_a_spec_requirement_that_no_test_names_is_reported_by_its_id(tmp_path):
    assert problems(tmp_path, with_status('Spec')) == ['requirements/requirements.yaml: %sAPI-001 is Spec and no test names it' % P]

def test_a_spec_requirement_that_a_test_file_names_passes(tmp_path):
    assert problems(tmp_path, with_status('Spec'), {'host/tests/test_a.py': '"""Requirements: %sAPI-001."""\n' % P}) == []

def test_proposed_and_decided_requirements_need_no_test(tmp_path):
    assert problems(tmp_path / 'a', with_status('Proposed')) == [] and problems(tmp_path / 'b', with_status('Decided')) == []

def test_only_the_spec_status_is_checked_so_one_missing_test_is_one_line(tmp_path):
    d = with_status('Spec'); d['requirements'][0]['status'] = 'Spec'
    assert len(problems(tmp_path, d)) == 2                                                    # the first requirement and API-001, nothing else of the other 72

def test_a_c_test_in_firmware_tests_is_scanned_and_an_unknown_id_in_it_is_reported(tmp_path):
    assert problems(tmp_path, tests={'firmware/tests/t.c': '/* %sZZZ-999 */\n' % P}) == ['firmware/tests/t.c:1: %sZZZ-999 is not in requirements/requirements.yaml' % P]

def test_every_id_in_a_python_test_file_sits_in_the_module_docstring():
    import ast
    for p in sorted((ROOT / 'host' / 'tests').glob('*.py')):
        text = p.read_text(encoding='utf-8'); ids = set(CR.LOOSE.findall(text))
        if ids: assert ids <= set(CR.LOOSE.findall(ast.get_docstring(ast.parse(text)) or '')), p.name

def test_the_requirements_that_tests_name_today_stay_named():
    assert {P + x for x in NAMED_TODAY} <= set(CR.scan(ROOT))
