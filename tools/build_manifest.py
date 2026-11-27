"""tools/build_manifest.py (P27-1, ADR 0041): writes build_manifest.json, the canonical contract of design 13 (Generated Automatically at Build Time).
Keys, in this order: schema_version, rev_tag, git_commit, esp_idf_version, python_lock_sha256, npm_lock_sha256, constants_sha256, alert_catalog_sha256, stl_sha256, openapi_sha256, built_ts_utc.
  rev_tag               read from the title line of the newest docs/PPE_Software_Design_Compact_Rev*.docx ('... (Compact - Rev 3.45)'), so it cannot go stale (13).
  git_commit            $GITHUB_SHA, else `git rev-parse HEAD`; null when neither gives 40 hex characters (a zip without .git).
  esp_idf_version       $ESP_IDF_VERSION, else the first line of firmware/esp_idf_version.txt (the exact IDF tag and patch sha); null until one of them exists.
  python_lock_sha256    SHA-256 of requirements.lock (P27b writes it); npm_lock_sha256 of dashboard/package-lock.json. Text files are hashed with LF line ends, so Windows and Linux agree.
  constants_sha256, alert_catalog_sha256   canonical sorted compact UTF-8 JSON, the same serialisation as settings.constants_hash.
  stl_sha256            SHA-256 of the bytes of dashboard/public/jacket_model.stl; null while the optional model does not exist.
  openapi_sha256        SHA-256 of shared/openapi.json (LF line ends).
  built_ts_utc          ISO 8601 UTC with a Z, from --ts, else $SOURCE_DATE_EPOCH, else now.
A key whose source is missing is null (never a made-up value) and is named on stderr; --strict exits 1 when any key except stl_sha256 is null. Writes dist/build_manifest.json (dist/ is ignored by git) unless --out says otherwise."""
import argparse, hashlib, json, os, re, subprocess, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEYS = ('schema_version', 'rev_tag', 'git_commit', 'esp_idf_version', 'python_lock_sha256', 'npm_lock_sha256', 'constants_sha256', 'alert_catalog_sha256', 'stl_sha256', 'openapi_sha256', 'built_ts_utc')
OPTIONAL = ('stl_sha256',)
FILES = {'python_lock_sha256': 'requirements.lock', 'npm_lock_sha256': 'dashboard/package-lock.json', 'constants_sha256': 'shared/constants.json', 'alert_catalog_sha256': 'shared/alert_catalog.json',
         'stl_sha256': 'dashboard/public/jacket_model.stl', 'openapi_sha256': 'shared/openapi.json'}
TITLE = re.compile(r'Software Design\s*\(Compact\s*[—–-]+\s*Rev\s+(\d+)\.(\d+)\)')

class ManifestError(Exception): pass

def text_sha(path):
    """SHA-256 of a text file with CRLF read as LF."""
    return hashlib.sha256(Path(path).read_bytes().replace(b'\r\n', b'\n')).hexdigest()
def bytes_sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def canonical_sha(path):
    """The serialisation of settings.canonical_json: sorted keys, compact separators, UTF-8."""
    return hashlib.sha256(json.dumps(json.loads(Path(path).read_text(encoding='utf-8')), sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()

def rev_tag(root):
    """'Rev 3.45', from the title of the newest design document (highest major.minor)."""
    found = []
    for f in sorted(Path(root, 'docs').glob('PPE_Software_Design_Compact_Rev*.docx')):
        try:
            with zipfile.ZipFile(f) as z: xml = z.read('word/document.xml').decode('utf-8')
        except (OSError, KeyError, zipfile.BadZipFile) as e: raise ManifestError('cannot read %s (%s)' % (f.name, type(e).__name__)) from None
        m = TITLE.search(re.sub(r'<[^>]+>', ' ', xml)[:6000])
        if m: found.append((int(m.group(1)), int(m.group(2))))
    if not found: raise ManifestError('no docs/PPE_Software_Design_Compact_Rev*.docx with a "Software Design (Compact - Rev N.N)" title line')
    major, minor = max(found); return 'Rev %d.%d' % (major, minor)

def git_commit(root, env):
    sha = env.get('GITHUB_SHA', '').strip().lower()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        try: sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True, timeout=10).stdout.strip().lower()
        except (OSError, subprocess.SubprocessError): sha = ''
    return sha if re.fullmatch(r'[0-9a-f]{40}', sha) else None

def esp_idf(root, env):
    v = env.get('ESP_IDF_VERSION', '').strip()
    if v: return v
    f = Path(root, 'firmware', 'esp_idf_version.txt')
    if f.is_file():
        for line in f.read_text(encoding='utf-8').splitlines():
            if line.strip(): return line.strip()
    return None

def built_ts(env, now=None):
    if now is not None: t = now
    elif env.get('SOURCE_DATE_EPOCH', '').strip().isdigit(): t = datetime.fromtimestamp(int(env['SOURCE_DATE_EPOCH']), tz=timezone.utc)
    else: t = datetime.now(timezone.utc)
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def build(root=ROOT, env=None, now=None):
    """The manifest as a dict with the keys of KEYS in order. A missing source file gives null."""
    root = Path(root); env = os.environ if env is None else env
    def hashed(key, fn):
        p = root / FILES[key]; return fn(p) if p.is_file() else None
    m = {'schema_version': 1, 'rev_tag': rev_tag(root), 'git_commit': git_commit(root, env), 'esp_idf_version': esp_idf(root, env),
         'python_lock_sha256': hashed('python_lock_sha256', text_sha), 'npm_lock_sha256': hashed('npm_lock_sha256', text_sha),
         'constants_sha256': hashed('constants_sha256', canonical_sha), 'alert_catalog_sha256': hashed('alert_catalog_sha256', canonical_sha),
         'stl_sha256': hashed('stl_sha256', bytes_sha), 'openapi_sha256': hashed('openapi_sha256', text_sha), 'built_ts_utc': built_ts(env, now)}
    assert tuple(m) == KEYS; return m

def nulls(manifest): return [k for k in KEYS if manifest[k] is None]
SOURCE_OF = {'git_commit': 'no .git folder and no $GITHUB_SHA', 'esp_idf_version': 'no $ESP_IDF_VERSION and no firmware/esp_idf_version.txt'}

def main(argv=None):
    ap = argparse.ArgumentParser(prog='build_manifest', description='write build_manifest.json (design 13)')
    ap.add_argument('--out', default=str(ROOT / 'dist' / 'build_manifest.json')); ap.add_argument('--strict', action='store_true', help='exit 1 when any key except stl_sha256 is null')
    ap.add_argument('--ts', help='built_ts_utc as ISO 8601 UTC (default: SOURCE_DATE_EPOCH or now)'); a = ap.parse_args(argv)
    now = None
    if a.ts:
        try: now = datetime.fromisoformat(a.ts.replace('Z', '+00:00')); now = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
        except ValueError: print('build_manifest: --ts must be ISO 8601, got %r' % a.ts, file=sys.stderr); return 2
    try: m = build(ROOT, now=now)
    except (ManifestError, OSError, ValueError) as e: print('build_manifest: %s' % e, file=sys.stderr); return 2
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_bytes((json.dumps(m, indent=2) + '\n').encode('utf-8'))
    for k in nulls(m): print('build_manifest: %s is null (%s)' % (k, SOURCE_OF.get(k, '%s not found' % FILES.get(k, k))), file=sys.stderr)
    print('build_manifest: wrote %s (%s, %d of %d keys set)' % (out, m['rev_tag'], len(KEYS) - len(nulls(m)), len(KEYS)))
    return 1 if a.strict and [k for k in nulls(m) if k not in OPTIONAL] else 0

if __name__ == '__main__': sys.exit(main())
