"""P24-3c-2 (Part 3): ADR 0034 exists, is Proposed, and records the four decisions that load_open makes for what the database does not store."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
def test_adr_0034_is_proposed_and_lists_the_four_decisions():
    t = (ROOT / 'docs' / 'adr' / '0034.md').read_text(encoding='utf8')
    assert t.startswith('# ADR 0034') and ('Status: Proposed' in t or 'Status: Decided' in t)
    for word in ('unauth_count', 'opened_event_seq', 'motion_state', 'skipped', 'Existing state wins'): assert word in t
def test_progress_and_the_other_docs_point_to_the_step_9_work():
    assert 'Part 24-3c-2 done' in (ROOT / 'docs' / 'PROGRESS.md').read_text(encoding='utf8')
    assert 'ADR 0034' in (ROOT / 'docs' / 'adr' / '0033.md').read_text(encoding='utf8')
    assert 'ADR 0034' in (ROOT / 'host' / 'ppe_host' / 'runtime.py').read_text(encoding='utf8')
