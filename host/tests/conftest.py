"""P8: suspect_frame_rule raises a one-shot notice on every suspect frame, so tests of the earlier rules that send suspect frames and compare exact
effects would see an extra RaiseAlert. Those tests are about other rules, so this fixture takes suspect_frame_rule out of RULES for them (the same approach
P7-2 and P7c-3 used for link_rule and shadow_rule). A test module that wants the rule sets SUSPECT_NOTICE_ON = True (test_seq_classifier.py and the golden-vector harness)."""
import pytest
from ppe_host.core import rule_engine as re_

@pytest.fixture(autouse=True)
def _suspect_notice_off(request, monkeypatch):
    if not getattr(request.module, 'SUSPECT_NOTICE_ON', False):
        monkeypatch.setattr(re_, 'RULES', tuple(r for r in re_.RULES if r is not re_.suspect_frame_rule))

@pytest.fixture(autouse=True)
def _silent_host_audio(monkeypatch):
    """main() builds a WinsoundBackend (P24-3c-3); a test of main() must never touch the sound card."""
    from ppe_host import main as M
    from fakeaudio import FakeBackend
    monkeypatch.setattr(M, 'make_audio_backend', lambda: FakeBackend())

@pytest.fixture(autouse=True)
def _no_real_watchdog_exit(monkeypatch):
    """main() hands the OS watchdog os._exit (P24b); a test that stalls on purpose must never kill the pytest process, so main.watchdog_exit becomes a recorder."""
    from ppe_host import main as M
    M.WATCHDOG_EXITS = []
    monkeypatch.setattr(M, 'watchdog_exit', lambda code: M.WATCHDOG_EXITS.append(code))

@pytest.fixture(autouse=True)
def _no_real_battery(monkeypatch):
    """HostHealth reads the laptop battery by default (P24b); a test must never depend on the machine it runs on."""
    from ppe_host.io import health
    monkeypatch.setattr(health, 'default_battery', lambda: (False, None))
