"""P24-5c: the pass condition of design 8 (Host sound files and CLI stop test) on the real host: with zero browser tabs open a man-down sounds on the mocked host sink, `python -m ppe_host.cli ack --node N` stops it for that
card and writes ACK_ALERT, and a removed operator's token is refused. The host is the real Runtime with its AudioThread (a FakeBackend is the sink), the real REST app and HostPort behind Uvicorn on a free port, and the
real operator commands. The man-down is put into the engine state and the alerts table as the engine would hold it after a verified frame: a signed radio frame is not built here. Requirements: REQ-AUD-004, REQ-SEC-004."""
import asyncio, dataclasses, json, socket, sqlite3, threading, time
import pytest
import uvicorn
from ppe_host import cli, main as M, runtime as R, serve as S
from ppe_host.clock import FakeClock
from ppe_host.core.rule_engine import OpenAlert
from fakeaudio import FakeBackend
from fakeport import FakePort
from test_startup import NOW, home, run

def free_port():
    with socket.socket() as s: s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

def until(fn, secs=5.0):
    end = time.monotonic() + secs
    while time.monotonic() < end:
        if fn(): return True
        time.sleep(0.02)
    return fn()

def sql(db, q, *p):
    c = sqlite3.connect(str(db)); r = c.execute(q, p).fetchall(); c.close(); return r

def stopped_after_siren(fb):
    with fb.lock: calls = list(fb.calls)
    i = next(n for n, c in enumerate(calls) if c[:2] == ('play', 'siren.wav'))
    return ('stop',) in calls[i:]

@pytest.fixture
def host(tmp_path, monkeypatch, capsys):
    h = home(tmp_path); port = free_port()
    (h / 'config' / 'settings.local.json').write_text(json.dumps({'bind_port': port}))
    tokens = []
    for name in ('Ana', 'Ben'):                                                       # real operators: the command creates the database, secrets salt and the token
        capsys.readouterr(); assert cli.main(['create-operator', '--name', name, '--home', str(h)]) == 0
        tokens.append(capsys.readouterr().out.split('TOKEN (shown once, only its hash is stored): ')[1].strip())
    assert cli.main(['seed-roster', '--db', str(h / 'data' / 'ppe.db')]) == 0                                          # nodes 1 to 3, as at a real install
    st = run(h, 'LIVE'); M.begin_session(st); st.recovering = False
    fb = FakeBackend(); rt = R.Runtime(st, FakeClock(NOW, 0), open_port=lambda: FakePort([]), audio_backend=fb).start()
    node = 1; seq = st.event_seq + 100
    c = sqlite3.connect(str(st.db_path)); c.execute("INSERT INTO alerts(alert_id, event_seq, session_id, node_id, type, level, reasons, raised_ts) VALUES (500, ?, ?, ?, 'man_down', 'DANGER', '', ?)", (seq, st.session_id, node, NOW)); c.commit(); c.close()
    rt.ingest.st = dataclasses.replace(rt.ingest.st, alerts={(node, 'man_down'): OpenAlert(node, 'man_down', 'DANGER', seq, NOW, '', None)})       # what the engine holds for an open man-down
    holder = []
    def serve():
        mk = lambda app: holder.append(uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='warning', lifespan='on'))) or holder[0]
        asyncio.run(S.run_server(rt, '127.0.0.1', port, make_server=mk))
    t = threading.Thread(target=serve, daemon=True); t.start()
    assert until(lambda: holder and holder[0].started)
    yield h, st, fb, tokens
    holder[0].should_exit = True; t.join(10); rt.stop(clean=True); st.close()

def test_a_man_down_sounds_with_no_browser_open_and_ack_node_stops_it_and_writes_ack_alert(host, monkeypatch, capsys):
    h, st, fb, (_, ben) = host
    assert until(lambda: 'siren.wav' in fb.played())                                                                                         # zero sockets: nothing is connected, the host sounds the man-down
    assert [c for c in fb.calls if c[0] == 'play' and c[1] == 'siren.wav' and c[2]]                                                        # looped
    time.sleep(0.3); assert not stopped_after_siren(fb)                                                                                      # it keeps sounding until somebody acknowledges
    monkeypatch.setenv('PPE_TOKEN', ben); capsys.readouterr()
    assert cli.main(['ack', '--node', '1', '--home', str(h)]) == 0
    out = capsys.readouterr().out; assert 'acknowledged alert 500 (man_down)' in out and ben not in out
    assert until(lambda: sql(st.db_path, 'SELECT acknowledged_by FROM alerts WHERE alert_id = 500') == [(2,)])                               # the row names the operator of the token (Ben is 2)
    assert until(lambda: stopped_after_siren(fb))                                                                                            # the siren stopped
    q = "SELECT operator_id, node_id, reason FROM audit_events WHERE action = 'ACK_ALERT'"
    assert until(lambda: sql(st.db_path, q) == [(2, 1, 'alert_id 500')])                                                                    # the audit row is written by the database writer thread a moment later
    assert cli.main(['ack', '--node', '1', '--home', str(h)]) == 0 and 'no open alert' in capsys.readouterr().out                            # a second run finds nothing open

def test_a_removed_operators_token_does_not_stop_the_siren(host, monkeypatch, capsys):
    h, st, fb, (ana, _) = host
    assert until(lambda: 'siren.wav' in fb.played())
    assert cli.main(['disable-operator', '--operator-id', '1', '--home', str(h)]) == 0
    monkeypatch.setenv('PPE_TOKEN', ana); capsys.readouterr()
    assert cli.main(['ack', '--node', '1', '--home', str(h)]) == 1
    o = capsys.readouterr(); assert 'refused' in o.err and ana not in o.out + o.err
    time.sleep(0.3); assert sql(st.db_path, 'SELECT acknowledged_ts FROM alerts WHERE alert_id = 500') == [(None,)] and sql(st.db_path, "SELECT COUNT(*) FROM audit_events WHERE action = 'ACK_ALERT'") == [(0,)]
