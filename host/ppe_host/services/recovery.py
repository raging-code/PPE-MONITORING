"""services/recovery.py (P25-1, ADR 0037): start-up step 11 of design 14.5, the rebuild of the engine state after a restart (section 1, Rev 3.40, 14.6).
The window is the trailing 30 minutes before anchor_ts, the rx_ts of the newest stored frame of any session (Rev 3.42: not before the restart, so an outage of up to 30 minutes never leaves it empty).
The stored frames of the window are fed in arrival order through the same step() as live frames, in rebuild mode (state only, every effect discarded: no row, no broadcast, no sound, no notice),
and through the sequence classifier, so the first live frame is judged against the right baseline. Nothing is written to the database and no event_seq is used.
What the rebuild decides, and why (ADR 0037):
 (1) It starts from an empty engine state, not from the open alerts loaded in step 9: a replayed rule could otherwise clear a loaded alert and raise a second one with a new row reference.
     When the window is replayed, the open alerts, open episodes, unauth fields and event_seq of the state it started with (the rows of step 9) replace whatever the replay made of them, so an
     alert or episode the replay raised that has no open row (the operator resolved it) never exists, and the references to the rows are the stored ones.
 (2) A node whose episode was resolved while its last frames still show mandown=1 keeps mandown_prev=1 from the replay, so its first live frame is a level and not an edge: no new episode.
 (3) Every timer of every node (a '*_mono' field, the heat history) is reset to None after the replay. Their values came from a clock that stopped for the length of the outage, so a node is not
     silent (SIGNAL LOST, LINK LOST) and its CO is not timed out because of the gap alone; its first fresh frame starts them again. The last values (levels, CO, edge memory) stay.
 (4) Monotonic stamps of earlier epochs are rebased with the mono_base_ms and wall_base_ms of the HOST_START row in force at the frame's event_seq (a Windows reboot inside the window resets time.monotonic()):
     wall time of the frame = wall_base + (rx_mono - mono_base), and its age is kept against the clock now. A frame older than every HOST_START uses its rx_ts.
 Only frames with verify = 'OK' are replayed: every other verify value is gated off (14.1) except the BAD_MAC unauth alert, whose state comes from the open row (1).
The work is chunked (2,000 rows per step_chunk) so the caller can yield to the event loop and touch the liveness stamps between chunks; run() does it in one go (tests), run_async() yields."""
import asyncio, bisect, json, logging
from dataclasses import dataclass, fields, replace
from ..core import crypto_abi as ca
from ..core import rule_engine as eng
from ..core.seq_classifier import SeqState, classify

log = logging.getLogger('ppe.recovery')
WINDOW_MS = 30 * 60 * 1000
CHUNK_ROWS = 2000
FRAME_SQL = 'SELECT frame_id, event_seq, rx_ts, rx_mono, raw_hex, seq_class FROM frames WHERE frame_id > ? AND rx_ts BETWEEN ? AND ? AND verify = \'OK\' ORDER BY frame_id LIMIT ?'
_TIMER_FIELDS = tuple(f.name for f in fields(eng.NodeState) if f.name.endswith('_mono') or '_since_mono' in f.name)

def anchor_ts(conn):
    """rx_ts of the newest stored frame row of any session (None for an empty table). frame_id grows with arrival, so this is one index step."""
    r = conn.execute('SELECT rx_ts FROM frames ORDER BY frame_id DESC LIMIT 1').fetchone()
    return None if r is None else r[0]

def first_frame_id(conn, roster, lo_ts):
    """Smallest frame_id with rx_ts >= lo_ts, found per node through idx_frames_node_ts (no scan of the whole table). 0 when no node has one."""
    ids = [r[0] for r in (conn.execute('SELECT MIN(frame_id) FROM frames WHERE node_id = ? AND rx_ts >= ?', (n, lo_ts)).fetchone() for n in roster) if r[0] is not None]
    return min(ids) if ids else None

@dataclass(frozen=True)
class Epoch:
    event_seq: int
    mono_base_ms: int
    wall_base_ms: int

def load_epochs(conn):
    """The HOST_START rows as Epochs in event_seq order. A row whose detail is not usable JSON is skipped."""
    out = []
    for seq, detail in conn.execute("SELECT event_seq, detail FROM system_events WHERE kind = 'HOST_START' ORDER BY event_seq"):
        try: d = json.loads(detail); out.append(Epoch(seq, int(d['mono_base_ms']), int(d['wall_base_ms'])))
        except (TypeError, ValueError, KeyError): log.warning('HOST_START at event_seq %s has no usable epoch', seq)
    return out

def rebased_mono(epochs, seqs, event_seq, rx_mono, rx_ts, now):
    """The frame's monotonic stamp in the current epoch (rule 4 of the module docstring). `seqs` is [e.event_seq for e in epochs]."""
    i = bisect.bisect_right(seqs, event_seq) - 1
    wall = rx_ts if i < 0 else epochs[i].wall_base_ms + (rx_mono - epochs[i].mono_base_ms)
    return now.mono_ms - (now.wall_ms - wall)

@dataclass
class RebuildReport:
    anchor_ts: int = None
    window_start_ts: int = None
    frames: int = 0                 # rows replayed through step()
    skipped: int = 0                # rows that no longer decode as OK (key changed, damaged raw_hex)
    chunks: int = 0
    nodes: frozenset = frozenset()  # nodes that had at least one frame in the window (Part 2: they show 'unconfirmed (host gap)')
    epochs: int = 0
    done: bool = False

def reset_timers(n):
    """Rule 3: every timer of the node back to 'not started'. Last values and edge memory are kept."""
    return replace(n, heat_hist=(), **{f: None for f in _TIMER_FIELDS})

class Rebuilder:
    """One rebuild. step_chunk() reads and replays up to `chunk` rows and returns True while more remain; the last call installs the result into the Ingest (under its lock) and sets report.done."""
    def __init__(self, ingest, conn, clock, chunk=CHUNK_ROWS, window_ms=WINDOW_MS):
        self.ing, self.conn, self.clock, self.chunk, self.window_ms = ingest, conn, clock, chunk, window_ms
        self.report, self._started = RebuildReport(), False
    def _start(self):
        self._started = True; r = self.report
        self.now = eng.Now(self.clock.wall_ms(), self.clock.mono_ms())
        self.epochs = load_epochs(self.conn); self.seqs = [e.event_seq for e in self.epochs]; r.epochs = len(self.epochs)
        self.state, self.cs, self.rank, self.last_id = eng.EngineState(), SeqState(), {}, 0
        r.anchor_ts = anchor_ts(self.conn)
        if r.anchor_ts is None: self.end = True; return
        r.window_start_ts = r.anchor_ts - self.window_ms; self.end = False
        fid = first_frame_id(self.conn, sorted(self.ing.roster), r.window_start_ts)
        if fid is None: self.end = True
        else: self.last_id = fid - 1
    def step_chunk(self):
        if not self._started: self._start()
        r = self.report
        if not self.end:
            rows = self.conn.execute(FRAME_SQL, (self.last_id, r.window_start_ts, r.anchor_ts, self.chunk)).fetchall(); r.chunks += 1
            for fid, seq, rx_ts, rx_mono, raw_hex, cls in rows: self._feed(seq, rx_ts, rx_mono, raw_hex, cls)
            if rows: self.last_id = rows[-1][0]
            if len(rows) < self.chunk: self.end = True
        if self.end: self._install(); r.done = True; return False
        return True
    def _feed(self, seq, rx_ts, rx_mono, raw_hex, cls):
        r = self.report
        try: raw = bytes.fromhex(raw_hex); res = ca.classify_frame(raw, self.ing.key, self.ing.sys_id)
        except (TypeError, ValueError): r.skipped += 1; return
        if res.result != 'OK' or res.node_id not in self.ing.roster: r.skipped += 1; return
        node, d = res.node_id, res.decoded; mono = rebased_mono(self.epochs, self.seqs, seq, rx_mono, rx_ts, self.now)
        lvl = d['flags'] & 3
        if lvl != 3: self.cs, _ = classify(self.cs, node, raw, d, mono)        # the baseline; the class used below is the stored one, as decided live
        self.state, fx = eng.step(self.state, eng.FrameEvent(node, 'OK', cls, d), eng.Now(rx_ts, mono), rebuild=True)
        assert fx == (), 'rebuild mode must return no effects'
        if lvl != 3: self.rank[node] = lvl
        r.frames += 1; r.nodes = r.nodes | {node}
    def _install(self):
        with self.ing._lock:
            base = self.ing.st; nodes = {}
            for nid, n in self.state.nodes.items():
                b = base.nodes.get(nid); n = reset_timers(n)
                nodes[nid] = n if b is None else replace(n, unauth_count=b.unauth_count, unauth_last_seen_ts=b.unauth_last_seen_ts)
            for nid, b in base.nodes.items(): nodes.setdefault(nid, reset_timers(b))
            st = replace(base, nodes=nodes)                          # alerts, episodes and event_seq stay those of step 9: rule 1
            for nid in nodes: st = eng.refresh_level(st, nid, self.rank.get(nid, 0), False)
            self.ing.st, self.ing.cs = st, self.cs
        log.info('step 11: rebuilt from %d frame(s) of %d node(s) in %d chunk(s), %d skipped', self.report.frames, len(self.report.nodes), self.report.chunks, self.report.skipped)
    def run(self, on_chunk=None):
        """All chunks in a row (tests, tools). on_chunk() is called after each chunk that has more to come."""
        while self.step_chunk():
            if on_chunk: on_chunk()
        return self.report
    async def run_async(self, on_chunk=None):
        """Step 11 on the event loop: one chunk, the liveness stamp (on_chunk), a yield, repeat."""
        while self.step_chunk():
            if on_chunk: on_chunk()
            await asyncio.sleep(0)
        return self.report
