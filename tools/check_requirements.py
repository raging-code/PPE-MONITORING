"""tools/check_requirements.py (P27b-2, ADR 0044): the requirement traceability check of design 8.1, run by `just lint` and in CI.
Reads requirements/requirements.yaml and fails (exit 1, one line per problem) when:
  - the file is malformed: an id that is not REQ-<AREA>-<nnn> (AREA is a key of `areas`, nnn is three digits), a duplicate id, a status that is not Spec, Proposed or Decided, a missing title or source, a dtests entry that is not D<n> or D-FW;
  - a hazard H1 to H22 is missing, or maps to no requirement, or names an id that is not in the file;
  - a requirement with status Spec has no test that names it (design 8.1, P27b-3; Proposed and Decided are not checked);
  - a test file names an id that is not in the file. Test files are host/tests/*.py, dashboard/tests/*.ts(x), e2e/tests/*.ts and firmware/tests/*.c. Any token that looks like REQ-<letters>-<digits> counts, so a typo such as REQ-API-12 is reported too.
`--report` also prints the requirements that no test names yet and the hazards with the number of tests behind them (information only; the ids sit in the module docstring or a header comment of each test file, P27b-3, ADR 0045).
Needs pyyaml (a dev dependency in requirements-dev.lock). Nothing is imported or run from the tests; they are only read as text."""
import re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILE = Path('requirements') / 'requirements.yaml'
STATUSES = ('Spec', 'Proposed', 'Decided')
HAZARDS = tuple('H%d' % n for n in range(1, 23))
ID = re.compile(r'REQ-([A-Z]{2,3})-(\d{3})')
LOOSE = re.compile(r'REQ-[A-Za-z]+-\d+')
DTEST = re.compile(r'D\d+|D-FW')
TEST_GLOBS = (('host/tests', '*.py'), ('dashboard/tests', '*.ts'), ('dashboard/tests', '*.tsx'), ('e2e/tests', '*.ts'), ('firmware/tests', '*.c'))

def load(root=ROOT):
    import yaml
    with open(Path(root) / FILE, encoding='utf-8') as f: return yaml.safe_load(f)

def check_file(doc):
    """Problems in the requirements file itself (a list of strings)."""
    bad = []
    if not isinstance(doc, dict) or not isinstance(doc.get('areas'), dict) or not isinstance(doc.get('requirements'), list) or not isinstance(doc.get('hazards'), dict):
        return ['%s: needs the keys areas, requirements and hazards' % str(FILE).replace('\\', '/')]
    areas, seen = doc['areas'], {}
    for i, r in enumerate(doc['requirements'], 1):
        rid = r.get('id') if isinstance(r, dict) else None
        where = '%s: requirement %d (%s)' % (FILE, i, rid)
        if not isinstance(rid, str) or not ID.fullmatch(rid): bad.append('%s: id is not REQ-<AREA>-<nnn>' % where); continue
        if ID.fullmatch(rid).group(1) not in areas: bad.append('%s: area %s is not in areas' % (where, ID.fullmatch(rid).group(1)))
        if rid in seen: bad.append('%s: duplicate id' % where)
        seen[rid] = r
        if r.get('status') not in STATUSES: bad.append('%s: status %r is not one of %s' % (where, r.get('status'), ', '.join(STATUSES)))
        for k in ('title', 'source'):
            if not isinstance(r.get(k), str) or not r[k].strip(): bad.append('%s: %s is missing' % (where, k))
        d = r.get('dtests')
        if not isinstance(d, list) or not all(isinstance(x, str) and DTEST.fullmatch(x) for x in d): bad.append('%s: dtests must be a list of D<n> or D-FW' % where)
    haz = doc['hazards']
    for h in HAZARDS:
        e = haz.get(h)
        if not isinstance(e, dict) or not isinstance(e.get('title'), str) or not e['title'].strip(): bad.append('%s: hazard %s is missing or has no title' % (FILE, h)); continue
        rs = e.get('requirements')
        if not isinstance(rs, list) or not rs: bad.append('%s: hazard %s maps to no requirement' % (FILE, h)); continue
        for x in rs:
            if x not in seen: bad.append('%s: hazard %s names %s, which is not a requirement' % (FILE, h, x))
        if len(set(rs)) != len(rs): bad.append('%s: hazard %s lists a requirement twice' % (FILE, h))
    for h in haz:
        if h not in HAZARDS: bad.append('%s: %s is not a hazard of design 7 (H1 to H22)' % (FILE, h))
    return bad

def test_files(root=ROOT):
    root = Path(root)
    return sorted(p for d, g in TEST_GLOBS if (root / d).is_dir() for p in (root / d).rglob(g) if 'node_modules' not in p.parts)

def scan(root=ROOT):
    """{id-like token: [(file, line), ...]} for every REQ token in the test files."""
    out = {}
    for p in test_files(root):
        for n, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
            for m in LOOSE.finditer(line): out.setdefault(m.group(0), []).append((p.relative_to(root).as_posix(), n))
    return out

def spec_without_test(doc, used):
    """One line per requirement with status Spec that no test file names (design 8.1: CI fails when a Spec item has no test)."""
    return ['%s: %s is Spec and no test names it' % (FILE.as_posix(), r['id']) for r in doc['requirements'] if isinstance(r, dict) and r.get('status') == 'Spec' and r.get('id') not in used]

def check(root=ROOT):
    doc = load(root); bad = check_file(doc)
    known = {r['id'] for r in doc['requirements'] if isinstance(r, dict) and 'id' in r} if isinstance(doc, dict) and isinstance(doc.get('requirements'), list) else set()
    used = scan(root)
    for tok, where in sorted(used.items()):
        if tok not in known: bad += ['%s:%d: %s is not in %s' % (f, n, tok, FILE.as_posix()) for f, n in where]
    if isinstance(doc, dict) and isinstance(doc.get('requirements'), list): bad += spec_without_test(doc, used)
    return bad, doc

def main(argv):
    try: import yaml  # noqa: F401
    except ImportError: print('check_requirements: pyyaml is needed (python -m pip install --require-hashes -r requirements-dev.lock)', file=sys.stderr); return 2
    if not (ROOT / FILE).is_file(): print('check_requirements: %s is missing' % FILE, file=sys.stderr); return 1
    bad, doc = check()
    for b in bad: print(b)
    if '--report' in argv and not bad:
        used = scan(); reqs = doc['requirements']
        print('%d requirements, %d hazards, %d requirements named by a test' % (len(reqs), len(doc['hazards']), sum(1 for r in reqs if r['id'] in used)))
        print('not named by any test yet: ' + (', '.join(r['id'] for r in reqs if r['id'] not in used) or 'none'))
        for h in HAZARDS: print('%s: %d of %d requirements named by a test' % (h, sum(1 for x in doc['hazards'][h]['requirements'] if x in used), len(doc['hazards'][h]['requirements'])))
    if not bad and '--report' not in argv: print('requirements ok: %d requirements, hazards H1 to H22 mapped' % len(doc['requirements']))
    return 1 if bad else 0

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
