"""P27-1 (ADR 0041): tools/build_manifest.py (design 13, the canonical build_manifest.json contract) and tools/package_release.py (design 1, release folder).
The real repository gives every key in the contract's order with real hashes where the source exists; a synthetic tree checks each source, the null for a missing one, --strict, and the release folder. Requirements: REQ-OPS-002."""
import importlib.util, json, re, shutil, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path
import pytest
from ppe_host.settings import constants_hash, canonical_json

ROOT = Path(__file__).resolve().parents[2]
def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / f'{name}.py'); m = importlib.util.module_from_spec(spec); sys.modules[name] = m; spec.loader.exec_module(m); return m
BM = _load('build_manifest'); PR = _load('package_release')
HEX64 = re.compile(r'[0-9a-f]{64}')
SHA = 'a' * 40

def docx(path, title):
    with zipfile.ZipFile(path, 'w') as z: z.writestr('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:body></w:document>' % title)
def tree(tmp_path, rev='Rev 3.45', lock=True, stl=False):
    r = tmp_path / 'repo'; (r / 'docs').mkdir(parents=True); (r / 'shared').mkdir(); (r / 'dashboard' / 'public').mkdir(parents=True)
    docx(r / 'docs' / 'PPE_Software_Design_Compact_Rev3_45.docx', 'PPE Monitoring System: Software Design (Compact \u2014 %s)' % rev)
    (r / 'shared' / 'constants.json').write_text('{"b": 2, "a": 1}', encoding='utf-8'); (r / 'shared' / 'alert_catalog.json').write_text('[{"z": 1}]', encoding='utf-8'); (r / 'shared' / 'openapi.json').write_text('{\n  "openapi": "3.1.0"\n}\n', encoding='utf-8')
    (r / 'dashboard' / 'package-lock.json').write_text('{}\n', encoding='utf-8')
    if lock: (r / 'requirements.lock').write_text('fastapi==0.1\n', encoding='utf-8')
    if stl: (r / 'dashboard' / 'public' / 'jacket_model.stl').write_bytes(b'solid x\r\nendsolid\r\n')
    return r

# ---- the real repository ----
def test_the_repository_manifest_has_every_key_of_13_in_order_with_real_hashes():
    m = BM.build(ROOT, env={}, now=datetime(2026, 11, 27, tzinfo=timezone.utc))
    assert tuple(m) == BM.KEYS == ('schema_version', 'rev_tag', 'git_commit', 'esp_idf_version', 'python_lock_sha256', 'npm_lock_sha256', 'constants_sha256', 'alert_catalog_sha256', 'stl_sha256', 'openapi_sha256', 'built_ts_utc')
    assert m['schema_version'] == 1 and m['rev_tag'] == 'Rev 3.45' and m['built_ts_utc'] == '2026-11-27T00:00:00Z'
    for k in ('npm_lock_sha256', 'constants_sha256', 'alert_catalog_sha256', 'openapi_sha256'): assert HEX64.fullmatch(m[k]), k
    assert m['constants_sha256'] == constants_hash(ROOT / 'shared' / 'constants.json')                       # the same serialisation as the host's constants_hash
    assert all(m[k] is None or HEX64.fullmatch(m[k]) for k in ('python_lock_sha256', 'stl_sha256'))

def test_the_manifest_file_is_valid_json_with_lf_line_ends_and_the_exit_code_follows_strict(tmp_path, monkeypatch, capsys):
    r = tree(tmp_path); monkeypatch.setattr(BM, 'ROOT', r); out = tmp_path / 'o' / 'm.json'
    assert BM.main(['--out', str(out), '--ts', '2026-01-02T03:04:05Z']) == 0 and b'\r\n' not in out.read_bytes() and json.loads(out.read_text())['built_ts_utc'] == '2026-01-02T03:04:05Z'
    err = capsys.readouterr().err; assert 'git_commit is null' in err and 'esp_idf_version is null' in err and 'stl_sha256 is null' in err
    assert BM.main(['--out', str(out), '--strict']) == 1                                                  # git_commit and esp_idf_version are null in a tree without .git
    monkeypatch.setenv('GITHUB_SHA', SHA); monkeypatch.setenv('ESP_IDF_VERSION', 'v5.3.2-abcdef0'); assert BM.main(['--out', str(out), '--strict']) == 0   # only the optional stl_sha256 is still null
    assert BM.main(['--out', str(out), '--ts', 'yesterday']) == 2

# ---- each source ----
def test_rev_tag_comes_from_the_document_title_and_the_newest_wins(tmp_path):
    r = tree(tmp_path, 'Rev 3.45'); docx(r / 'docs' / 'PPE_Software_Design_Compact_Rev3_9.docx', 'PPE: Software Design (Compact \u2014 Rev 3.9)'); assert BM.rev_tag(r) == 'Rev 3.45'
    docx(r / 'docs' / 'PPE_Software_Design_Compact_Rev4_0.docx', 'PPE: Software Design (Compact - Rev 4.0)'); assert BM.rev_tag(r) == 'Rev 4.0'
    for f in (r / 'docs').glob('*.docx'): f.unlink()
    with pytest.raises(BM.ManifestError): BM.rev_tag(r)
    (r / 'docs' / 'PPE_Software_Design_Compact_Rev9.docx').write_bytes(b'not a zip'); 
    with pytest.raises(BM.ManifestError): BM.rev_tag(r)

def test_hashes_follow_the_contract_and_text_files_ignore_crlf(tmp_path):
    r = tree(tmp_path, stl=True); m = BM.build(r, env={}); import hashlib
    assert m['constants_sha256'] == hashlib.sha256(canonical_json({'a': 1, 'b': 2})).hexdigest() == BM.canonical_sha(r / 'shared' / 'constants.json')        # key order and spaces do not matter
    (r / 'shared' / 'constants.json').write_text('{ "a":1,\n"b":2 }', encoding='utf-8'); assert BM.build(r, env={})['constants_sha256'] == m['constants_sha256']
    assert m['python_lock_sha256'] == hashlib.sha256(b'fastapi==0.1\n').hexdigest()
    (r / 'requirements.lock').write_bytes(b'fastapi==0.1\r\n'); assert BM.build(r, env={})['python_lock_sha256'] == m['python_lock_sha256']                     # Windows checkout, same hash
    assert m['stl_sha256'] == hashlib.sha256(b'solid x\r\nendsolid\r\n').hexdigest()                                                                         # the model is binary: hashed as it is
    assert m['openapi_sha256'] == hashlib.sha256(b'{\n  "openapi": "3.1.0"\n}\n').hexdigest()
    (r / 'shared' / 'constants.json').write_text('{"a": 2, "b": 2}'); assert BM.build(r, env={})['constants_sha256'] != m['constants_sha256']

def test_a_missing_source_is_null_never_invented(tmp_path):
    m = BM.build(tree(tmp_path, lock=False), env={}); assert m['python_lock_sha256'] is None and m['stl_sha256'] is None and m['git_commit'] is None and m['esp_idf_version'] is None
    assert BM.nulls(m) == ['git_commit', 'esp_idf_version', 'python_lock_sha256', 'stl_sha256']

def test_git_commit_and_esp_idf_and_the_timestamp_sources(tmp_path):
    r = tree(tmp_path); assert BM.git_commit(r, {'GITHUB_SHA': SHA.upper()}) == SHA and BM.git_commit(r, {'GITHUB_SHA': 'abc'}) is None and BM.git_commit(r, {'GITHUB_SHA': ''}) is None
    assert BM.esp_idf(r, {'ESP_IDF_VERSION': ' v5.3.2 '}) == 'v5.3.2' and BM.esp_idf(r, {}) is None
    (r / 'firmware').mkdir(); (r / 'firmware' / 'esp_idf_version.txt').write_text('\n  v5.2.1 3b4c5d6\nignored\n'); assert BM.esp_idf(r, {}) == 'v5.2.1 3b4c5d6' and BM.esp_idf(r, {'ESP_IDF_VERSION': 'env wins'}) == 'env wins'
    assert BM.built_ts({'SOURCE_DATE_EPOCH': '86400'}) == '1970-01-02T00:00:00Z' and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', BM.built_ts({}))

def test_a_real_git_checkout_gives_its_head_commit(tmp_path):
    import subprocess
    if shutil.which('git') is None: pytest.skip('no git')
    r = tree(tmp_path); run = lambda *a: subprocess.run(['git', *a], cwd=r, check=True, capture_output=True)
    run('init', '-q'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x')
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=r, capture_output=True, text=True).stdout.strip(); assert BM.git_commit(r, {}) == head and len(head) == 40

# ---- the release folder ----
def release_tree(tmp_path):
    r = tree(tmp_path, stl=False); (r / 'dashboard' / 'dist' / 'assets').mkdir(parents=True); (r / 'dashboard' / 'dist' / 'index.html').write_text('<html></html>')
    for d in ('host/ppe_host/__pycache__', 'host/migrations', 'host/config', 'host/tests', 'scripts', 'dashboard/node_modules', 'data', 'config'): (r / d).mkdir(parents=True, exist_ok=True)
    (r / 'host/ppe_host/__init__.py').write_text(''); (r / 'host/ppe_host/__pycache__/x.pyc').write_bytes(b'0'); (r / 'host/migrations/0001.sql').write_text('--'); (r / 'host/config/settings.json').write_text('{}'); (r / 'host/config/secrets.json').write_text('{"cmac_key":"x"}')
    (r / 'host/tests/test_x.py').write_text('x'); (r / 'scripts/run_supervisor.py').write_text('x'); (r / 'dashboard/node_modules/a.js').write_text('x'); (r / 'data/ppe.db').write_bytes(b'db'); (r / 'config/secrets.json').write_text('{}')
    return r

def test_the_release_folder_has_the_run_time_files_and_never_tests_data_or_secrets(tmp_path):
    r = release_tree(tmp_path); out, m = PR.package(r, env={}); names = {str(p.relative_to(out)).replace('\\', '/') for p in out.rglob('*') if p.is_file()}
    assert {'host/ppe_host/__init__.py', 'host/migrations/0001.sql', 'host/config/settings.json', 'shared/constants.json', 'scripts/run_supervisor.py', 'dashboard/dist/index.html', 'requirements.lock', 'build_manifest.json'} <= names
    assert not any(('secrets' in n or n.endswith('.pyc') or n.endswith('.db') or '/tests/' in n or 'node_modules' in n or n.startswith(('data/', 'config/'))) for n in names)
    assert json.loads((out / 'build_manifest.json').read_text())['rev_tag'] == 'Rev 3.45' and m['python_lock_sha256'] is not None

def test_the_release_folder_needs_a_built_dashboard_and_replaces_an_older_one(tmp_path):
    r = release_tree(tmp_path); (r / 'dashboard' / 'dist' / 'index.html').unlink()
    with pytest.raises(BM.ManifestError, match='just build'): PR.package(r, env={})
    (r / 'dashboard' / 'dist' / 'index.html').write_text('<html></html>'); out, _ = PR.package(r, env={}); (out / 'stale.txt').write_text('old'); out2, _ = PR.package(r, env={})
    assert out2 == out and not (out / 'stale.txt').exists()
