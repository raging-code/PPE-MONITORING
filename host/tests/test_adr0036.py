"""P24b-4: ADR 0036 exists, is Proposed and records the watchdog, marker and host health decisions; PROGRESS and the other docs point to it."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
def test_adr_0036_is_proposed_and_lists_the_decisions():
    t = (ROOT / 'docs' / 'adr' / '0036.md').read_text(encoding='utf8')
    assert t.startswith('# ADR 0036') and ('Status: Proposed' in t or 'Status: Decided' in t)
    for word in ('OSWatchdogThread', 'crash_marker.json', 'LIVENESS_RESTART', 'TICK_STALL', 'loop_beat', 's.path', 'HostHealth', 'host_power', 'QUEUE_OVERFLOW', 'DISK_LOW', 'HOST_BATTERY', 'LOGGING_FAULT', 'psutil'): assert word in t
def test_progress_and_the_other_docs_point_to_the_p24b_work():
    assert 'Part 24b done' in (ROOT / 'docs' / 'PROGRESS.md').read_text(encoding='utf8')
    assert 'ADR 0036' in (ROOT / 'docs' / 'adr' / '0035.md').read_text(encoding='utf8')
    assert 'ADR 0036' in (ROOT / 'host' / 'ppe_host' / 'serve.py').read_text(encoding='utf8')
    assert 'ADR 0036' in (ROOT / 'host' / 'ppe_host' / 'io' / 'os_watchdog.py').read_text(encoding='utf8')
