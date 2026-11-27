"""P24-5c: cli ack --node N (ADR 0048), the CLI stop test of design 8 (Host sound files and CLI stop test). The command finds the open alerts of one node in a real migrated database and acknowledges each through
POST /api/alerts/{id}/ack of a real HTTP server (Uvicorn in a thread, the real create_app with its Host and Origin rule); only the Port behind the app is a small fake. The operator tokens are real:
create-operator and disable-operator are the real commands and the real Authenticator checks them. Requirements: REQ-AUD-004, REQ-SEC-004."""
import json, os, socket, threading, time
from types import SimpleNamespace
import pytest
import uvicorn
from ppe_host import cli
from ppe_host.api import api_rest as R, security as S
from ppe_host.io.db_writer import connect_db
from ppe_host.services import ack_node as K

class Port:
    """The part of the Port the ack route uses. authenticate is the real Authenticator; ack_alert only records. `unknown` ids answer None, which the route turns into 404."""
    def __init__(self, auth, unknown=()):
        self.auth, self.unknown, self.acked, self.audits = auth, set(unknown), [], []
    def authenticate(self, token): return self.auth.authenticate(token)
    def audit(self, action, operator_id=None, node_id=None, episode_id=None, reason=None): self.audits.append((action, operator_id, node_id, reason))
    def ack_alert(self, alert_id, operator_id):
        if alert_id in self.unknown: return None
        self.acked.append((alert_id, operator_id)); return R.AlertAck(alert_id, 1, 5000 + alert_id, operator_id)
    def login_failed(self): return None
    def login_ok(self): pass
    def session_id(self): return 1

def free_port():
    with socket.socket() as s: s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

@pytest.fixture
def rig(tmp_path):
    r = SimpleNamespace(); r.home, r.db, r.port_no = tmp_path / 'home', tmp_path / 'ppe.db', free_port()
    (r.home / 'config').mkdir(parents=True)
    (r.home / 'config' / 'settings.local.json').write_text('{"bind_port": %d}' % r.port_no)       # the command reads the address of the host from the settings like the host does
    assert cli.main(['create-operator', '--name', 'Ana', '--home', str(r.home), '--db', str(r.db)]) == 0
    c = connect_db(r.db)
    c.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash) VALUES (1, 1, 'LIVE', 'b', 'c', 's')")
    c.executemany('INSERT INTO roster(node_id, alias) VALUES (?, ?)', [(1, 'FF-01'), (2, 'FF-02')]); c.close()
    r.seq = 0; r.servers = []
    r.add = lambda typ, node=1, cleared=False, ack=False: _alert(r, typ, node, cleared, ack)
    r.start = lambda unknown=(): _start(r, unknown)
    yield r
    for srv, t in r.servers: srv.should_exit = True; t.join(5)

def _alert(r, typ, node, cleared, ack):
    r.seq += 1; c = connect_db(r.db)
    try: return c.execute('INSERT INTO alerts(event_seq, session_id, node_id, type, level, raised_ts, cleared_ts, acknowledged_ts, acknowledged_by) VALUES (?, 1, ?, ?, \'DANGER\', ?, ?, ?, ?)',
                          (r.seq, node, typ, r.seq * 10, r.seq * 10 + 1 if cleared else None, r.seq * 10 + 2 if ack else None, 1 if ack else None)).lastrowid
    finally: c.close()

def _start(r, unknown):
    """The real REST app on the port of the settings. Returns the fake Port behind it."""
    salt = json.loads((r.home / 'config' / 'secrets.json').read_text())['server_salt']
    port = Port(S.Authenticator(r.db, salt, 5), unknown)
    srv = uvicorn.Server(uvicorn.Config(R.create_app(port, str(r.db), r.port_no), host='127.0.0.1', port=r.port_no, log_level='warning'))
    t = threading.Thread(target=srv.run, daemon=True); t.start(); r.servers.append((srv, t))
    end = time.monotonic() + 10
    while not srv.started and time.monotonic() < end: time.sleep(0.01)
    assert srv.started; return port

def token(capsys):
    return capsys.readouterr().out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()

def ack(rig, node, tok, monkeypatch, capsys):
    """cli.main with the token in the environment (None: no variable). Returns (exit code, stdout, stderr)."""
    monkeypatch.delenv('PPE_TOKEN', raising=False)
    if tok is not None: monkeypatch.setenv('PPE_TOKEN', tok)
    capsys.readouterr(); code = cli.main(['ack', '--node', str(node), '--home', str(rig.home), '--db', str(rig.db)]); o = capsys.readouterr(); return code, o.out, o.err

@pytest.fixture
def tok(rig, capsys):
    """A second operator, so the token of the first one (printed by the rig) does not matter; this one is the one the tests use."""
    capsys.readouterr(); assert cli.main(['create-operator', '--name', 'Ben', '--home', str(rig.home), '--db', str(rig.db)]) == 0; return token(capsys)

def test_it_acknowledges_every_open_alert_of_the_node_and_nothing_else(rig, tok, monkeypatch, capsys):
    man_down, co = rig.add('man_down'), rig.add('co_threshold')
    rig.add('heat', cleared=True); rig.add('mayday', ack=True); rig.add('man_down', node=2)       # cleared, already acknowledged and another node: all left alone
    port = rig.start()
    code, out, err = ack(rig, 1, tok, monkeypatch, capsys)
    assert code == 0 and err == '' and [a for a, _ in port.acked] == [man_down, co] and {op for _, op in port.acked} == {2}      # operator 2 is Ben, the owner of the token
    assert 'acknowledged alert %d (man_down)' % man_down in out and 'acknowledged alert %d (co_threshold)' % co in out and '2 of 2 alert(s) acknowledged' in out and 'FF-01' in out
    assert [a[:3] for a in port.audits if a[0] == 'ACK_ALERT'] == [('ACK_ALERT', 2, 1), ('ACK_ALERT', 2, 1)]       # the route writes the ACK_ALERT row with the operator and the node

def test_the_token_is_never_printed(rig, tok, monkeypatch, capsys):
    rig.add('man_down'); rig.start()
    code, out, err = ack(rig, 1, tok, monkeypatch, capsys); assert code == 0 and tok not in out + err
    code, out, err = ack(rig, 1, 'wrong-' + tok, monkeypatch, capsys); assert code == 1 and tok not in out + err

def test_a_proxy_in_the_environment_is_not_used_for_the_host_on_this_machine(rig, tok, monkeypatch, capsys):
    rig.add('man_down'); port = rig.start(); monkeypatch.setenv('HTTP_PROXY', 'http://127.0.0.1:9'); monkeypatch.setenv('http_proxy', 'http://127.0.0.1:9')
    code, _, _ = ack(rig, 1, tok, monkeypatch, capsys); assert code == 0 and len(port.acked) == 1

def test_a_removed_operators_token_is_refused_and_nothing_is_acknowledged(rig, monkeypatch, capsys):          # design 8: a removed operator's token is refused (D8)
    capsys.readouterr(); cli.main(['create-operator', '--name', 'Cy', '--home', str(rig.home), '--db', str(rig.db)]); t = token(capsys)
    rig.add('man_down'); port = rig.start()
    assert ack(rig, 1, t, monkeypatch, capsys)[0] == 0 and len(port.acked) == 1
    rig.add('co_threshold'); assert cli.main(['disable-operator', '--operator-id', '2', '--home', str(rig.home), '--db', str(rig.db)]) == 0
    code, out, err = ack(rig, 1, t, monkeypatch, capsys)
    assert code == 1 and 'refused' in err and out == '' and len(port.acked) == 1 and t not in err

def test_a_wrong_token_is_refused_at_the_first_alert_and_the_rest_are_not_tried(rig, monkeypatch, capsys):
    rig.add('man_down'); rig.add('co_threshold'); port = rig.start()
    code, out, err = ack(rig, 1, 'not-a-token', monkeypatch, capsys)
    assert code == 1 and 'refused' in err and out == '' and port.acked == [] and [a[0] for a in port.audits] == ['LOGIN_REJECTED']      # one try, not one per alert

def test_without_the_token_variable_nothing_is_sent(rig, monkeypatch, capsys):
    rig.add('man_down'); port = rig.start()
    for value in (None, '', '   '):
        code, out, err = ack(rig, 1, value, monkeypatch, capsys); assert code == 1 and 'PPE_TOKEN' in err and out == ''
    assert port.acked == [] and port.audits == []

def test_there_is_no_token_flag_so_it_never_reaches_the_shell_history(rig, monkeypatch, capsys):
    with pytest.raises(SystemExit): cli.main(['ack', '--node', '1', '--token', 'x', '--home', str(rig.home), '--db', str(rig.db)])

def test_a_host_that_is_not_running_is_exit_1_and_names_it(rig, tok, monkeypatch, capsys):
    rig.add('man_down'); code, out, err = ack(rig, 1, tok, monkeypatch, capsys)       # nothing listens on the port of the settings
    assert code == 1 and out == '' and 'did not answer' in err and '127.0.0.1:%d' % rig.port_no in err and 'running' in err

def test_nothing_open_is_exit_0_and_sends_nothing(rig, tok, monkeypatch, capsys):
    rig.add('heat', cleared=True); rig.add('mayday', ack=True); port = rig.start()
    code, out, err = ack(rig, 1, tok, monkeypatch, capsys)
    assert code == 0 and 'no open alert' in out and err == '' and port.acked == [] and port.audits == []

def test_a_node_that_is_not_in_the_roster_is_exit_1(rig, tok, monkeypatch, capsys):
    code, out, err = ack(rig, 9, tok, monkeypatch, capsys); assert code == 1 and 'node 9 is not in the roster' in err and out == ''

def test_one_alert_the_host_does_not_know_is_reported_and_the_others_are_still_acknowledged(rig, tok, monkeypatch, capsys):
    a, b, c = rig.add('man_down'), rig.add('co_threshold'), rig.add('heat'); port = rig.start(unknown=[b])
    code, out, err = ack(rig, 1, tok, monkeypatch, capsys)
    assert code == 2 and [x for x, _ in port.acked] == [a, c] and 'alert %d (co_threshold) was not acknowledged: HTTP 404 NOT_FOUND' % b in err and '2 of 3 alert(s) acknowledged' in out

def test_every_alert_refused_for_a_reason_other_than_the_token_is_exit_1(rig, tok, monkeypatch, capsys):
    a = rig.add('man_down'); rig.start(unknown=[a]); code, out, err = ack(rig, 1, tok, monkeypatch, capsys)
    assert code == 1 and out == '' and 'HTTP 404' in err

def test_a_missing_database_is_exit_1_and_is_not_created(rig, tok, monkeypatch, capsys):
    os.remove(rig.db); code, out, err = ack(rig, 1, tok, monkeypatch, capsys)
    assert code == 1 and 'database file not found' in err and not rig.db.exists()

def test_reading_the_alerts_creates_no_file_next_to_the_database(rig, tok, monkeypatch, capsys):
    rig.add('man_down'); before = sorted(os.listdir(rig.db.parent)); code, out, err = ack(rig, 1, tok, monkeypatch, capsys)      # the host is down: the alerts are listed, then the call fails
    assert code == 1 and 'did not answer' in err and sorted(os.listdir(rig.db.parent)) == before

def test_a_wildcard_bind_address_is_connected_to_as_127_0_0_1():
    assert K.base_url({'bind_host': '0.0.0.0', 'bind_port': 8420}) == 'http://127.0.0.1:8420' and K.base_url({'bind_host': '127.0.0.1', 'bind_port': 9}) == 'http://127.0.0.1:9'
    assert K.base_url({'bind_host': 'localhost', 'bind_port': 8420}) == 'http://localhost:8420'

def test_the_mode_decides_which_database_the_host_is_read_from(rig, monkeypatch, capsys):          # the host writes test_db_path in every mode but LIVE
    seen = []; monkeypatch.setattr(K, 'run_ack', lambda db, node, token, base, **kw: seen.append(str(db)) or (0, [], []))
    for mode in ('LIVE', 'SIMULATOR', 'REPLAY'): assert cli.main(['ack', '--node', '1', '--mode', mode, '--home', str(rig.home)]) == 0
    assert cli.main(['ack', '--node', '1', '--home', str(rig.home)]) == 0 and cli.main(['ack', '--node', '1', '--mode', 'SIMULATOR', '--db', 'x.db', '--home', str(rig.home)]) == 0
    assert [os.path.basename(d) for d in seen] == ['ppe.db', 'ppe_test.db', 'ppe_test.db', 'ppe.db', 'x.db']

def test_the_modes_of_the_command_are_the_modes_of_the_host():
    from ppe_host import main as M
    assert tuple(cli.COMMANDS['ack'][1][1][1]['choices']) == M.MODES
