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
