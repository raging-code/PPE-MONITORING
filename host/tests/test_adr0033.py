"""P24-3b-2b-iii: ADR 0033 exists, is Proposed, and keeps the unpersisted decision open (ADR 0032 and 0033 must not drift apart)."""
from pathlib import Path
ADR = Path(__file__).resolve().parents[2] / 'docs' / 'adr'
def test_adr_0033_is_proposed_and_keeps_unpersisted_open():
    t = (ADR / '0033.md').read_text(encoding='utf8')
    assert t.startswith('# ADR 0033') and ('Status: Proposed' in t or 'Status: Decided' in t) and 'unpersisted' in t and 'OPEN' in t
def test_adr_0032_points_to_0033():
    assert 'ADR 0033' in (ADR / '0032.md').read_text(encoding='utf8')
