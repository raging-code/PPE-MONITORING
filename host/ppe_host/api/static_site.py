"""api/static_site.py (P24-6, ADR 0055): the host serves the built dashboard (<PPE_HOME>/dashboard/dist) from the API origin, as design 1 says.
A plain ASGI app, mounted at '/' by serve.build_app after the API and socket routes, so those always win. GET and HEAD only. '/' is index.html. Every other case is the usual 404 NOT_FOUND envelope: a missing file, a directory,
a path under /api or /ws, a '..' or a dotfile (.gitkeep, .env), a name with a colon, a backslash, a control character or a trailing dot or space (Windows drops them), a symlink that leaves dist, and every other method.
The content type comes from a fixed table, not from the Windows registry (a registry that maps .js to text/plain makes the browser refuse the module). Every answer carries the Content-Security-Policy, X-Content-Type-Options and
Referrer-Policy of design 1; index.html is never cached, the other files are revalidated. A missing dist is one warning at start-up, not a stop: the API still runs, and a build made later is served without a restart."""
import asyncio, json, logging
from pathlib import Path

log = logging.getLogger('ppe.static')

TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
         '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
         '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json'}
NOT_SERVED = ('api', 'ws')                                                       # first path segments that belong to the API and the sockets

def csp(bind_port):
    """The design 1 policy, with the configured port."""
    return ("default-src 'self'; connect-src 'self' ws://localhost:%d ws://127.0.0.1:%d; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:" % (bind_port, bind_port))

def parse(path):
    """The path segments of a request path, or None when the path may not be served. '/' gives ['index.html']."""
    if path == '/': return ['index.html']
    if not path.startswith('/'): return None
    segs = path[1:].split('/')
    for s in segs:
        if s.startswith('.') or s == '' or s != s.rstrip('. ') or any(ord(c) < 32 for c in s) or ':' in s or '\\' in s: return None      # '.' and '..' are included in the dotfile rule
    return None if segs[0] in NOT_SERVED else segs

class DashboardFiles:
    def __init__(self, root, bind_port=8420):
        self.root, self.bind_port = Path(root), bind_port; self.csp = csp(bind_port)

    def find(self, path):
        """The file for a request path, or None. A symlink or any other way out of dist is None."""
        segs = parse(path)
        if segs is None: return None
        try:
            root = self.root.resolve(); f = root.joinpath(*segs).resolve()
            return f if f.is_relative_to(root) and f.is_file() else None
        except (OSError, ValueError): return None

    def headers(self, ctype, length, cache='no-cache'):
        return [(b'content-type', ctype.encode()), (b'content-length', str(length).encode()), (b'cache-control', cache.encode()), (b'content-security-policy', self.csp.encode()),
                (b'x-content-type-options', b'nosniff'), (b'referrer-policy', b'no-referrer')]

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'websocket': await send({'type': 'websocket.close', 'code': 1008}); return       # no socket lives here
        if scope['type'] != 'http': return
        head = scope['method'] == 'HEAD'
        f = self.find(scope['path']) if scope['method'] in ('GET', 'HEAD') else None
        if f is not None:
            try: body = await asyncio.to_thread(f.read_bytes)
            except OSError: f = None
        if f is None:
            from .models import ErrorEnvelope
            body = json.dumps(ErrorEnvelope(error_code='NOT_FOUND', detail='Not Found', retry_after_s=None).model_dump()).encode()
            await send({'type': 'http.response.start', 'status': 404, 'headers': self.headers('application/json', len(body), 'no-store')})
        else:
            ctype = TYPES.get(f.suffix.lower(), 'application/octet-stream')
            await send({'type': 'http.response.start', 'status': 200, 'headers': self.headers(ctype, len(body), 'no-store' if f.name == 'index.html' and f.parent == self.root.resolve() else 'no-cache')})
        await send({'type': 'http.response.body', 'body': b'' if head else body})

def install_static(app, root, bind_port=8420):
    """Mount the dashboard at '/'. Call it last: a mount at '/' answers every path the routes before it did not."""
    root = Path(root)
    if not (root / 'index.html').is_file(): log.warning('no prebuilt dashboard at %s (run just build): the API runs, the page will not load', root)
    app.mount('/', DashboardFiles(root, bind_port), name='dashboard')
