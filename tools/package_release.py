"""tools/package_release.py (P27-1, ADR 0041): assembles the release folder dist/release/ (design 1, Release bundle and doctor).
Copies what the host needs at run time: host/ppe_host, host/migrations, host/config/settings.json, shared/ (constants, alert catalog, sounds), scripts/, the prebuilt dashboard (dashboard/dist -> dashboard/dist),
requirements.lock when it exists, and build_manifest.json (written fresh by tools/build_manifest.py). Never copies tests, node_modules, data, backups, logs, exports or any secrets.json.
NOT included: the pinned embedded Python 3.12 runtime and the launcher .bat of the design; they are added by hand when the release is made for the second PC (the runtime cannot be fetched by this script).
Refuses to run when dashboard/dist/index.html is missing (run `just build` first) and removes an older dist/release first."""
import argparse, shutil, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent)); import build_manifest as BM

ROOT = BM.ROOT
COPY = (('host/ppe_host', 'host/ppe_host'), ('host/migrations', 'host/migrations'), ('host/config', 'host/config'), ('shared', 'shared'), ('scripts', 'scripts'), ('dashboard/dist', 'dashboard/dist'))
OPTIONAL_FILES = ('requirements.lock', 'pyproject.toml')
IGNORE = shutil.ignore_patterns('__pycache__', '*.pyc', 'secrets.json', 'settings.local.json', '*.db', '*.db-wal', '*.db-shm', 'vectors')

def package(root=ROOT, out=None, env=None):
    root = Path(root); out = Path(out) if out else root / 'dist' / 'release'
    if not (root / 'dashboard' / 'dist' / 'index.html').is_file(): raise BM.ManifestError('dashboard/dist/index.html is missing: run `just build` first')
    if out.exists(): shutil.rmtree(out)
    out.mkdir(parents=True)
    for src, dst in COPY:
        if (root / src).is_dir(): shutil.copytree(root / src, out / dst, ignore=IGNORE)
    for f in OPTIONAL_FILES:
        if (root / f).is_file(): shutil.copyfile(root / f, out / f)
    import json
    m = BM.build(root, env); (out / 'build_manifest.json').write_bytes((json.dumps(m, indent=2) + '\n').encode('utf-8')); return out, m

def main(argv=None):
    ap = argparse.ArgumentParser(prog='package_release'); ap.add_argument('--out'); a = ap.parse_args(argv)
    try: out, m = package(out=a.out)
    except (BM.ManifestError, OSError) as e: print('package: %s' % e, file=sys.stderr); return 2
    files = sum(1 for p in out.rglob('*') if p.is_file()); print('package: %s (%d files, %s); the embedded Python runtime and the launcher are added by hand' % (out, files, m['rev_tag'])); return 0

if __name__ == '__main__': sys.exit(main())
