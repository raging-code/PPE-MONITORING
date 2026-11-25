"""core/seq_classifier.py: the sequence classifier of design s01-sequence (Proposed, Rev 3.21), GV-11 to GV-14.
Pure: classify(state, node_id, raw, decoded, mono_ms) -> (new state, SeqResult). No file, clock, log or serial access: time arrives as mono_ms and the
shell writes the 'baseline re-established' log line when SeqResult.rebaselined is True. Run it on every frame with verify = OK, in arrival order, BEFORE
step(): the result's seq_class goes into FrameEvent and its frames_lost into the frames row. A frame with verify other than OK is never classified."""
from dataclasses import dataclass, field, replace
from typing import Mapping, NamedTuple, Optional
from .. import abi
from .. import constants as K

FRESH, REBOOT, DUPLICATE, SUSPECT = 'fresh', 'reboot', 'duplicate', 'suspect'
_SEQ, _BOOT = 65536, 256

@dataclass(frozen=True)
class SeqNode:
    boot_ctr: Optional[int] = None        # baseline: the last accepted frame (None = no frame accepted yet)
    seq: Optional[int] = None
    recent: tuple = ()                    # (boot_ctr, seq, raw bytes, mono_ms) of verified frames inside dedup_window_s (duplicate detection)
    run: int = 0                          # length of the current run of mutually continuous suspect frames (re-baseline after rebaseline_clean_frames)
    run_boot: Optional[int] = None        # the last suspect frame of that run
    run_seq: Optional[int] = None

@dataclass(frozen=True)
class SeqState:
    nodes: dict = field(default_factory=dict)         # node_id -> SeqNode

class SeqResult(NamedTuple):
    seq_class: str                        # fresh | reboot | duplicate | suspect
    frames_lost: int                      # counted on fresh frames only
    rebaselined: bool = False             # True on the frame accepted as fresh after a clean suspect run (the shell logs 'baseline re-established')

def reserved_bit_set(decoded):
    return any(decoded.get(f, 0) & m for f, m in abi.RESERVED_MASK.items())

def _boot_frame(decoded):
    """A frame that presents itself as a boot frame: seq 0 with the reboot hint (status2 bit 3). The hint stays set for 30 s after a boot, so the hint alone is not a boot frame."""
    shift, width = abi.BITS['status2']['reboot_hint']
    return decoded['seq'] == 0 and bool((decoded['status2'] >> shift) & 1)

def classify(state, node_id, raw, decoded, mono_ms):
    n, raw = state.nodes.get(node_id, SeqNode()), bytes(raw)
    boot, seq = decoded['boot_ctr'], decoded['seq']
    recent = tuple(r for r in n.recent if mono_ms - r[3] <= K.DEDUP_WINDOW_S * 1000)
    put = lambda node: replace(state, nodes={**state.nodes, node_id: node})
    if any(r[:3] == (boot, seq, raw) for r in recent):                              # duplicate: stored and flagged, never evaluated, baseline untouched
        return put(replace(n, recent=recent)), SeqResult(DUPLICATE, 0)
    n = replace(n, recent=recent + ((boot, seq, raw, mono_ms),))
    if reserved_bit_set(decoded):                                                   # suspect for a reason other than seq: the baseline and the run stay as they are
        return put(n), SeqResult(SUSPECT, 0)
    accept = lambda cls, lost, re=False: (put(replace(n, boot_ctr=boot, seq=seq, run=0, run_boot=None, run_seq=None)), SeqResult(cls, lost, re))
    if n.boot_ctr is None: return accept(FRESH, 0)                                  # the first verified frame ever seen sets the baseline
    db, ds = (boot - n.boot_ctr) % _BOOT, (seq - n.seq) % _SEQ
    if 1 <= db <= 127: return accept(REBOOT, 0)                                     # silence before a reboot is a gap, not packet loss
    if db == 0 and 1 <= ds <= 32767 and not _boot_frame(decoded): return accept(FRESH, ds - 1)
    cont = n.run > 0 and boot == n.run_boot and 1 <= (seq - n.run_seq) % _SEQ <= 32767   # suspect: backward seq, repeat, backward boot_ctr or a boot frame with an unchanged boot_ctr
    run = n.run + 1 if cont else 1
    if run >= K.REBASELINE_CLEAN_FRAMES: return accept(FRESH, 0, True)             # the third mutually continuous suspect frame is accepted as fresh
    return put(replace(n, run=run, run_boot=boot, run_seq=seq)), SeqResult(SUSPECT, 0)
