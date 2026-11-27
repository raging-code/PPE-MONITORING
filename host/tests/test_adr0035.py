"""P24-3c-3 (Part 4): ADR 0035 exists, is Proposed, and records the step 10, exit code, thread bridge and AudioThread decisions; PROGRESS and the other docs point to it."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
def test_adr_0035_is_proposed_and_lists_the_decisions():
    t = (ROOT / 'docs' / 'adr' / '0035.md').read_text(encoding='utf8')
    assert t.startswith('# ADR 0035') and 'Status: Proposed' in t
    for word in ('ServeError', 'exits with code 2', 'LoopHub', 'call_soon_threadsafe', 'audio_items', 'RECOVERING', 'HOST BATTERY', 'tab_counter', 'unpersisted'): assert word in t
def test_progress_and_the_other_docs_point_to_the_step_10_work():
    assert 'Part 24-3c-3 done' in (ROOT / 'docs' / 'PROGRESS.md').read_text(encoding='utf8')
    assert 'ADR 0035' in (ROOT / 'docs' / 'adr' / '0033.md').read_text(encoding='utf8')
    assert 'ADR 0035' in (ROOT / 'host' / 'ppe_host' / 'serve.py').read_text(encoding='utf8')
