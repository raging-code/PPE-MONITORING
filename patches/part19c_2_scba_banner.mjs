// patches/part19c_2_scba_banner.mjs  (run from repo root: node patches/part19c_2_scba_banner.mjs [--dry] [--force])
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
  replace('host/ppe_host/api/api_rest.py', "    def resolve_episode(self, episode_id: int, reason: str, operator_id: int) -> Optional['EpisodeResolve']: ...  # ApiError STATE_CONFLICT when already RESOLVED\n\nclass ApiError(Exception):", "    def resolve_episode(self, episode_id: int, reason: str, operator_id: int) -> Optional['EpisodeResolve']: ...  # ApiError STATE_CONFLICT when already RESOLVED\n    # P19c-2\n    def set_scba_correction(self, node_id: int, note: Optional[str], operator_id: int) -> Optional['ScbaRecord']: ...  # live state only; None when node_id is not in the roster; the audit row is written by the route\n    def ack_banner(self, kind: str, operator_id: int) -> 'BannerAck': ...  # idempotent while the banner is active (first time kept); ApiError STATE_CONFLICT when it is not\n\nclass ApiError(Exception):");
  append('host/ppe_host/api/api_rest.py', String.raw`# ---- P19c-2: POST /api/scba-correction and POST /api/system-banners/{kind}/ack (design 3.8) ----
# The host owns the live state and every write (ADR 0011). SCBA correction is display state only: it is never an input of the rule engine, so it cannot clear
# scba_expired or suppress an ambient CO alert. The latest correction of each node is re-applied after a restart by io/db_writer.load_scba_corrections.
from typing import get_args as _get_args
class ScbaRecord(NamedTuple):
    recorded_ts: int
    operator: str
class BannerAck(NamedTuple):
    kind: str
    acknowledged_ts: int
BANNER_KINDS = ('no_live_data', 'base_offline', 'logging_fault', 'host_gap', 'recovering', 'host_power', 'audio_fault')  # the banners of alert_catalog.json (a test compares)

@router.post('/scba-correction', response_model=M.ScbaCorrection)
async def scba_correction(body: M.ScbaCorrectionReq, request: Request, op: Operator = Depends(current_operator)):
    port = request.app.state.port; r = port.set_scba_correction(body.node_id, body.note, op.operator_id)  # None for a node that is not in the roster
    if r is None: raise ApiError(404, 'NOT_FOUND', 'unknown node')
    port.audit('SCBA_CORRECTION', operator_id=op.operator_id, node_id=body.node_id, reason=body.note)
    return M.ScbaCorrection(recorded_ts=r.recorded_ts, operator=r.operator)

@router.post('/system-banners/{kind}/ack', response_model=M.BannerAckResp)
async def ack_banner(kind: str, request: Request, op: Operator = Depends(current_operator), body: Optional[M.EmptyReq] = None):
    if kind not in BANNER_KINDS: raise ApiError(404, 'NOT_FOUND', 'unknown banner kind')
    if kind not in _get_args(M.BannerKind): raise ApiError(400, 'BAD_REQUEST', 'this banner cannot be acknowledged')  # host_gap and logging_fault only
    port = request.app.state.port; r = port.ack_banner(kind, op.operator_id)  # idempotent while the banner is active; the port raises ApiError STATE_CONFLICT when it is not
    port.audit('BANNER_ACK', operator_id=op.operator_id, reason=kind)
    return M.BannerAckResp(kind=r.kind, acknowledged_ts=r.acknowledged_ts)
`);
  append('host/ppe_host/api/models.py', String.raw`# ---- REST bodies (P19c-2): SCBA correction and banner acknowledgement (design 3.8); the response of scba-correction is ScbaCorrection above ----
class ScbaCorrectionReq(_Strict):
    node_id: int
    note: Optional[str] = None
class BannerAckResp(_Strict):
    kind: BannerKind
    acknowledged_ts: int
`);
  append('host/ppe_host/io/db_writer.py', String.raw`
# ---- P19c-2: SCBA corrections re-applied from audit_events (design 2.10) ----
_FRAME_OK = "verify = 'OK' AND seq_class IN ('fresh', 'reboot')"   # a duplicate or suspect frame neither sets nor changes the SCBA state
_SCBA_BITS = '(((id_mode >> 3) & 1) * 2 + ((status3 >> 3) & 1))'    # id_mode bit 3 (SCBA ON) and status3 bit 3 (scba_expired)
def load_scba_corrections(conn):
    """{node_id: (recorded_ts, operator display name)}: the latest SCBA_CORRECTION of each node from any session, kept until a later verified frame of that node
    differs from the node's SCBA bits at the time of the correction (the last frame at or before it, or the first frame after it if there is none). Read-only."""
    out = {}
    for node, ts, name in conn.execute("SELECT a.node_id, a.ts, COALESCE(o.display_name, '') FROM audit_events a LEFT JOIN operators o ON o.operator_id = a.operator_id "
                                       "WHERE a.action = 'SCBA_CORRECTION' AND a.node_id IS NOT NULL AND a.audit_id = (SELECT MAX(b.audit_id) FROM audit_events b "
                                       "WHERE b.action = 'SCBA_CORRECTION' AND b.node_id = a.node_id)").fetchall():
        base = conn.execute('SELECT %s FROM frames WHERE node_id = ? AND rx_ts <= ? AND %s ORDER BY rx_ts DESC, frame_id DESC LIMIT 1' % (_SCBA_BITS, _FRAME_OK), (node, ts)).fetchone()
        if base is None: base = conn.execute('SELECT %s FROM frames WHERE node_id = ? AND rx_ts > ? AND %s ORDER BY rx_ts, frame_id LIMIT 1' % (_SCBA_BITS, _FRAME_OK), (node, ts)).fetchone()
        if base is not None and conn.execute('SELECT 1 FROM frames WHERE node_id = ? AND rx_ts > ? AND %s AND %s != ? LIMIT 1' % (_FRAME_OK, _SCBA_BITS), (node, ts, base[0])).fetchone(): continue
        out[node] = (ts, name)
    return out
`);
  put('host/tests/test_api_scba_banner.py', String.raw`"""P19c-2: POST /api/scba-correction and POST /api/system-banners/{kind}/ack (design 3.8, 8). The host is a fake Port. What the real port must do is in docs/adr/0011.md (P24)."""
import json, pathlib
import pytest
from fastapi.testclient import TestClient
from ppe_host.api import api_rest as R, models as M
GOOD = {'Authorization': 'Bearer good-token'}
CATALOG = json.loads((pathlib.Path(__file__).resolve().parents[2] / 'shared' / 'alert_catalog.json').read_text(encoding='utf8'))
class FakePort:
    def __init__(self): self.audits, self.calls, self.active, self.acked, self.roster = [], [], {'host_gap': True, 'logging_fault': True}, {}, {1, 2, 3}
    def authenticate(self, token): return R.Operator(1, 'Ana') if token == 'good-token' else None
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, node_id, episode_id, reason))
    def session_id(self): return 4
    def login_failed(self): return None
    def login_ok(self): pass
    def set_scba_correction(self, node_id, note, operator_id):
        self.calls.append(('scba', node_id)); return R.ScbaRecord(8000, 'Ana') if node_id in self.roster else None
    def ack_banner(self, kind, operator_id):
        self.calls.append(('banner', kind))
        if not self.active.get(kind): raise R.ApiError(409, 'STATE_CONFLICT', 'banner is not active')
        return R.BannerAck(kind, self.acked.setdefault(kind, 9000))      # a repeat keeps the first time
@pytest.fixture
def rig():
    port = FakePort(); return TestClient(R.create_app(port, 'unused.db'), base_url='http://127.0.0.1:8420', raise_server_exceptions=False), port
def envelope(r):
    b = r.json(); M.ErrorEnvelope(**b); assert set(b) == {'error_code', 'detail', 'retry_after_s'}; return b
def post(client, url, body=None, headers=GOOD): return client.post(url, json=body, headers=headers) if body is not None else client.post(url, headers=headers)

def test_both_routes_are_registered():
    paths = {(m, r.path) for r in R.router.routes for m in r.methods}
    assert {('POST', '/api/scba-correction'), ('POST', '/api/system-banners/{kind}/ack')} <= paths
@pytest.mark.parametrize('url,body', [('/api/scba-correction', {'node_id': 1}), ('/api/system-banners/host_gap/ack', {})])
def test_both_routes_need_a_token_and_reach_nothing_without_one(rig, url, body):
    client, port = rig
    for h in ({}, {'Authorization': 'Bearer wrong'}): r = client.post(url, json=body, headers=h); assert r.status_code == 401 and envelope(r)['error_code'] == 'UNAUTHENTICATED'
    assert port.calls == [] and {a[0] for a in port.audits} == {'LOGIN_REJECTED'}

def test_scba_correction_returns_time_and_operator_and_logs_one_audit_row_with_the_note(rig):
    client, port = rig; r = post(client, '/api/scba-correction', {'node_id': 2, 'note': 'wearer removed the set'})
    assert r.status_code == 200 and r.json() == {'recorded_ts': 8000, 'operator': 'Ana'} and port.audits == [('SCBA_CORRECTION', 1, 2, None, 'wearer removed the set')]
def test_scba_correction_note_is_optional_and_a_repeat_is_a_new_correction(rig):
    client, port = rig; assert post(client, '/api/scba-correction', {'node_id': 1}).status_code == 200 and post(client, '/api/scba-correction', {'node_id': 1}).status_code == 200
    assert port.audits == [('SCBA_CORRECTION', 1, 1, None, None)] * 2
@pytest.mark.parametrize('node', [0, 4, -1, 99])
def test_scba_correction_for_a_node_outside_the_roster_is_404_and_logs_nothing(rig, node):
    client, port = rig; r = post(client, '/api/scba-correction', {'node_id': node}); assert r.status_code == 404 and envelope(r)['error_code'] == 'NOT_FOUND' and port.audits == []
@pytest.mark.parametrize('body', [{}, {'note': 'x'}, {'node_id': 'one'}, {'node_id': 1, 'note': 5}, {'node_id': 1, 'extra': 1}])
def test_scba_correction_body_that_fails_the_schema_is_422_and_reaches_nothing(rig, body):
    client, port = rig; r = post(client, '/api/scba-correction', body); assert r.status_code == 422 and envelope(r)['error_code'] == 'VALIDATION_ERROR' and port.calls == [] and port.audits == []

@pytest.mark.parametrize('kind', ['host_gap', 'logging_fault'])
def test_banner_ack_on_the_two_allowed_kinds_is_200_and_logs_banner_ack(rig, kind):
    client, port = rig; r = post(client, '/api/system-banners/%s/ack' % kind, {})
    assert r.status_code == 200 and r.json() == {'kind': kind, 'acknowledged_ts': 9000} and port.audits == [('BANNER_ACK', 1, None, None, kind)]
def test_banner_ack_accepts_no_body_and_a_repeat_returns_the_first_time(rig):
    client, port = rig; a = post(client, '/api/system-banners/host_gap/ack'); port.acked['host_gap'] = 9000; b = post(client, '/api/system-banners/host_gap/ack', {})
    assert a.status_code == b.status_code == 200 and a.json() == b.json()
@pytest.mark.parametrize('kind', ['no_live_data', 'base_offline', 'recovering', 'host_power', 'audio_fault'])
def test_a_known_banner_that_cannot_be_acknowledged_is_400_and_reaches_nothing(rig, kind):
    client, port = rig; r = post(client, '/api/system-banners/%s/ack' % kind, {}); assert r.status_code == 400 and envelope(r)['error_code'] == 'BAD_REQUEST' and port.calls == [] and port.audits == []
@pytest.mark.parametrize('kind', ['nope', 'HOST_GAP', 'host-gap', 'co_threshold'])
def test_an_unknown_banner_kind_is_404(rig, kind):
    client, port = rig; r = post(client, '/api/system-banners/%s/ack' % kind, {}); assert r.status_code == 404 and envelope(r)['error_code'] == 'NOT_FOUND' and port.calls == [] and port.audits == []
def test_banner_ack_of_a_banner_that_is_not_active_is_409_state_conflict_and_logs_nothing(rig):
    client, port = rig; port.active['logging_fault'] = False; r = post(client, '/api/system-banners/logging_fault/ack', {})
    assert r.status_code == 409 and envelope(r)['error_code'] == 'STATE_CONFLICT' and port.audits == []
def test_banner_ack_with_a_body_that_is_not_empty_is_422(rig):
    client, port = rig; r = post(client, '/api/system-banners/host_gap/ack', {'x': 1}); assert r.status_code == 422 and port.calls == []
def test_banner_kinds_match_alert_catalog_and_the_allowlist_is_host_gap_and_logging_fault():
    assert set(R.BANNER_KINDS) == {e['type'] for e in CATALOG if e['owner'] == 'system_banner'} and len(R.BANNER_KINDS) == 7
    assert set(R._get_args(M.BannerKind)) == {'host_gap', 'logging_fault'}
`);
  put('host/tests/test_scba_replay.py', String.raw`"""P19c-2: the latest SCBA correction of each node is re-applied from audit_events after a restart (design 2.10, 8 "SCBA_CORRECTION replay test"). Real migrated database."""
import pathlib
import pytest
from ppe_host.io.db_writer import connect_db, load_scba_corrections, run_migrations
MIG = pathlib.Path(__file__).resolve().parents[1] / 'migrations'
class Db:
    def __init__(self, path):
        self.path, self.c, self.seq = path, connect_db(path), 0
        run_migrations(self.c, str(MIG), 1000)
        self.c.executemany('INSERT INTO operators(operator_id, display_name, token_hash, created_ts, token_issued_ts) VALUES (?, ?, \'h\', 0, 0)', [(1, 'Ana'), (2, 'Ben')])
        self.c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02'), (3, 'FF-03')])
        self.session(1)
    def session(self, sid):
        if sid > 1: self.c.execute("UPDATE sessions SET ended_ts = 1, end_kind = 'ENDED' WHERE ended_ts IS NULL")
        self.c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (?, 0, 'LIVE', 'b', 'c', 's')", (sid,)); self.sid = sid
    def frame(self, node, ts, scba=0, expired=0, verify='OK', seq_class='fresh'):
        self.seq += 1
        self.c.execute("INSERT INTO frames(event_seq, session_id, node_id, rx_ts, rx_mono, id_mode, status3, verify, base_verify, seq_class, raw_hex, backend_ms) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'OK', ?, '00', 0)",
                       (self.seq, self.sid, node, ts, 0x40 | node | (scba << 3), expired << 3, verify, seq_class))
    def correct(self, node, ts, op=1):
        self.seq += 1; self.c.execute("INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, node_id, reason) VALUES (?, ?, ?, ?, 'SCBA_CORRECTION', ?, 'n')", (self.sid, self.seq, ts, op, node))
    def load(self):
        r = connect_db(self.path, readonly=True)
        try: return load_scba_corrections(r)
        finally: r.close()
@pytest.fixture
def db(tmp_path): return Db(tmp_path / 't.db')

def test_no_correction_gives_an_empty_result(db): db.frame(1, 10); assert db.load() == {}
def test_the_latest_correction_of_each_node_wins_and_carries_the_operator_name(db):
    db.frame(1, 5); db.frame(2, 5); db.correct(1, 10, 1); db.correct(2, 11, 2); db.correct(1, 20, 2)
    assert db.load() == {1: (20, 'Ben'), 2: (11, 'Ben')}
def test_it_survives_end_shift_and_a_restart_across_sessions(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.session(2); db.frame(1, 30, scba=1); db.frame(1, 40, scba=1)
    assert db.load() == {1: (10, 'Ana')}
def test_a_later_frame_that_changes_the_scba_bit_ends_the_correction(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=1); assert 1 in db.load()
    db.frame(1, 14, scba=0); assert db.load() == {}
def test_a_later_frame_that_changes_the_scba_expired_bit_ends_the_correction(db):
    db.frame(1, 5, scba=1, expired=0); db.correct(1, 10); db.frame(1, 12, scba=1, expired=1); assert db.load() == {}
def test_a_change_that_goes_back_does_not_bring_the_correction_back(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0); db.frame(1, 14, scba=1); assert db.load() == {}
def test_a_frame_before_the_correction_and_a_frame_of_another_node_do_not_end_it(db):
    db.frame(1, 3, scba=0); db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(2, 12, scba=0); db.frame(2, 14, scba=1); assert db.load() == {1: (10, 'Ana')}
def test_a_frame_at_the_same_time_as_the_correction_is_the_baseline(db):
    db.frame(1, 10, scba=1); db.correct(1, 10); db.frame(1, 11, scba=1); assert db.load() == {1: (10, 'Ana')}
@pytest.mark.parametrize('verify,seq_class', [('BAD_MAC', 'fresh'), ('BAD_CRC', 'fresh'), ('OK', 'duplicate'), ('OK', 'suspect')])
def test_an_unverified_duplicate_or_suspect_frame_never_ends_the_correction(db, verify, seq_class):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0, verify=verify, seq_class=seq_class); assert db.load() == {1: (10, 'Ana')}
def test_a_reboot_frame_counts_as_a_frame(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0, seq_class='reboot'); assert db.load() == {}
def test_with_no_earlier_frame_the_first_later_frame_is_the_baseline(db):
    db.correct(1, 10); assert db.load() == {1: (10, 'Ana')}
    db.frame(1, 12, scba=1); db.frame(1, 14, scba=1); assert db.load() == {1: (10, 'Ana')}
    db.frame(1, 16, scba=0); assert db.load() == {}
def test_a_newer_correction_after_the_change_applies_again(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); db.frame(1, 12, scba=0); assert db.load() == {}
    db.correct(1, 20, 2); db.frame(1, 22, scba=0); assert db.load() == {1: (20, 'Ben')}
def test_loading_is_read_only_and_touches_no_alert(db):
    db.frame(1, 5, scba=1); db.correct(1, 10); before = [db.c.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0] for t in ('alerts', 'audit_events', 'frames')]
    assert db.load() == {1: (10, 'Ana')} and [db.c.execute('SELECT COUNT(*) FROM %s' % t).fetchone()[0] for t in ('alerts', 'audit_events', 'frames')] == before
`);
  putB64('docs/adr/0011.md', 'IyBBRFIgMDAxMTogU0NCQSBjb3JyZWN0aW9uIGFuZCBiYW5uZXIgYWNrbm93bGVkZ2VtZW50IChQMTljLTIpCgpTdGF0dXM6IFByb3Bvc2VkIChkZWNpZGVkIGluIHRoZSBQMTljLTIgc2Vzc2lvbjsgY29uZmlybSBhdCB0aGUgbmV4dCBkZXNpZ24gcmV2aWV3KS4KRGVzaWduOiBSZXYgMy40NSBpcyBmcm96ZW4uIE5vdGhpbmcgaW4gdGhlIGZyYW1lLCB0aGUgbWlncmF0aW9uIG9yIGBjb25zdGFudHMuanNvbmAgY2hhbmdlcy4KCi0gKipUd28gbmV3IFBvcnQgbWV0aG9kcyoqICh0aGUgcm91dGVzIHN0YXkgZnJlZSBvZiBlbmdpbmUgd29yazsgUDI0IGJ1aWxkcyB0aGVtKTogYHNldF9zY2JhX2NvcnJlY3Rpb24obm9kZV9pZCwgbm90ZSwgb3BlcmF0b3JfaWQpYCBrZWVwcyB0aGUgbGl2ZSBjb3JyZWN0aW9uIGFuZCByZXR1cm5zIGAocmVjb3JkZWRfdHMsIG9wZXJhdG9yIG5hbWUpYCwgb3IgTm9uZSB3aGVuIHRoZSBub2RlIGlzIG5vdCBpbiB0aGUgcm9zdGVyICg0MDQpLiBgYWNrX2Jhbm5lcihraW5kLCBvcGVyYXRvcl9pZClgIHJldHVybnMgYChraW5kLCBhY2tub3dsZWRnZWRfdHMpYC4gVGhlIHJvdXRlcyB3cml0ZSB0aGUgYXVkaXQgcm93cyB0aHJvdWdoIGBwb3J0LmF1ZGl0YCwgYXMgaW4gQURSIDAwMDcuCi0gKipXaGF0IHRoZSByZWFsIHBvcnQgbXVzdCBkby4qKiBTQ0JBIGNvcnJlY3Rpb246IGByZWNvcmRlZF90c2AgbXVzdCBiZSB0aGUgYHRzYCBvZiB0aGUgYFNDQkFfQ09SUkVDVElPTmAgYXVkaXQgcm93LCBiZWNhdXNlIHRoZSByZXBsYXkgYmVsb3cgcmVhZHMgdGhhdCByb3c7IHRoZSBsaXZlIHN0YXRlIGFuZCB0aGUgYXVkaXQgcm93IG11c3Qgc3VjY2VlZCBvciBmYWlsIHRvZ2V0aGVyOyB0aGUgY29tbWl0IHVzZXMgYHN5bmNocm9ub3VzPUZVTExgICgyLjEwKS4gVGhlIGNvcnJlY3Rpb24gaXMgZGlzcGxheSBzdGF0ZSBvbmx5OiB0aGUgcnVsZSBlbmdpbmUgaGFzIG5vIGlucHV0IGZvciBpdCwgc28gaXQgY2Fubm90IGNsZWFyIGBzY2JhX2V4cGlyZWRgIG9yIHN1cHByZXNzIGFuIGFtYmllbnQgQ08gYWxlcnQgKGJ5IGNvbnN0cnVjdGlvbiwgbm90IGJ5IGEgdGVzdDsgUDI0IG11c3Qga2VlcCBpdCB0aGF0IHdheSkuIEJhbm5lciBhY2s6IGFja25vd2xlZGdpbmcgYW4gYWN0aXZlIGJhbm5lciBhZ2FpbiByZXR1cm5zIHRoZSBmaXJzdCBgYWNrbm93bGVkZ2VkX3RzYDsgdGhlIGhvc3Qgc2VuZHMgdGhlIGBzeXN0ZW1gIFdlYlNvY2tldCBtZXNzYWdlIHdpdGggdGhlIGtpbmQgYW5kIHRpbWUgKFAyMCkuCi0gKipCYW5uZXIgYW5zd2VycyAoMy44IGdpdmVzIHRoZSBjb2Rlcywgbm90IHRoZSBjYXNlcyk6KiogYGhvc3RfZ2FwYCBhbmQgYGxvZ2dpbmdfZmF1bHRgIGFyZSBhY2tub3dsZWRnZWFibGU7IHRoZSBvdGhlciBmaXZlIGJhbm5lcnMgb2YgYGFsZXJ0X2NhdGFsb2cuanNvbmAgKGBub19saXZlX2RhdGFgLCBgYmFzZV9vZmZsaW5lYCwgYHJlY292ZXJpbmdgLCBgaG9zdF9wb3dlcmAsIGBhdWRpb19mYXVsdGApIGdpdmUgNDAwIEJBRF9SRVFVRVNUOyBhbnkgb3RoZXIga2luZCBnaXZlcyA0MDQgTk9UX0ZPVU5EOyBhIGJhbm5lciB0aGF0IGlzIG5vdCBhY3RpdmUgZ2l2ZXMgNDA5IFNUQVRFX0NPTkZMSUNUIChwcm9wb3NhbDogbm90aGluZyB0byBhY2tub3dsZWRnZSkuIFRoZSBzZXZlbiBuYW1lcyBhcmUgbGlzdGVkIGluIGBhcGlfcmVzdC5CQU5ORVJfS0lORFNgIGFuZCBhIHRlc3QgY29tcGFyZXMgdGhlbSB3aXRoIHRoZSBjYXRhbG9nLiBBIHJlcGVhdCBhY2tub3dsZWRnZW1lbnQgaXMgYXVkaXRlZCBhZ2FpbiwgYXMgYEFDS19BTEVSVGAgaXMuIFRoZSBgQkFOTkVSX0FDS2Agcm93IGNhcnJpZXMgdGhlIGtpbmQgaW4gYHJlYXNvbmAuCi0gKipTQ0JBIGF1ZGl0IHJvdzoqKiBub2RlIGluIGBub2RlX2lkYCwgdGhlIG5vdGUgaW4gYHJlYXNvbmAsIHNvIHRoZSByZXBsYXkgbmVlZHMgbm8gb3RoZXIgY29sdW1uLgotICoqUmVwbGF5IGZyb20gYGF1ZGl0X2V2ZW50c2A6KiogYGlvL2RiX3dyaXRlci5sb2FkX3NjYmFfY29ycmVjdGlvbnMoY29ubilgIHJldHVybnMgYHtub2RlX2lkOiAocmVjb3JkZWRfdHMsIG9wZXJhdG9yKX1gOiB0aGUgbGF0ZXN0IGBTQ0JBX0NPUlJFQ1RJT05gIG9mIGVhY2ggbm9kZSBmcm9tIGFueSBzZXNzaW9uIChzbyBFbmQgc2hpZnQgYW5kIGEgcmVzdGFydCBrZWVwIGl0KSwgZHJvcHBlZCBvbmNlIGEgbGF0ZXIgdmVyaWZpZWQgZnJhbWUgb2YgdGhhdCBub2RlIHNob3dzIGEgZGlmZmVyZW50IFNDQkEgYml0IChgaWRfbW9kZWAgYml0IDMpIG9yIGBzY2JhX2V4cGlyZWRgIGJpdCAoYHN0YXR1czNgIGJpdCAzKSB0aGFuIHRoZSBub2RlIGhhZCBhdCB0aGUgdGltZSBvZiB0aGUgY29ycmVjdGlvbi4gVGhhdCBiYXNlbGluZSBpcyB0aGUgbGFzdCBmcmFtZSBhdCBvciBiZWZvcmUgdGhlIGNvcnJlY3Rpb24sIG9yIHRoZSBmaXJzdCBmcmFtZSBhZnRlciBpdCB3aGVuIG5vbmUgZXhpc3RzIChwcm9wb3NhbDsgMi4xMCBpcyBzaWxlbnQpLiBPbmx5IGZyYW1lcyB3aXRoIGB2ZXJpZnkgPSAnT0snYCBhbmQgYHNlcV9jbGFzc2AgZnJlc2ggb3IgcmVib290IGNvdW50LCBiZWNhdXNlIGEgZHVwbGljYXRlIG9yIHN1c3BlY3QgZnJhbWUgbXVzdCBuZXZlciBsb3dlciBzdGF0ZS4gQSBjaGFuZ2UgdGhhdCBsYXRlciBjaGFuZ2VzIGJhY2sgZG9lcyBub3QgYnJpbmcgdGhlIGNvcnJlY3Rpb24gYmFjay4gUDI1IGNhbGxzIGl0IGF0IHJlc3RhcnQ7IFAyNCB1c2VzIGl0IGZvciB0aGUgc25hcHNob3QgZmllbGQgYHNjYmFfY29ycmVjdGlvbmAuCi0gKipOb3QgZGVjaWRlZCBieSB0aGUgZGVzaWduLCBsZWZ0IG9wZW46KiogYSBsaW1pdCBvbiB0aGUgbGVuZ3RoIG9mIGBub3RlYCAobm8gbnVtYmVyIGV4aXN0cywgc28gbm9uZSBpcyBlbmZvcmNlZDsgdGhlIGF1ZGl0IGByZWFzb25gIGNvbHVtbiBpcyB1bmJvdW5kZWQpIGFuZCB3aGV0aGVyIGBub2RlX2lkYCBvdXRzaWRlIDEgdG8gMyBzaG91bGQgYmUgNDIyIGluc3RlYWQgb2YgNDA0ICgzLjggbGlzdHMgNDA0IG9ubHkpLgo=');
  append('docs/PROGRESS.md', "- Part 19c-2 done: api_rest.py gains POST /api/scba-correction (404 for a node outside the roster, SCBA_CORRECTION audit row with node and note) and POST /api/system-banners/{kind}/ack (host_gap and logging_fault 200 with BANNER_ACK, the five other catalog banners 400, unknown kind 404, inactive banner 409) over two new Port methods; models ScbaCorrectionReq and BannerAckResp; io/db_writer.load_scba_corrections re-applies the latest SCBA_CORRECTION of each node from audit_events, any session, until a later verified frame changes the node's SCBA or scba_expired bit; host/tests/test_api_scba_banner.py and test_scba_replay.py, docs/adr/0011.md; the table-driven endpoint test is P19c-3");
}
