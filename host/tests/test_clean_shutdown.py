"""S7-4 (ADR 0060): Ctrl+C and SIGTERM end the host cleanly. main.stop_signals() and the stop path of main().
Found in S7-1: Uvicorn puts the old signal handlers back after it has stopped and sends the same signal again, so a console Ctrl+C ended the process with a KeyboardInterrupt (exit -2) and SIGTERM with exit -15; no CLEAN_SHUTDOWN row, the session stayed open and the supervisor respawned the host.
The two subprocess tests start a real host with real Uvicorn and send it a real signal (POSIX only: Windows has no os-level SIGINT for a child, see the ADR). Requirements: REQ-REC-001.
"""
import json, queue, signal, socket, sqlite3, subprocess, sys, threading, time
from pathlib import Path
import pytest
from ppe_host import main as M
from test_startup import home

HOST_DIR = Path(__file__).resolve().parents[1]

def rows(db, sql, args=()):
    c = sqlite3.connect(db)
    try: return c.execute(sql, args).fetchall()
    finally: c.close()

def ended_cleanly(db):
    return (rows(db, "SELECT COUNT(*) FROM system_events WHERE kind = 'CLEAN_SHUTDOWN'")[0][0] == 1 and rows(db, "SELECT COUNT(*) FROM sessions WHERE end_kind = 'CLEAN_SHUTDOWN'")[0][0] == 1
            and rows(db, 'SELECT COUNT(*) FROM sessions WHERE ended_ts IS NULL')[0][0] == 0)

def run_main(tmp_path, serve, mode='SIMULATOR'):
    h = home(tmp_path); code = M.main(['--home', str(h), '--mode', mode], serve=serve); return code, h / 'data' / ('ppe.db' if mode == 'LIVE' else 'ppe_test.db')

def uvicorn_like(sig):
    """What uvicorn.Server.capture_signals does: take the handler, stop, put the old handler back, send the signal again."""
    async def serve(rt, host, port):
        old = signal.getsignal(sig)
        assert getattr(old, '__module__', None) == M.__name__, 'stop_signals is not in place; sending the signal would end the test process'
        signal.signal(sig, lambda s, f: None); signal.signal(sig, old); signal.raise_signal(sig)
    return serve

# ---- stop_signals ----
@pytest.mark.parametrize('sig', [signal.SIGINT, signal.SIGTERM])
def test_stop_signals_records_the_signal_and_does_not_raise(sig):
    with M.stop_signals() as got:
        signal.raise_signal(sig); assert got == [sig]
        signal.raise_signal(sig); assert got == [sig, sig]

def test_stop_signals_puts_the_old_handlers_back():
    names = [n for n in ('SIGINT', 'SIGTERM', 'SIGBREAK') if hasattr(signal, n)]; before = {n: signal.getsignal(getattr(signal, n)) for n in names}
    with M.stop_signals(): assert all(signal.getsignal(getattr(signal, n)) is not before[n] for n in names)
    assert {n: signal.getsignal(getattr(signal, n)) for n in names} == before

def test_stop_signals_puts_the_old_handlers_back_after_an_exception():
    before = signal.getsignal(signal.SIGINT)
    with pytest.raises(RuntimeError):
        with M.stop_signals(): raise RuntimeError('x')
    assert signal.getsignal(signal.SIGINT) is before

def test_stop_signals_outside_the_main_thread_changes_nothing():
    box = {}
    def work():
        before = signal.getsignal(signal.SIGINT)
        with M.stop_signals() as got: box['same'] = signal.getsignal(signal.SIGINT) is before; box['got'] = list(got)
    t = threading.Thread(target=work); t.start(); t.join(5); assert box == {'same': True, 'got': []}

# ---- main ----
@pytest.mark.parametrize('sig', [signal.SIGINT, signal.SIGTERM])
def test_a_server_that_stops_and_sends_its_signal_again_is_a_clean_shutdown_with_exit_0(tmp_path, sig, caplog):
    caplog.set_level('INFO', logger='ppe_host'); code, db = run_main(tmp_path, uvicorn_like(sig))
    assert code == 0 and ended_cleanly(db) and 'stopped by signal %s' % sig.name in caplog.text

def test_the_handlers_are_back_after_main_returns(tmp_path):
    before = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    run_main(tmp_path, uvicorn_like(signal.SIGINT)); assert {s: signal.getsignal(s) for s in before} == before

def test_a_keyboard_interrupt_that_reaches_main_is_still_a_clean_shutdown(tmp_path, caplog):
    async def serve(rt, host, port): raise KeyboardInterrupt()
    caplog.set_level('INFO', logger='ppe_host'); code, db = run_main(tmp_path, serve)
    assert code == 0 and ended_cleanly(db) and 'Ctrl+C' in caplog.text

def test_a_server_that_returns_by_itself_is_still_a_clean_shutdown(tmp_path):
    async def serve(rt, host, port): return None
    code, db = run_main(tmp_path, serve); assert code == 0 and ended_cleanly(db)

def test_a_crash_is_still_exit_1_and_leaves_the_session_open(tmp_path):
    async def serve(rt, host, port): raise RuntimeError('boom')
    code, db = run_main(tmp_path, serve)
    assert code == 1 and rows(db, "SELECT COUNT(*) FROM system_events WHERE kind = 'CLEAN_SHUTDOWN'")[0][0] == 0 and rows(db, 'SELECT COUNT(*) FROM sessions WHERE ended_ts IS NULL')[0][0] == 1

def test_a_failed_bind_is_still_exit_2(tmp_path):
    async def serve(rt, host, port): raise M.ServeError('port in use')
    code, db = run_main(tmp_path, serve); assert code == 2 and rows(db, "SELECT COUNT(*) FROM system_events WHERE kind = 'CLEAN_SHUTDOWN'")[0][0] == 0

# ---- a real host, a real Uvicorn, a real signal ----
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close(); return port

@pytest.mark.skipif(sys.platform == 'win32', reason='a console Ctrl+C cannot be sent to a child process like this on Windows (ADR 0060)')
@pytest.mark.parametrize('sig', [signal.SIGINT, signal.SIGTERM])
def test_a_real_host_stops_with_exit_0_and_a_clean_shutdown_row_on_a_real_signal(tmp_path, sig):
    h = home(tmp_path); (h / 'config' / 'settings.local.json').write_text(json.dumps({'bind_port': free_port()}))
    p = subprocess.Popen([sys.executable, '-m', 'ppe_host.main', '--home', str(h), '--mode', 'SIMULATOR', '--scenario', 'quiet'], cwd=str(HOST_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                         preexec_fn=lambda: signal.signal(signal.SIGINT, signal.default_int_handler))      # what a console gives a Python process
    lines, err = queue.Queue(), []
    def pump():
        for ln in p.stderr: err.append(ln); lines.put(ln)
    threading.Thread(target=pump, daemon=True).start()
    try:
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try: ln = lines.get(timeout=0.5)
            except queue.Empty:
                if p.poll() is not None: break
                continue
            if 'Uvicorn listening' in ln: break
        else: pytest.fail('the host did not start: ' + ''.join(err)[-800:])
        assert p.poll() is None, ''.join(err)[-800:]
        time.sleep(1.0); p.send_signal(sig)
        try: code = p.wait(timeout=30)
        except subprocess.TimeoutExpired: pytest.fail('the host did not stop: ' + ''.join(err)[-800:])
    finally:
        if p.poll() is None: p.kill(); p.wait()
    assert code == 0, (code, ''.join(err)[-800:])
    assert ended_cleanly(h / 'data' / 'ppe_test.db') and 'Traceback' not in ''.join(err)
