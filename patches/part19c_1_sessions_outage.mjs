// patches/part19c_1_sessions_outage.mjs  (run from repo root: node patches/part19c_1_sessions_outage.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  append('host/ppe_host/api/api_rest.py', String.raw`# ---- P19c-1: GET /api/sessions and POST /api/dashboard-outage (design 3.8, 3.10) ----
# Both read the clock through _now_ms (tests replace it; the api layer may read the clock, core/ may not). Neither needs a new Port method: the sessions list is a
# read-only query in a worker thread (like GET /api/events, no audit row), and the outage route only validates and writes one audit row through port.audit.
import time as _time
_now_ms = lambda: int(_time.time() * 1000)
SESSIONS_SQL = ("SELECT s.session_id, s.started_ts, s.ended_ts, s.mode, s.session_label, s.end_kind, "
                "(SELECT COUNT(*) FROM alerts a WHERE a.session_id = s.session_id), "
                "(SELECT COUNT(*) FROM episodes e WHERE e.session_id = s.session_id AND e.state != 'RESOLVED') "
                "FROM sessions s ORDER BY s.session_id DESC LIMIT ?")
HIGHEST_SQL = ("SELECT session_id, node_id, MAX(CASE level WHEN 'DANGER' THEN 2 WHEN 'WARNING' THEN 1 ELSE 0 END) AS rank FROM alerts "
               "WHERE session_id IN (%s) AND node_id IS NOT NULL GROUP BY session_id, node_id HAVING rank > 0")
LEVEL_OF_RANK = {1: 'WARNING', 2: 'DANGER'}
def query_sessions(db_path, limit, now_ms):
    """Runs in a worker thread, newest session first. It reads sessions, alerts and episodes only, never the frames table, so it stays fast on a 24 h database."""
    c = connect_db(db_path, readonly=True)
    try:
        c.execute('BEGIN')  # one snapshot for both statements
        rows = c.execute(SESSIONS_SQL, (limit,)).fetchall()
        top = {}
        if rows:
            for sid, node, rank in c.execute(HIGHEST_SQL % ','.join('?' * len(rows)), [r[0] for r in rows]): top.setdefault(sid, {})[str(node)] = LEVEL_OF_RANK[rank]
    finally: c.close()
    return [M.SessionListRow(session_id=sid, started_ts=st, ended_ts=en, duration_s=max(0, ((en if en is not None else now_ms) - st) / 1000), mode=mode, session_label=label,
                             end_kind=kind, alert_count=na, unresolved_episodes=ne, highest_level_by_node=top.get(sid, {})) for sid, st, en, mode, label, kind, na, ne in rows]

@router.get('/sessions', response_model=list[M.SessionListRow])
async def sessions(request: Request, limit: int = Query(50, ge=1, le=500), op: Operator = Depends(current_operator)):
    return await run_in_threadpool(query_sessions, request.app.state.db_path, limit, _now_ms())  # read-only, no audit row

OUTAGE_MAX_S, OUTAGE_TOLERANCE_MS = 86400, 1000  # design 3.8: at most 86400 s, duration_s within 1 s of the difference
@router.post('/dashboard-outage', response_model=M.OutageResp)
async def dashboard_outage(body: M.OutageReq, request: Request, op: Operator = Depends(current_operator)):
    port, now = request.app.state.port, _now_ms()
    def bad(why): raise ApiError(422, 'VALIDATION_ERROR', why)  # a refused report writes no audit row (ADR 0010)
    if body.ended_ts < body.started_ts: bad('ended_ts is before started_ts')
    if body.started_ts > now or body.ended_ts > now: bad('started_ts and ended_ts must not be in the future')
    if body.duration_s > OUTAGE_MAX_S: bad('duration_s is over %d' % OUTAGE_MAX_S)
    if abs(body.duration_s * 1000 - (body.ended_ts - body.started_ts)) > OUTAGE_TOLERANCE_MS: bad('duration_s differs from ended_ts - started_ts by more than 1 s')
    port.audit('DASHBOARD_OUTAGE', operator_id=op.operator_id, reason='started_ts %d ended_ts %d duration_s %g' % (body.started_ts, body.ended_ts, body.duration_s))
    return M.OutageResp(logged=True)
`);
  append('host/ppe_host/api/models.py', String.raw`# ---- REST bodies (P19c-1): GET /api/sessions and POST /api/dashboard-outage (design 3.8) ----
class SessionListRow(_Strict):  # one row of GET /api/sessions; highest_level_by_node maps a node id (as a string) to WARNING or DANGER, a node with no alert above a notice is absent
    session_id: int
    started_ts: int
    ended_ts: Optional[int]
    duration_s: float
    mode: SessionMode
    session_label: Optional[str]
    end_kind: Optional[Literal['ENDED', 'CLEAN_SHUTDOWN', 'ABANDONED']]
    alert_count: int
    unresolved_episodes: int
    highest_level_by_node: dict[str, Literal['WARNING', 'DANGER']]
class OutageReq(_Strict):  # times are UTC milliseconds like every stored timestamp, duration_s is seconds
    started_ts: int
    ended_ts: int
    duration_s: float = Field(allow_inf_nan=False)
class OutageResp(_Strict):
    logged: Literal[True]
`);
  put('host/tests/test_api_sessions_outage.py', String.raw`"""P19c-1: GET /api/sessions and POST /api/dashboard-outage (design 3.8). The host is a fake Port, the database is a real migrated file.
Route level only: the liveness-stamp check of the design needs the running host (P24); here the query runs off the event loop and stays under 500 ms on a large frames table."""
import pathlib, threading, time
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
from ppe_host.io.db_writer import connect_db, run_migrations
MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
GOOD = {'Authorization': 'Bearer good-token'}
NOW = 10_090_000          # ms; the open session started at 10_000_000
class FakePort:
    def __init__(self): self.audits, self.calls = [], []
    def authenticate(self, token): return R.Operator(1, 'Ana') if token == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, node_id, episode_id, reason))
    def session_id(self): return 2
    def login_failed(self): return None
    def login_ok(self): pass
@pytest.fixture
def rig(tmp_path, monkeypatch):
    monkeypatch.setattr(R, '_now_ms', lambda: NOW)
    db = tmp_path / 't.db'; c = connect_db(db); run_migrations(c, str(MIG), 1000)
    c.execute("INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (1, 'Ana', 'h', 0, 0)")
    c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03')])
    c.execute("INSERT INTO sessions(session_id, started_ts, ended_ts, mode, host_build, constants_hash, settings_hash, session_label, end_kind) VALUES (1, 1000000, 4600000, 'LIVE', 'b', 'c', 's', 'night', 'ENDED')")
    c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (2, 10000000, 'LIVE', 'b', 'c', 's')")
    port = FakePort(); return TestClient(R.create_app(port, db), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port, c
def alert(c, sid, seq, node, typ, level):
    c.execute('INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts, cleared_ts) VALUES (?, ?, ?, ?, ?, ?, ?)', (seq, sid, node, typ, level, seq, seq))
def episode(c, sid, node, kind, state):
    extra = ", resolved_ts, resolve_reason, resolved_by) VALUES (?, ?, ?, 1, ?, 9, 'rescued', 1)" if state == 'RESOLVED' else ') VALUES (?, ?, ?, 1, ?)'
    c.execute('INSERT INTO episodes(session_id, node_id, kind, opened_ts, state' + extra, (sid, node, kind, state))
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b
def get(client, qs='', headers=GOOD): return client.get('/api/sessions' + qs, headers=headers)
def outage(client, started, ended, dur, headers=GOOD): return client.post('/api/dashboard-outage', json={'started_ts': started, 'ended_ts': ended, 'duration_s': dur}, headers=headers)

def test_both_routes_are_registered_beside_the_earlier_ones():
    paths = {(m, r.path) for r in R.router.routes for m in r.methods}
    assert {('GET', '/api/sessions'), ('POST', '/api/dashboard-outage')} <= paths
def test_both_routes_need_a_token_and_reach_nothing_without_one(rig):
    client, port, _ = rig
    for h in ({}, {'Authorization': 'Bearer wrong'}):
        r = get(client, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
        r = outage(client, 1, 1, 0, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
    assert {a[0] for a in port.audits} == {'LOGIN_REJECTED'}

def test_sessions_rows_are_newest_first_with_the_ten_fields(rig):
    client, port, c = rig; r = get(client); b = r.json()
    assert r.status_code == 200 and [x['session_id'] for x in b] == [2, 1] and all(set(x) == set(M.SessionListRow.model_fields) and len(x) == 10 for x in b)
    assert b[1] == {'session_id': 1, 'started_ts': 1000000, 'ended_ts': 4600000, 'duration_s': 3600.0, 'mode': 'LIVE', 'session_label': 'night', 'end_kind': 'ENDED',
                    'alert_count': 0, 'unresolved_episodes': 0, 'highest_level_by_node': {}}
    assert b[0]['ended_ts'] is None and b[0]['end_kind'] is None and b[0]['session_label'] is None and b[0]['duration_s'] == 90.0     # an open session runs to now
def test_sessions_alert_count_unresolved_episodes_and_highest_level_by_node(rig):
    client, port, c = rig
    for seq, node, typ, lv in [(1, 1, 'co_threshold', 'WARNING'), (2, 1, 'man_down', 'DANGER'), (3, 2, 'heat', 'WARNING'), (4, 3, 'wrist_open', 'NONE'), (5, None, 'suspect_frame', 'NONE')]: alert(c, 1, seq, node, typ, lv)
    alert(c, 2, 1, 1, 'battery_low', 'WARNING')
    episode(c, 1, 1, 'MAN_DOWN', 'RESOLVED'); episode(c, 1, 2, 'MAYDAY', 'OPEN'); episode(c, 1, 3, 'MAN_DOWN', 'ACKNOWLEDGED')
    one, two = sorted(get(client).json(), key=lambda x: x['session_id'])
    assert one['alert_count'] == 5 and one['unresolved_episodes'] == 2 and one['highest_level_by_node'] == {'1': 'DANGER', '2': 'WARNING'}      # NONE-only node 3 and the node-less notice are left out
    assert two['alert_count'] == 1 and two['unresolved_episodes'] == 0 and two['highest_level_by_node'] == {'1': 'WARNING'}
def test_sessions_limit_default_and_range(rig):
    client, port, c = rig
    assert [x['session_id'] for x in get(client, '?limit=1').json()] == [2] and len(get(client).json()) == 2
    for qs in ('?limit=0', '?limit=501', '?limit=x'): r = get(client, qs); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR'
def test_sessions_of_an_empty_database_is_an_empty_list(rig):
    client, port, c = rig; c.execute('DELETE FROM sessions'); assert get(client).json() == []
def test_sessions_read_writes_no_audit_row_and_runs_off_the_event_loop(rig, monkeypatch):
    client, port, c = rig; seen = {}; real = R.query_sessions
    def spy(*a): seen['t'] = threading.get_ident(); return real(*a)
    monkeypatch.setattr(R, 'query_sessions', spy); main = threading.get_ident()
    assert get(client).status_code == 200 and seen['t'] != main and port.audits == []
def test_sessions_query_never_touches_the_frames_table_and_is_fast_on_a_large_database(rig):
    client, port, c = rig
    plan = ' | '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN ' + R.SESSIONS_SQL, (50,)).fetchall()) + ' | ' + ' | '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN ' + R.HIGHEST_SQL % '?,?', (1, 2)).fetchall())
    assert 'frames' not in plan.lower(), plan
    c.execute('BEGIN'); c.executemany("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, 1, 1, ?, ?, 'OK', 'OK', 'fresh', '00', 0)", [(i, i, i) for i in range(1, 30001)]); c.execute('COMMIT')
    t = time.monotonic(); r = get(client); assert r.status_code == 200 and time.monotonic() - t < 0.5      # route level; the liveness stamp itself is P24

def test_outage_is_logged_with_one_audit_row(rig):
    client, port, c = rig; r = outage(client, NOW - 30_000, NOW - 10_000, 20.0)
    assert r.status_code == 200 and r.json() == {'logged': True} and port.audits == [('DASHBOARD_OUTAGE', 1, None, None, 'started_ts %d ended_ts %d duration_s 20' % (NOW - 30_000, NOW - 10_000))]
@pytest.mark.parametrize('started,ended,dur', [
    (NOW - 1000, NOW - 2000, 1.0),            # ended before started
    (NOW - 5000, NOW + 1, 5.0),               # ended in the future
    (NOW + 1, NOW + 1, 0.0),                  # both in the future
    (NOW - 20_000, NOW - 10_000, 11.001),     # duration 1.001 s too long
    (NOW - 20_000, NOW - 10_000, 8.999),      # duration 1.001 s too short
    (0, 86_401_000, 86_401.0),                # consistent but over 86400 s
    (NOW - 20_000, NOW - 10_000, 86_401.0)])  # over 86400 s and inconsistent
def test_outage_rules_give_422_validation_error_and_no_audit_row(rig, started, ended, dur):
    client, port, c = rig; r = outage(client, started, ended, dur)
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.audits == []
@pytest.mark.parametrize('started,ended,dur', [
    (NOW - 20_000, NOW - 10_000, 11.0),       # exactly 1 s long
    (NOW - 20_000, NOW - 10_000, 9.0),        # exactly 1 s short
    (NOW - 5000, NOW, 5.0),                   # ended exactly now
    (NOW, NOW, 0.0),                          # zero length
    (NOW - 86_400_000, NOW, 86_400.0),        # exactly 86400 s
    (NOW - 100, NOW - 100, 0.4)])             # tiny duration within the 1 s tolerance
def test_outage_boundaries_are_accepted(rig, started, ended, dur):
    client, port, c = rig; assert outage(client, started, ended, dur).status_code == 200 and [a[0] for a in port.audits] == ['DASHBOARD_OUTAGE']
@pytest.mark.parametrize('body', [{}, {'started_ts': 1, 'ended_ts': 2}, {'started_ts': 'a', 'ended_ts': 2, 'duration_s': 1}, {'started_ts': 1, 'ended_ts': 2, 'duration_s': 'x'}, {'started_ts': 1, 'ended_ts': 2, 'duration_s': 0.001, 'extra': 1}])
def test_outage_body_that_fails_the_schema_is_422_and_logs_nothing(rig, body):
    client, port, c = rig; r = client.post('/api/dashboard-outage', json=body, headers=GOOD)
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.audits == []
def test_outage_with_a_nan_duration_is_422(rig):
    client, port, c = rig; r = client.post('/api/dashboard-outage', content=b'{"started_ts": 1, "ended_ts": 1, "duration_s": NaN}', headers={**GOOD, 'Content-Type': 'application/json'})
    assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.audits == []
`);
  putB64('docs/adr/0010.md', 'IyBBRFIgMDAxMDogc2Vzc2lvbnMgbGlzdCBhbmQgZGFzaGJvYXJkIG91dGFnZSByZXBvcnQgKFAxOWMtMSkKClN0YXR1czogUHJvcG9zZWQgKGRlY2lkZWQgaW4gdGhlIFAxOWMtMSBzZXNzaW9uOyBjb25maXJtIGF0IHRoZSBuZXh0IGRlc2lnbiByZXZpZXcpLgpEZXNpZ246IFJldiAzLjQ1IGlzIGZyb3plbi4gTm90aGluZyBpbiB0aGUgZnJhbWUsIHRoZSBtaWdyYXRpb24gb3IgYGNvbnN0YW50cy5qc29uYCBjaGFuZ2VzLgoKLSAqKk5vIG5ldyBQb3J0IG1ldGhvZC4qKiBgR0VUIC9hcGkvc2Vzc2lvbnNgIGlzIGEgcmVhZC1vbmx5IHF1ZXJ5IGluIGEgd29ya2VyIHRocmVhZCwgbGlrZSBgR0VUIC9hcGkvZXZlbnRzYCAobm8gYXVkaXQgcm93KS4gYFBPU1QgL2FwaS9kYXNoYm9hcmQtb3V0YWdlYCB2YWxpZGF0ZXMgYW5kIGNhbGxzIGBwb3J0LmF1ZGl0KCdEQVNIQk9BUkRfT1VUQUdFJywgLi4uKWAuIEJvdGggcmVhZCB0aGUgY2xvY2sgdGhyb3VnaCBgYXBpX3Jlc3QuX25vd19tc2AsIHdoaWNoIHRlc3RzIHJlcGxhY2UuCi0gKipTZXNzaW9uIHJvdyAoMy44IGxpc3RzIHRoZSBmaWVsZHMsIG5vdCB0aGVpciBtZWFuaW5nKToqKiBgYWxlcnRfY291bnRgIGNvdW50cyBldmVyeSBgYWxlcnRzYCByb3cgb2YgdGhlIHNlc3Npb24sIG5vdGljZXMgaW5jbHVkZWQuIGB1bnJlc29sdmVkX2VwaXNvZGVzYCBjb3VudHMgZXBpc29kZXMgb2YgdGhhdCBzZXNzaW9uIHdob3NlIHN0YXRlIGlzIG5vdCBSRVNPTFZFRCwgc28gYW4gZXBpc29kZSBjYXJyaWVkIG92ZXIgYnkgRW5kIHNoaWZ0IHN0aWxsIGNvdW50cyBhZ2FpbnN0IHRoZSBzZXNzaW9uIHRoYXQgb3BlbmVkIGl0LiBgZHVyYXRpb25fc2AgaXMgYChlbmRlZF90cyAtIHN0YXJ0ZWRfdHMpIC8gMTAwMGAsIGFuZCBmb3IgdGhlIG9wZW4gc2Vzc2lvbiBpdCBydW5zIHRvIG5vdy4gUm93cyBhcmUgbmV3ZXN0IGZpcnN0LiBgbGltaXRgIGRlZmF1bHRzIHRvIDUwIGFuZCBpcyAxIHRvIDUwMCAoMy44IGdpdmVzIG9ubHkgdGhlIGRlZmF1bHQ7IHRoZSB1cHBlciBib3VuZCBpcyBhIHByb3Bvc2FsKS4KLSAqKmBoaWdoZXN0X2xldmVsX2J5X25vZGVgOioqIGEgbWFwIGZyb20gbm9kZSBpZCAoYSBzdHJpbmcsIGFzIEpTT04ga2V5cyBhcmUpIHRvIGBXQVJOSU5HYCBvciBgREFOR0VSYCwgdGFrZW4gZnJvbSB0aGUgYGFsZXJ0c2Agcm93cyBvZiB0aGUgc2Vzc2lvbi4gQSBub2RlIHdob3NlIGFsZXJ0cyBhcmUgYWxsIGxldmVsIE5PTkUgKG5vdGljZXMpLCBhbmQgYW4gYWxlcnQgd2l0aCBubyBub2RlLCBhcmUgbGVmdCBvdXQ7IHRoZSBkYXNoYm9hcmQgcmVhZHMgYW4gYWJzZW50IG5vZGUgYXMgTk9STUFMLiBGcmFtZXMgYXJlIG5vdCBzY2FubmVkLCBiZWNhdXNlIHRoYXQgd291bGQgbWFrZSB0aGUgY2FsbCBzbG93IG9uIGEgMjQgaCBkYXRhYmFzZSAodGhlIGRlc2lnbiBhc2tzIGZvciB1bmRlciA1MDAgbXMgb2YgbGl2ZW5lc3MgbW92ZW1lbnQpLgotICoqT3V0YWdlIHRpbWVzIGFyZSBVVEMgbWlsbGlzZWNvbmRzLCoqIGxpa2UgZXZlcnkgc3RvcmVkIHRpbWVzdGFtcCwgYW5kIGBkdXJhdGlvbl9zYCBpcyBzZWNvbmRzLCBzbyB0aGUgMSBzIHRvbGVyYW5jZSBpcyAxMDAwIG1zLiBQMjJjIG11c3Qgc2VuZCBgRGF0ZS5ub3coKWAgdmFsdWVzLiBJZiB0aGUgZGFzaGJvYXJkIHdlcmUgdG8gc2VuZCBzZWNvbmRzIHRoZSBjaGVjayB3b3VsZCByZWZ1c2UgZXZlcnkgcmVwb3J0IHdpdGggNDIyLCB3aGljaCBpcyBsb3VkIHJhdGhlciB0aGFuIHNpbGVudC4KLSAqKkNoZWNrIG9yZGVyIGFuZCBhdWRpdDoqKiB0aGUgZm91ciBydWxlcyBvZiAzLjggYWxsIGdpdmUgNDIyIGBWQUxJREFUSU9OX0VSUk9SYC4gQSByZWZ1c2VkIHJlcG9ydCB3cml0ZXMgbm8gYXVkaXQgcm93IChgYXVkaXRfYWN0aW9uc2AgaGFzIG5vIHJlamVjdGlvbiBhY3Rpb24gZm9yIGl0LCBhcyBpbiBBRFIgMDAwNykuIGBkdXJhdGlvbl9zYCBtYXkgbm90IGJlIE5hTiBvciBpbmZpbml0ZS4gVGhlIGBEQVNIQk9BUkRfT1VUQUdFYCByb3cgY2FycmllcyBgc3RhcnRlZF90c2AsIGBlbmRlZF90c2AgYW5kIGBkdXJhdGlvbl9zYCBpbiBgcmVhc29uYCwgYmVjYXVzZSBgYXVkaXRfZXZlbnRzYCBoYXMgbm8gY29sdW1ucyBmb3IgdGhlbS4KLSAqKkxlZnQgZm9yIFAyNDoqKiB0aGUgIm1vdmVzIG5vIGxpdmVuZXNzIHN0YW1wIGJ5IG1vcmUgdGhhbiA1MDAgbXMiIGNoZWNrIG5lZWRzIHRoZSBydW5uaW5nIGhvc3QuIFRoZSByb3V0ZS1sZXZlbCB0ZXN0IGhlcmUgb25seSBzaG93cyB0aGF0IHRoZSBxdWVyeSBydW5zIG9mZiB0aGUgZXZlbnQgbG9vcCwgbmV2ZXIgdG91Y2hlcyBgZnJhbWVzYCAocXVlcnkgcGxhbikgYW5kIHRha2VzIHVuZGVyIDUwMCBtcyBvbiAzMCwwMDAgZnJhbWUgcm93cy4K');
  append('docs/PROGRESS.md', '- Part 19c-1 done: api_rest.py gains GET /api/sessions (newest first, limit 1 to 500 default 50, alert_count, unresolved_episodes, highest_level_by_node from alerts, read-only worker thread, no frames scan, no audit row) and POST /api/dashboard-outage (422 VALIDATION_ERROR rules of 3.8, DASHBOARD_OUTAGE audit row, times in UTC ms), no new Port method; models SessionListRow, OutageReq, OutageResp, host/tests/test_api_sessions_outage.py (28 tests), docs/adr/0010.md; scba-correction, system-banners ack and the table-driven endpoint test are P19c-2');
}
