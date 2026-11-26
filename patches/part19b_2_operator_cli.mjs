// patches/part19b_2_operator_cli.mjs  (run from repo root: node patches/part19b_2_operator_cli.mjs [--dry] [--force])
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
  replace('host/ppe_host/cli.py', String.raw`import argparse, sys
from pathlib import Path
`, String.raw`import argparse
import sys
from pathlib import Path
`);
  replace('host/ppe_host/cli.py', String.raw`    # P-next commands are added here (one line each)
}

def main(argv=None):
`, String.raw`}

# ---- P19b-2: operator commands (design 2.8 and 4). Offline: their audit rows have session_id NULL and event_seq 0, as 2.3 says for CLI actions.
# The token is printed once, never stored (only its HMAC) and never logged. cli ack --node needs the running host and is not here (docs/adr/0009.md). ----
import sqlite3, time
from .settings import SettingsError, load_settings
OPERATOR_FLAGS = [('--home', {'help': 'PPE_HOME (default: the PPE_HOME variable, else the repository folder)'}), ('--db', {'help': 'database file (default: db_path of the settings)'})]
def _open(a, create):
    s = load_settings(a.home); db = Path(a.db) if a.db else s.path('db_path')
    if not create and not db.exists(): raise SettingsError('database file not found: %s' % db)
    db.parent.mkdir(parents=True, exist_ok=True); conn = connect_db(db)
    if not applied_versions(conn):
        if not create: conn.close(); raise SettingsError('database has no schema: %s' % db)
        run_migrations(conn, str(MIGRATIONS_DIR), int(time.time() * 1000))
    return s.home, conn
def _write_with_audit(conn, action, write):
    """One transaction: write() changes operators and returns the operator_id; then the audit row (session_id NULL, event_seq 0, operator_id NULL, reason names the operator)."""
    conn.execute('BEGIN IMMEDIATE')
    try:
        oid = write(); conn.execute('INSERT INTO audit_events(session_id, event_seq, ts, operator_id, action, reason) VALUES (NULL, 0, ?, NULL, ?, ?)', (int(time.time() * 1000), action, 'operator_id %d' % oid)); conn.execute('COMMIT'); return oid
    except BaseException: conn.execute('ROLLBACK'); raise
def _fail(cmd, msg): print('%s: %s' % (cmd, msg), file=sys.stderr); return 1
def _salt(home, conn):
    from .api import security as sec
    return sec.load_or_create_salt(home, conn.execute('SELECT COUNT(*) FROM operators').fetchone()[0] > 0)

def cmd_create_operator(a):
    from .api import security as sec
    name = (a.name or '').strip()
    if not name: return _fail('create-operator', '--name must not be empty')
    try:
        home, conn = _open(a, True)
        try:
            salt, token, now = _salt(home, conn), sec.new_token(), int(time.time() * 1000)
            def write(): return conn.execute('INSERT INTO operators(display_name, token_hash, active, created_ts, token_issued_ts) VALUES (?, ?, 1, ?, ?)', (name, sec.hash_token(salt, token), now, now)).lastrowid
            oid = _write_with_audit(conn, 'OPERATOR_ADDED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('create-operator', str(e))
    except sqlite3.IntegrityError: return _fail('create-operator', 'an operator named %r already exists' % name)
    print('create-operator: operator_id %d (%s)\nTOKEN (shown once, only its hash is stored): %s' % (oid, name, token)); return 0

def _existing(a, cmd):
    """(home, conn, row) of the operator --operator-id, or an exit code."""
    home, conn = _open(a, False)
    row = conn.execute('SELECT display_name, active FROM operators WHERE operator_id = ?', (a.operator_id,)).fetchone()
    if row is None: conn.close(); raise SettingsError('no operator with operator_id %d' % a.operator_id)
    return home, conn, row
def cmd_rotate_token(a):
    from .api import security as sec
    try:
        home, conn, (name, active) = _existing(a, 'rotate-token')
        try:
            if not active: raise SettingsError('operator %d (%s) is disabled; a disabled operator gets no new token' % (a.operator_id, name))
            salt, token, now = _salt(home, conn), sec.new_token(), int(time.time() * 1000)
            def write(): conn.execute('UPDATE operators SET token_hash = ?, token_issued_ts = ? WHERE operator_id = ?', (sec.hash_token(salt, token), now, a.operator_id)); return a.operator_id
            _write_with_audit(conn, 'TOKEN_ROTATED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('rotate-token', str(e))
    print('rotate-token: operator_id %d (%s), the old token no longer works\nTOKEN (shown once, only its hash is stored): %s' % (a.operator_id, name, token)); return 0
def cmd_disable_operator(a):
    try:
        home, conn, (name, active) = _existing(a, 'disable-operator')
        try:
            if active:
                def write(): conn.execute('UPDATE operators SET active = 0 WHERE operator_id = ?', (a.operator_id,)); return a.operator_id
                _write_with_audit(conn, 'OPERATOR_DISABLED', write)
        finally: conn.close()
    except SettingsError as e: return _fail('disable-operator', str(e))
    print('disable-operator: operator_id %d (%s) %s' % (a.operator_id, name, 'is disabled' if active else 'was already disabled, nothing changed')); return 0

COMMANDS.update({
    'create-operator': (cmd_create_operator, [('--name', {'required': True, 'help': 'display name shown in the audit log'})] + OPERATOR_FLAGS),
    'rotate-token': (cmd_rotate_token, [('--operator-id', {'type': int, 'required': True})] + OPERATOR_FLAGS),
    'disable-operator': (cmd_disable_operator, [('--operator-id', {'type': int, 'required': True})] + OPERATOR_FLAGS),
})
def main(argv=None):
`);
  put('host/tests/test_cli_operators.py', String.raw`"""P19b-2: create-operator, rotate-token and disable-operator (design 2.8, 4, 4.1, 8). Real migrated database and a real secrets.json in a temporary PPE_HOME."""
import json, sqlite3
import pytest
from ppe_host import cli
from ppe_host.api import api_rest as R, security as S
from ppe_host.io.db_writer import connect_db, init_event_seq

@pytest.fixture
def env(tmp_path):
    home, db = tmp_path / 'home', tmp_path / 'ops.db'; return home, db
def run(env, *args, capsys=None):
    home, db = env; return cli.main(list(args) + ['--home', str(home), '--db', str(db)])
def token_of(capsys):
    out = capsys.readouterr().out; assert 'shown once' in out; return out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()
def salt(env): return json.loads((env[0] / 'config' / 'secrets.json').read_text())['server_salt']
def rows(env, sql, *p): c = connect_db(env[1], readonly=True); r = c.execute(sql, p).fetchall(); c.close(); return r
def auth(env, tok): return S.Authenticator(env[1], salt(env), 5).authenticate(tok)

def test_create_operator_prints_the_token_once_and_stores_only_its_hmac(env, capsys):
    assert run(env, 'create-operator', '--name', 'Ana') == 0; tok = token_of(capsys)
    r = rows(env, 'SELECT operator_id, display_name, token_hash, active, created_ts, token_issued_ts FROM operators')
    assert len(r) == 1 and r[0][:2] == (1, 'Ana') and r[0][2] == S.hash_token(salt(env), tok) and tok not in r[0][2] and r[0][3] == 1 and r[0][4] == r[0][5] > 0
    assert tok not in (env[0] / 'config' / 'secrets.json').read_text() and auth(env, tok) == R.Operator(1, 'Ana')
def test_create_operator_audits_operator_added_offline_with_session_null_and_event_seq_0(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); a = rows(env, 'SELECT session_id, event_seq, operator_id, action, node_id, episode_id, reason FROM audit_events')
    assert a == [(None, 0, None, 'OPERATOR_ADDED', None, None, 'operator_id 1')] and init_event_seq(connect_db(env[1], readonly=True)) == 1      # an offline row never moves the event_seq counter
def test_the_salt_is_created_once_and_shared_by_later_operators(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); t1 = token_of(capsys); s1 = salt(env)
    run(env, 'create-operator', '--name', 'Ben'); t2 = token_of(capsys)
    assert salt(env) == s1 and t1 != t2 and auth(env, t1).display_name == 'Ana' and auth(env, t2).display_name == 'Ben'
def test_a_duplicate_or_empty_name_fails_and_changes_nothing(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr()
    for name in ('Ana', ' Ana ', '', '   '): assert run(env, 'create-operator', '--name', name) == 1
    err = capsys.readouterr(); assert 'TOKEN' not in err.out and len(rows(env, 'SELECT * FROM operators')) == 1 and len(rows(env, 'SELECT * FROM audit_events')) == 1
def test_the_name_is_stripped(env, capsys):
    run(env, 'create-operator', '--name', '  Ana  '); assert rows(env, 'SELECT display_name FROM operators') == [('Ana',)]
def test_a_missing_salt_while_operators_exist_is_refused_and_no_operator_is_added(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr(); (env[0] / 'config' / 'secrets.json').unlink()
    assert run(env, 'create-operator', '--name', 'Ben') == 1 and 'server_salt is missing' in capsys.readouterr().err
    assert len(rows(env, 'SELECT * FROM operators')) == 1 and not (env[0] / 'config' / 'secrets.json').exists()

def test_rotate_token_replaces_the_hash_audits_it_and_spares_the_others(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); old = token_of(capsys); run(env, 'create-operator', '--name', 'Ben'); ben = token_of(capsys)
    assert run(env, 'rotate-token', '--operator-id', '1') == 0; new = token_of(capsys)
    assert new != old and auth(env, old) is None and auth(env, new) == R.Operator(1, 'Ana') and auth(env, ben) == R.Operator(2, 'Ben')
    assert rows(env, "SELECT session_id, event_seq, action, reason FROM audit_events WHERE action = 'TOKEN_ROTATED'") == [(None, 0, 'TOKEN_ROTATED', 'operator_id 1')]
def test_rotate_token_refuses_unknown_and_disabled_operators_and_a_missing_database(env, capsys, tmp_path):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr(); before = rows(env, 'SELECT token_hash FROM operators')
    assert run(env, 'rotate-token', '--operator-id', '9') == 1 and 'no operator' in capsys.readouterr().err
    run(env, 'disable-operator', '--operator-id', '1'); capsys.readouterr()
    assert run(env, 'rotate-token', '--operator-id', '1') == 1 and 'disabled' in capsys.readouterr().err and rows(env, 'SELECT token_hash FROM operators') == before
    assert cli.main(['rotate-token', '--operator-id', '1', '--home', str(env[0]), '--db', str(tmp_path / 'none.db')]) == 1 and not (tmp_path / 'none.db').exists()
def test_rotate_token_without_the_salt_is_refused_and_keeps_the_old_token(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); tok = token_of(capsys); s = salt(env); (env[0] / 'config' / 'secrets.json').unlink()
    assert run(env, 'rotate-token', '--operator-id', '1') == 1 and 'server_salt is missing' in capsys.readouterr().err
    (env[0] / 'config' / 'secrets.json').write_text(json.dumps({'server_salt': s})); assert auth(env, tok) is not None and len(rows(env, 'SELECT * FROM audit_events')) == 1

def test_disable_operator_blocks_the_token_at_once_and_audits_once(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); a = token_of(capsys); run(env, 'create-operator', '--name', 'Ben'); b = token_of(capsys)
    assert run(env, 'disable-operator', '--operator-id', '1') == 0 and rows(env, 'SELECT active FROM operators ORDER BY operator_id') == [(0,), (1,)]
    assert auth(env, a) is None and auth(env, b) is not None and 'is disabled' in capsys.readouterr().out
    assert run(env, 'disable-operator', '--operator-id', '1') == 0 and 'already disabled' in capsys.readouterr().out      # a repeat changes nothing and adds no second row
    assert rows(env, "SELECT session_id, event_seq, action, reason FROM audit_events WHERE action = 'OPERATOR_DISABLED'") == [(None, 0, 'OPERATOR_DISABLED', 'operator_id 1')]
def test_disable_operator_unknown_id_and_missing_database_fail(env, capsys, tmp_path):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr()
    assert run(env, 'disable-operator', '--operator-id', '5') == 1 and 'no operator' in capsys.readouterr().err
    assert cli.main(['disable-operator', '--operator-id', '1', '--home', str(env[0]), '--db', str(tmp_path / 'none.db')]) == 1
def test_the_operator_id_must_be_an_integer(env):
    with pytest.raises(SystemExit): run(env, 'disable-operator', '--operator-id', 'x')
def test_a_failed_audit_insert_rolls_the_operator_change_back(env, capsys, monkeypatch):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr(); c = connect_db(env[1]); c.execute('DELETE FROM audit_actions WHERE action = ?', ('OPERATOR_DISABLED',)); c.close()
    with pytest.raises(sqlite3.IntegrityError): run(env, 'disable-operator', '--operator-id', '1')
    assert rows(env, 'SELECT active FROM operators') == [(1,)]
def test_default_database_comes_from_the_settings_and_a_new_home_works(tmp_path, capsys):
    assert cli.main(['create-operator', '--name', 'Ana', '--home', str(tmp_path)]) == 0 and (tmp_path / 'data' / 'ppe.db').exists() and (tmp_path / 'config' / 'secrets.json').exists()
`);
  putB64('docs/adr/0009.md', 'IyBBRFIgMDAwOTogb3BlcmF0b3IgQ0xJIGNvbW1hbmRzIChQMTliLTIpCgpTdGF0dXM6IFByb3Bvc2VkIChkZWNpZGVkIGluIHRoZSBQMTliLTIgc2Vzc2lvbjsgY29uZmlybSBhdCB0aGUgbmV4dCBkZXNpZ24gcmV2aWV3KS4KRGVzaWduOiBSZXYgMy40NSBpcyBmcm96ZW4uIE5vdGhpbmcgaW4gdGhlIGZyYW1lLCB0aGUgbWlncmF0aW9uIG9yIGBjb25zdGFudHMuanNvbmAgY2hhbmdlcy4KCi0gKipDb21tYW5kczoqKiBgcHl0aG9uIC1tIHBwZV9ob3N0LmNsaSBjcmVhdGUtb3BlcmF0b3IgLS1uYW1lIE5gLCBgcm90YXRlLXRva2VuIC0tb3BlcmF0b3ItaWQgTmAsIGBkaXNhYmxlLW9wZXJhdG9yIC0tb3BlcmF0b3ItaWQgTmAsIGVhY2ggd2l0aCBvcHRpb25hbCBgLS1ob21lYCAoZGVmYXVsdCBgUFBFX0hPTUVgLCBlbHNlIHRoZSByZXBvc2l0b3J5IGZvbGRlcikgYW5kIGAtLWRiYCAoZGVmYXVsdCBgZGJfcGF0aGAgb2YgdGhlIHNldHRpbmdzKS4gVGhlIGZ1bmN0aW9ucyBzaXQgaW4gYGNsaS5weWAsIHRoZSBmaWxlIHRoZSBsYXlvdXQgb2YgMTQuNSBuYW1lcyBmb3IgQ0xJIGFjdGlvbnM7IHRoZSBzZWN1cml0eSBoZWxwZXJzIHRoZXkgdXNlIGFyZSBpbiBgYXBpL3NlY3VyaXR5LnB5YCAoQURSIDAwMDgpLgotICoqVG9rZW46Kiogc2hvd24gb25jZSBvbiBzdGFuZGFyZCBvdXRwdXQgYW5kIG5ldmVyIHN0b3JlZCAob25seSBpdHMgSE1BQykgb3IgbG9nZ2VkLiBFcnJvcnMgZ28gdG8gc3RhbmRhcmQgZXJyb3Igd2l0aCBleGl0IGNvZGUgMSBhbmQgbmV2ZXIgY29udGFpbiBhIHRva2VuLgotICoqQXVkaXQgcm93czoqKiBgT1BFUkFUT1JfQURERURgLCBgVE9LRU5fUk9UQVRFRGAgYW5kIGBPUEVSQVRPUl9ESVNBQkxFRGAgYXJlIHdyaXR0ZW4gaW4gdGhlIHNhbWUgdHJhbnNhY3Rpb24gYXMgdGhlIGNoYW5nZSwgd2l0aCBgc2Vzc2lvbl9pZGAgTlVMTCwgYGV2ZW50X3NlcWAgMCBhbmQgYG9wZXJhdG9yX2lkYCBOVUxMLCBhcyAyLjMgc2F5cyBmb3Igb2ZmbGluZSBDTEkgYWN0aW9ucy4gVGhlIGFmZmVjdGVkIG9wZXJhdG9yIGdvZXMgaW4gYHJlYXNvbmAgYXMgYG9wZXJhdG9yX2lkIDxuPmAgKHByb3Bvc2FsOiB0aGUgdGFibGUgaGFzIG5vIG90aGVyIGNvbHVtbiBmb3IgaXQpLiBUaGV5IGFyZSBub3QgaW4gYHZfZnVsbF9sb2dgLCBzbyB0aGV5IGFyZSByZWFkIGZyb20gYGF1ZGl0X2V2ZW50c2AgKDIuNSkuIEV2ZW50X3NlcSAwIG5ldmVyIG1vdmVzIGBpbml0X2V2ZW50X3NlcWAuCi0gKipSdWxlcyAocHJvcG9zYWxzIHdoZXJlIDMuOCBhbmQgNCBhcmUgc2lsZW50KToqKiBhIG5hbWUgaXMgc3RyaXBwZWQgYW5kIG11c3QgYmUgbm9uLWVtcHR5IGFuZCB1bmlxdWU7IGBjcmVhdGUtb3BlcmF0b3JgIGlzIHRoZSBvbmx5IGNvbW1hbmQgdGhhdCBtYXkgY3JlYXRlIHRoZSBzY2hlbWEgb3IgYHNlY3JldHMuanNvbmAgKGl0IGFwcGxpZXMgbWlncmF0aW9uIDAwMDEgdG8gYW4gZW1wdHkgZmlsZSBhcyBgc2VlZC1yb3N0ZXJgIGRvZXMpOyBgcm90YXRlLXRva2VuYCBhbmQgYGRpc2FibGUtb3BlcmF0b3JgIHJlZnVzZSBhIG1pc3NpbmcgZGF0YWJhc2UsIGFuIHVua25vd24gaWQgYW5kIGEgbWlzc2luZyBgc2VydmVyX3NhbHRgOyBgcm90YXRlLXRva2VuYCByZWZ1c2VzIGEgZGlzYWJsZWQgb3BlcmF0b3IgYmVjYXVzZSB0aGVyZSBpcyBubyBlbmFibGUgY29tbWFuZDsgYGRpc2FibGUtb3BlcmF0b3JgIG9uIGFuIGFscmVhZHkgZGlzYWJsZWQgb3BlcmF0b3IgaXMgZXhpdCAwIHdpdGggbm8gc2Vjb25kIGF1ZGl0IHJvdy4gUm90YXRpbmcgb3IgZGlzYWJsaW5nIHRha2VzIGVmZmVjdCBvbiB0aGUgbmV4dCByZXF1ZXN0IChgYXV0aGVudGljYXRlYCByZWFkcyB0aGUgdGFibGUgZWFjaCB0aW1lKTsgY2xvc2luZyBhbiBvcGVuIHNvY2tldCBpcyBQMjAuCi0gKipSdW5uaW5nIGhvc3Q6KiogdGhlIGNvbW1hbmRzIHdyaXRlIHRocm91Z2ggYSBzZXBhcmF0ZSBjb25uZWN0aW9uIHdpdGggYSBidXN5IHRpbWVvdXQsIHNvIHRoZXkgbWF5IHJ1biB3aGlsZSB0aGUgaG9zdCBpcyB1cC4gVGhlIGRlc2lnbiBzYXlzIHRvIHJvdGF0ZSAiYmV0d2VlbiBzaGlmdHMiOyBub3RoaW5nIHN0b3BzIGEgcm90YXRpb24gZHVyaW5nIG9uZSwgYW5kIHRoZSBhdWRpdCByb3cgdGhlbiBoYXMgbm8gc2Vzc2lvbi4KLSAqKk5vdCBidWlsdDogYGNsaSBhY2sgLS1ub2RlIE5gLioqIERlc2lnbiA4ICgiSG9zdCBzb3VuZCBmaWxlcyBhbmQgQ0xJIHN0b3AgdGVzdCIpIGhhcyBpdCBzdG9wIGEgbWFuLWRvd24gc2lyZW4gb24gdGhlIGhvc3Qgc2luayB3aXRoIHplcm8gYnJvd3NlciB0YWJzIG9wZW4gYW5kIHdyaXRlIGBBQ0tfQUxFUlRgLiBUaGF0IG5lZWRzIHRoZSBydW5uaW5nIGhvc3QgKGVuZ2luZSBzdGF0ZSBhbmQgdGhlIGF1ZGlvIHRocmVhZCksIHdoaWNoIGV4aXN0IG9ubHkgaW4gUDIzIGFuZCBQMjQsIHNvIGl0IGNhbm5vdCBiZSBhbiBvZmZsaW5lIGRhdGFiYXNlIGNvbW1hbmQuIEl0IG1vdmVzIHRvIFAyNCwgd2l0aCB0aGUgaG9zdCBleHBvc2luZyBhIGxvY2FsIGNvbnRyb2wgcGF0aDsgdGhlIFAxOWIgcm93IG9mIHRoZSBndWlkZSBpcyBwYXJ0bHkgb3BlbiB1bnRpbCB0aGVuLgo=');
  append('docs/PROGRESS.md', '- Part 19b-2 done: cli.py gains create-operator --name, rotate-token --operator-id and disable-operator --operator-id (token printed once and stored only as its HMAC, server_salt created or required through api/security.py, operator change and audit row in one transaction with OPERATOR_ADDED, TOKEN_ROTATED and OPERATOR_DISABLED written offline with session_id NULL and event_seq 0, rotate refuses a disabled operator, repeat disable adds no row), host/tests/test_cli_operators.py (14 tests), docs/adr/0009.md; P19b is complete except cli ack --node N, which needs the running host and moves to P24');
}
