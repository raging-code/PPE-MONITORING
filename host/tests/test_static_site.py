"""P24-6 (ADR 0055): the host serves the built dashboard. The ASGI app is driven directly (headers, types, HEAD, the 404 list, a symlink out of dist, hostile paths) and then through the real FastAPI app of the API (routes before the mount win, the origin check still applies, a socket path is not shadowed).
Requirements: REQ-SEC-001"""
import asyncio, json, os
import pytest
from ppe_host.api import static_site as S

def arun(c): return asyncio.run(c)

@pytest.fixture
def dist(tmp_path):
    d = tmp_path / 'dist'; (d / 'assets').mkdir(parents=True)
    (d / 'index.html').write_text('<h1>hi</h1>'); (d / '.gitkeep').write_text('')
    (d / 'assets' / 'app.js').write_text('export{}'); (d / 'assets' / 'app.css').write_text('a{}'); (d / 'assets' / 'f.woff2').write_bytes(b'\x00\x01\x02'); (d / 'assets' / 'x.weird').write_bytes(b'z')
    (d / 'assets' / 'UP.JS').write_text('1'); (d / 'api').mkdir(); (d / 'api' / 'x.js').write_text('1'); (d / 'ws').mkdir(); (d / 'ws' / 'x.js').write_text('1')
    return d

def call(app, path, method='GET', typ='http'):
    sent = []
    async def rcv(): return {}
    async def snd(m): sent.append(m)
    arun(app({'type': typ, 'method': method, 'path': path, 'headers': []}, rcv, snd)); return sent

def reply(app, path, method='GET'):
    s = call(app, path, method); h = {k.decode(): v.decode() for k, v in s[0]['headers']}; return s[0]['status'], h, s[1]['body']

def app_of(dist, port=8420): return S.DashboardFiles(dist, port)

def test_root_is_index_html_and_headers_carry_the_design_policy(dist):
    st, h, b = reply(app_of(dist), '/')
    assert st == 200 and b == b'<h1>hi</h1>' and h['content-type'] == 'text/html; charset=utf-8' and h['cache-control'] == 'no-store' and int(h['content-length']) == len(b)
    assert h['content-security-policy'] == "default-src 'self'; connect-src 'self' ws://localhost:8420 ws://127.0.0.1:8420; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    assert h['x-content-type-options'] == 'nosniff' and h['referrer-policy'] == 'no-referrer'

def test_index_html_by_name_is_also_not_cached(dist): assert reply(app_of(dist), '/index.html')[1]['cache-control'] == 'no-store'

def test_policy_follows_the_configured_port(dist):
    h = reply(app_of(dist, 9001), '/')[1]['content-security-policy']; assert 'ws://localhost:9001 ws://127.0.0.1:9001' in h and '8420' not in h

@pytest.mark.parametrize('path, ctype', [('/assets/app.js', 'text/javascript; charset=utf-8'), ('/assets/app.css', 'text/css; charset=utf-8'), ('/assets/f.woff2', 'font/woff2'), ('/assets/UP.JS', 'text/javascript; charset=utf-8'), ('/assets/x.weird', 'application/octet-stream')])
def test_content_type_comes_from_the_fixed_table(dist, path, ctype):
    st, h, _ = reply(app_of(dist), path); assert st == 200 and h['content-type'] == ctype and h['cache-control'] == 'no-cache'

def test_content_type_ignores_the_windows_registry(dist, monkeypatch):
    import mimetypes; monkeypatch.setattr(mimetypes, 'guess_type', lambda *a, **k: ('text/plain', None))
    assert reply(app_of(dist), '/assets/app.js')[1]['content-type'].startswith('text/javascript')

def test_bytes_are_served_unchanged(dist): assert reply(app_of(dist), '/assets/f.woff2')[2] == b'\x00\x01\x02'

def test_head_has_the_headers_of_get_and_no_body(dist):
    g = reply(app_of(dist), '/assets/app.js'); h = reply(app_of(dist), '/assets/app.js', 'HEAD')
    assert h[0] == 200 and h[2] == b'' and h[1] == g[1]

def envelope(r):
    st, h, b = r; j = json.loads(b); assert st == 404 and h['content-type'] == 'application/json' and int(h['content-length']) == len(b)
    assert j == {'error_code': 'NOT_FOUND', 'detail': 'Not Found', 'retry_after_s': None}; assert h['x-content-type-options'] == 'nosniff' and 'content-security-policy' in h

@pytest.mark.parametrize('path', ['/nope', '/assets', '/assets/', '/assets/missing.js', '/api', '/api/x.js', '/api/anything', '/ws', '/ws/tick', '/ws/x.js', '/.gitkeep', '/.env', '/assets/.hidden', '/..', '/../x', '/assets/../index.html', '/assets/./app.js',
                                  '/assets//app.js', '/assets\\app.js', '/assets/app.js:stream', '/C:/x', '/assets/app.js ', '/assets/app.js.', '/assets/a\nb', '/assets/a\x00b', 'index.html', ''])
def test_hostile_and_unknown_paths_are_the_404_envelope(dist, path): envelope(reply(app_of(dist), path))

@pytest.mark.parametrize('method', ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
def test_other_methods_are_404(dist, method): envelope(reply(app_of(dist), '/', method))

def test_a_symlink_out_of_dist_is_404(dist, tmp_path):
    out = tmp_path / 'secret.txt'; out.write_text('s')
    try: os.symlink(out, dist / 'assets' / 'link.txt')
    except (OSError, NotImplementedError): pytest.skip('no symlinks here')
    envelope(reply(app_of(dist), '/assets/link.txt'))

def test_a_symlink_inside_dist_is_served(dist):
    try: os.symlink(dist / 'assets' / 'app.css', dist / 'assets' / 'in.css')
    except (OSError, NotImplementedError): pytest.skip('no symlinks here')
    assert reply(app_of(dist), '/assets/in.css')[0] == 200

def test_a_file_added_after_start_up_is_served(tmp_path):
    d = tmp_path / 'late'; a = app_of(d); envelope(reply(a, '/')); d.mkdir(); (d / 'index.html').write_text('x'); assert reply(a, '/')[0] == 200

def test_websocket_scope_is_closed_not_served(dist):
    s = call(app_of(dist), '/ws', typ='websocket'); assert s == [{'type': 'websocket.close', 'code': 1008}]

def test_lifespan_scope_is_ignored(dist): assert call(app_of(dist), '/', typ='lifespan') == []

@pytest.mark.parametrize('p, segs', [('/', ['index.html']), ('/a/b.js', ['a', 'b.js']), ('/a', ['a']), ('/api', None), ('/api/x', None), ('/apix', ['apix']), ('/wsx', ['wsx']), ('/a/../b', None)])
def test_parse(p, segs): assert S.parse(p) == segs

def test_install_warns_once_when_dist_is_missing(tmp_path, caplog):
    from fastapi import FastAPI
    with caplog.at_level('WARNING', logger='ppe.static'): S.install_static(FastAPI(), tmp_path / 'none')
    assert len([r for r in caplog.records if r.name == 'ppe.static']) == 1

# ---- through the real API app ----
@pytest.fixture
def real(dist, tmp_path):
    from fastapi.testclient import TestClient
    from ppe_host.api import api_rest as R
    from ppe_host.io.db_writer import connect_db, run_migrations
    import pathlib
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(pathlib.Path(R.__file__).resolve().parents[2] / 'migrations'), 1000)
    class P:
        def __init__(self): self.audits = []
        def authenticate(self, t): return R.Operator(1, 'Ana') if t == 'good-token' else None
        def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append(action)
        def session_id(self): return 1
        def login_failed(self): return None
        def login_ok(self): pass
    p = P(); app = R.create_app(p, db); S.install_static(app, dist, 8420)
    return TestClient(app, base_url='http://127.0.0.1:8420', raise_server_exceptions=False), p

def test_real_app_serves_the_page_and_assets(real):
    c, _ = real; r = c.get('/'); assert r.status_code == 200 and r.text == '<h1>hi</h1>' and r.headers['content-type'].startswith('text/html'); assert c.get('/assets/app.js').status_code == 200

def test_real_app_api_routes_still_win_over_the_mount(real):
    c, p = real; r = c.post('/api/login', json={'token': 'good-token'}); assert r.status_code == 200 and r.json()['operator_id'] == 1 and 'LOGIN_OK' in p.audits
    assert c.get('/api/events').status_code == 401                              # the route answers (no token), not the mount

def test_real_app_unknown_api_path_is_the_envelope_from_the_mount(real):
    c, _ = real; r = c.get('/api/nothing'); assert r.status_code == 404 and r.json()['error_code'] == 'NOT_FOUND'

def test_real_app_origin_check_applies_to_static_files(real):
    c, p = real; r = c.get('/', headers={'Origin': 'http://evil.example'}); assert r.status_code == 403 and r.json()['error_code'] == 'ORIGIN_REJECTED' and 'ORIGIN_REJECTED' in p.audits
    assert c.get('/', headers={'Host': 'evil.example'}).status_code == 403

def test_real_app_same_origin_get_without_origin_header_passes(real): assert real[0].get('/assets/app.css').status_code == 200

def test_real_app_encoded_traversal_is_404(real):
    c, _ = real
    for p in ('/..%2f..%2fetc/passwd', '/%2e%2e/x', '/assets/%2e%2e/index.html', '/%2egitkeep'): assert c.get(p).status_code == 404

def test_real_app_post_to_a_file_is_404_not_405(real): assert real[0].post('/assets/app.js').status_code == 404

def test_real_app_websocket_path_without_a_socket_route_is_refused(real):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with real[0].websocket_connect('/ws'): pass

# ---- build_app: the mount is last and reads <PPE_HOME>/dashboard/dist ----
def test_build_app_mounts_the_dashboard_last_so_the_socket_routes_survive(tmp_path):
    from test_runtime import started
    from ppe_host import serve as SV
    st, rt = started(tmp_path, 'SIMULATOR'); rt.start(); d = st.settings.home / 'dashboard' / 'dist'; d.mkdir(parents=True); (d / 'index.html').write_text('<h1>b</h1>')
    async def go():
        app, _hub = SV.build_app(rt, asyncio.get_running_loop())
        assert app.routes[-1].name == 'dashboard' and any(getattr(r, 'path', '') == '/ws' for r in app.routes[:-1])
        assert isinstance(app.routes[-1].app, S.DashboardFiles) and app.routes[-1].app.root == d
    arun(go()); rt.stop(); st.close()
