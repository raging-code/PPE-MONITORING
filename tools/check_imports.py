"""tools/check_imports.py (P27-2, ADR 0041): the import rule of design 14.5 (Rev 3.43), checked in CI.
host/ppe_host/core/ imports nothing from io/, services/ or api/ and does no file, serial, network or audio I/O. Every .py file under core/ is parsed (nothing is imported or run), including imports inside functions, and
the rule is broken by: an import that resolves to ppe_host.io, ppe_host.services or ppe_host.api (relative or absolute, `import x`, `from x import y` and `from .. import io`); an import of a module that does I/O (FORBIDDEN_MODULES:
files and paths, sockets and HTTP, serial, SQLite, processes, audio, importlib); a call of open(), input() or __import__(). Third-party maths and crypto (cryptography, hmac, dataclasses, typing) are fine.
Exit 0 when clean, 1 with one line per violation."""
import ast, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = 'ppe_host'
FORBIDDEN_PACKAGES = ('io', 'services', 'api')
FORBIDDEN_MODULES = ('os', 'io', 'pathlib', 'shutil', 'tempfile', 'glob', 'fileinput', 'socket', 'ssl', 'select', 'selectors', 'http', 'urllib', 'ftplib', 'smtplib', 'requests', 'httpx', 'websockets',
                     'serial', 'sqlite3', 'subprocess', 'multiprocessing', 'winsound', 'wave', 'sounddevice', 'pyaudio', 'ctypes', 'importlib', 'asyncio')
FORBIDDEN_CALLS = ('open', 'input', '__import__')

def _resolve(node, parts):
    """Absolute dotted names that an import statement refers to, given the package parts of the importing file (['ppe_host', 'core'])."""
    if isinstance(node, ast.Import): return [a.name for a in node.names]
    if node.level:
        base = parts[:len(parts) - (node.level - 1)] if node.level - 1 <= len(parts) else []
        mod = '.'.join(base + ([node.module] if node.module else []))
    else: mod = node.module or ''
    return [mod] + ['%s.%s' % (mod, a.name) for a in node.names if a.name != '*']       # `from .. import io` names ppe_host.io

def check_file(path, root=ROOT):
    path = Path(path); rel = path.relative_to(root); parts = list(rel.parts[:-1])
    if parts[:1] == ['host']: parts = parts[1:]                                         # host/ppe_host/core/x.py -> ppe_host.core
    out = []
    try: tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(rel))
    except SyntaxError as e: return ['%s:%s: cannot parse (%s)' % (rel.as_posix(), e.lineno, e.msg)]
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            for name in _resolve(n, parts):
                top = name.split('.')
                if top[0] == PACKAGE and len(top) > 1 and top[1] in FORBIDDEN_PACKAGES: out.append('%s:%d: core must not import %s (%s/ is outside core)' % (rel.as_posix(), n.lineno, name, top[1])); break
                if top[0] in FORBIDDEN_MODULES: out.append('%s:%d: core must not import %s (it does I/O)' % (rel.as_posix(), n.lineno, name)); break
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in FORBIDDEN_CALLS: out.append('%s:%d: core must not call %s()' % (rel.as_posix(), n.lineno, n.func.id))
    return out

def check(root=ROOT):
    """(violations, files checked). A missing core/ folder is itself a violation: the rule would pass by checking nothing."""
    core = Path(root) / 'host' / PACKAGE / 'core'
    if not core.is_dir(): return ['host/%s/core/ not found' % PACKAGE], 0
    files = sorted(p for p in core.rglob('*.py') if '__pycache__' not in p.parts); out = []
    for f in files: out += check_file(f, Path(root))
    return out, len(files)

def main(argv=None):
    bad, n = check()
    for line in bad: print('import rule: ' + line, file=sys.stderr)
    print('import rule: %s (%d files in host/ppe_host/core)' % ('FAILED, %d violation(s)' % len(bad) if bad else 'ok', n)); return 1 if bad else 0

if __name__ == '__main__': sys.exit(main())
