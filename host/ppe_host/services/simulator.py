"""services/simulator.py (S7-1, ADR 0057): the SIMULATOR source of design 3.10 and 1 (Operating mode isolation).
It makes the same lines the base station would send: real 23-byte frames with CRC-8 and AES-128-CMAC for the nodes of the roster, and a base heartbeat every second.
Nothing here opens a port or a database. The SimulatorThread hands its items to the callback the SerialReader uses (Runtime.gate.on_item), so a simulated frame goes through the
pre-replay queue, verification, the seq classifier, the rules and the writer exactly like a live one, into the test database (Rev 3.40).

Pieces: encode_frame (fields to 23 bytes, the inverse of crypto_abi.decode_frame), SCENARIOS (quiet, co_ramp, man_down, link_loss, rehearsal), Schedule (what is due at a given time,
pure: the same scenario, seed and sequence of poll times always give the same bytes) and SimulatorThread (polls a Schedule against the injected Clock).

Timing rules of the Schedule. Each node sends one frame every routine_period_s (2 s) at its own seeded offset; seq is the slot number (from a seeded start), so every slot that is not sent
leaves a gap in seq. A node script may return None for a slot (silence: the base hears nothing). A poll that finds several slots due (the thread was paused, or the clock jumped) sends only the
newest slot of each node and one heartbeat, never a burst of old ones: the skipped slots are the seq gap the host sees after a silence."""
import random, threading
from .. import abi, constants as K
from ..core import crypto_abi as ca
from ..io.serial_reader import Frame, Heartbeat
from cryptography.hazmat.primitives.ciphers import algorithms
from cryptography.hazmat.primitives.cmac import CMAC

NODES = (1, 2, 3)                                   # the seeded roster (cli.seed_roster)
PERIOD_MS = K.ROUTINE_PERIOD_S * 1000
HB_PERIOD_MS = 1000                                 # the base heartbeat is 1 Hz (design 1, frozen heartbeat JSON)
DEFAULT_SCENARIO, DEFAULT_SEED = 'rehearsal', 1

def encode_frame(key, sys_id, node, seq, co_x10=0, temp_x100=2500, hum=50, hr=0, motion_x100=0, bat=80, status2=0, flags=0, scba=0, posture=0, link_ok=1, evt_unsent=0,\
                 uptime_s=100, status3=0, status4=0, boot_ctr=7):
    """23 bytes from field values: the layout comes from abi.FRAME_FIELDS, CRC-8 over bytes[0:18], mac4 = CMAC(key, sys_id || bytes[0:18])[:4]. id_mode = node + 0x08 scba + posture x 0x10 + 0x40 link_ok + 0x80 evt_unsent.
    A value that does not fit its field raises ValueError (the simulator never sends a frame that was cut short by accident)."""
    if not 1 <= node <= 7: raise ValueError('node must be 1 to 7')
    id_mode = node | (0x08 if scba else 0) | (posture << 4) | (0x40 if link_ok else 0) | (0x80 if evt_unsent else 0)
    v = dict(seq=seq, co_x10=co_x10, temp_x100=temp_x100, hum=hum, hr=hr, motion_x100=motion_x100, bat=bat, status2=status2, flags=flags, id_mode=id_mode, uptime_s=uptime_s, status3=status3, status4=status4, boot_ctr=boot_ctr)
    b = bytearray(abi.FRAME_BYTES)
    for name, val in v.items():
        o, n, signed = abi.FRAME_FIELDS[name]
        try: b[o:o + n] = int(val).to_bytes(n, 'little', signed=signed)
        except OverflowError: raise ValueError('%s=%r does not fit %d byte(s)' % (name, val, n)) from None
    lo, hi = abi.FRAME_CRC_RANGE; b[abi.FRAME_FIELDS['crc8'][0]] = ca.crc8(bytes(b[lo:hi]))
    m = CMAC(algorithms.AES(bytes(key))); m.update(bytes([sys_id]) + bytes(b[lo:hi])); o = abi.FRAME_FIELDS['mac4'][0]; b[o:o + ca.MAC_BYTES] = m.finalize()[:ca.MAC_BYTES]
    return bytes(b)

# ---- node scripts: (node, t_s, rng) -> dict of encode_frame fields (plus rssi, snr), or None for silence. t_s is the node's own scenario time, after the scenario's shift. ----
def _bits(field, **kw): return sum(v << abi.BITS[field][k][0] for k, v in kw.items())
LEVEL = abi.ENUMS['node_level']; POSTURE = abi.ENUMS['posture']; ACTIVITY = abi.ENUMS['activity']
HR_OK = _bits('status2', hr_ok=1, wrist_ok=1)

def _calm(node, t, rng, **over):
    """A node that is working and moving: CO near zero, upright, active, a heart rate, the battery falling slowly."""
    s = dict(co_x10=int(rng.uniform(0.5, 3.0) * 10), temp_x100=2350 + 120 * node + rng.randint(-30, 30), hum=rng.randint(45, 55), hr=68 + 6 * node + rng.randint(-5, 5), motion_x100=rng.randint(15, 60),
             bat=max(25, 90 - node - int(t) // 900), status2=HR_OK, flags=_bits('flags', activity=ACTIVITY['ACTIVE']), posture=POSTURE['UPRIGHT'], uptime_s=(1000 + 100 * node + int(t)) & 0xFFFF,
             rssi=round(-62 - 4 * node + rng.uniform(-3, 3), 1), snr=round(9.0 - node + rng.uniform(-1, 1), 1))
    s.update(over); return s

def quiet(node, t, rng): return _calm(node, t, rng)

CO_RAMP = ((0, 5.0), (10, 5.0), (40, 60.0), (70, 230.0), (100, 230.0), (130, 10.0), (140, 5.0))     # (t_s, ppm): rises through the warning and the danger threshold, holds, falls back
def co_ppm(t):
    """The CO of the ramp at t seconds (linear between the points above; the last value afterwards)."""
    for (t0, c0), (t1, c1) in zip(CO_RAMP, CO_RAMP[1:]):
        if t < t1: return c0 + (c1 - c0) * (t - t0) / (t1 - t0)
    return CO_RAMP[-1][1]
def co_level(t):
    """node_level as the firmware reports it: the warning and danger thresholds on the way up, the lower clear thresholds on the way down."""
    c = co_ppm(t); falling = t >= 100
    if c >= (K.CO_DANGER_CLEAR_PPM if falling else K.CO_DANGER_PPM): return LEVEL['DANGER']
    if c >= (K.CO_WARN_CLEAR_PPM if falling else K.CO_WARN_PPM): return LEVEL['WARNING']
    return LEVEL['NORMAL']

def co_ramp(node, t, rng):
    c = co_ppm(t)
    return _calm(node, t, rng, co_x10=min(int(c * 10 + rng.uniform(-3, 3)), 0xFFFF) if c > 6 else int(c * 10), flags=_bits('flags', node_level=co_level(t), activity=ACTIVITY['ACTIVE']))

FALL_T, STILL_END_T, RESCUE_T = 20, 20 + K.MANDOWN_STILL_S + 2, 20 + K.MANDOWN_STILL_S + 2 + 58   # a fall at 20 s, the man-down latch at 52 s, the rescue at 110 s
def man_down(node, t, rng):
    """Falls at 20 s (activity FALL_SUSPECTED, horizontal), lies still, the node latches man-down (flags bit 2, node_level DANGER) after mandown_still_s, and is back on its feet at 110 s."""
    if t < FALL_T or t >= RESCUE_T: return _calm(node, t, rng)
    if t < FALL_T + 2: return _calm(node, t, rng, motion_x100=80, posture=POSTURE['HORIZONTAL'], flags=_bits('flags', activity=ACTIVITY['FALL_SUSPECTED']))
    still = dict(motion_x100=0, posture=POSTURE['HORIZONTAL'], status3=_bits('status3', still_now=1))
    if t < STILL_END_T: return _calm(node, t, rng, flags=_bits('flags', activity=ACTIVITY['STILL']), **still)
    return _calm(node, t, rng, flags=_bits('flags', node_level=LEVEL['DANGER'], mandown=1, activity=ACTIVITY['STILL']), **still)

SILENT_FROM_T, SILENT_TO_T = 20, 95
def link_loss(node, t, rng):
    """The signal fades from 10 s, the base hears nothing from 20 s to 95 s (SIGNAL LOST after 15 s of silence, LINK LOST after 60 s), then the node is heard again with a seq gap."""
    if SILENT_FROM_T <= t < SILENT_TO_T: return None
    s = _calm(node, t, rng)
    if 10 <= t < SILENT_FROM_T: s.update(rssi=round(s['rssi'] - 4 * (t - 10), 1), snr=round(s['snr'] - 0.8 * (t - 10), 1))
    return s

SCENARIOS = {                                       # name: {node: (script, shift_s)}; a node that is not named is quiet
    'quiet': {},
    'co_ramp': {1: (co_ramp, 0)},
    'man_down': {2: (man_down, 0)},
    'link_loss': {3: (link_loss, 0)},
    'rehearsal': {1: (co_ramp, 0), 2: (man_down, 60), 3: (link_loss, 120)},       # CO warning near 26 s and danger near 65 s, man-down near 112 s, link loss from 140 s; all back to normal by about 215 s
}

def _rng(seed, *parts): return random.Random(':'.join(str(p) for p in (seed,) + parts))     # a str seed is hashed with SHA-512: the same on every run and every machine

class Schedule:
    """What the base would have sent up to a given time. poll(t_ms) takes the time since the start (never backwards: an earlier value is treated as the last one) and returns the new items in time order, as
    ('hb', Heartbeat) and ('frame', Frame) pairs, the same kinds the SerialReader gives its callback. Per node and per poll at most one frame (the newest due slot); one heartbeat per poll at most."""
    def __init__(self, scenario, seed, key, sys_id, base_id=1, nodes=NODES):
        if scenario not in SCENARIOS: raise ValueError('unknown scenario %r (choose from %s)' % (scenario, ', '.join(SCENARIOS)))
        if isinstance(seed, bool) or not isinstance(seed, int): raise ValueError('seed must be an integer')
        self.scenario, self.seed, self.key, self.sys_id, self.base_id, self.nodes = scenario, seed, bytes(key), sys_id, base_id, tuple(nodes)
        r = _rng(seed, 'schedule')
        self._offset = {n: r.randrange(0, PERIOD_MS) for n in self.nodes}           # each node's place inside the 2 s period
        self._seq0 = {n: r.randrange(0, 60000) for n in self.nodes}
        self._boot = {n: r.randrange(1, 200) for n in self.nodes}
        self._base_up0 = r.randrange(60, 3600) * 1000                               # the base has been up for a while
        self._last_slot, self._next_hb, self._t, self.rx_ok = {n: -1 for n in self.nodes}, 0, 0, 0
        self.sent = {n: 0 for n in self.nodes}
    def script_of(self, node): return SCENARIOS[self.scenario].get(node, (quiet, 0))
    def sample(self, node, slot):
        """The fields of one node's frame in one slot (pure), or None when the node is silent then. Returns a dict for encode_frame plus rssi and snr."""
        script, shift = self.script_of(node); t_ms = slot * PERIOD_MS + self._offset[node]
        return script(node, t_ms / 1000.0 - shift, _rng(self.seed, node, slot))
    def frame_bytes(self, node, slot):
        s = self.sample(node, slot)
        if s is None: return None
        f = {k: v for k, v in s.items() if k not in ('rssi', 'snr')}
        return encode_frame(self.key, self.sys_id, node, (self._seq0[node] + slot) & 0xFFFF, boot_ctr=self._boot[node], **f)
    def poll(self, t_ms):
        t_ms = max(int(t_ms), self._t); self._t = t_ms; out = []; base_up = self._base_up0 + t_ms
        for n in self.nodes:
            if t_ms < self._offset[n]: continue
            slot = (t_ms - self._offset[n]) // PERIOD_MS
            if slot <= self._last_slot[n]: continue
            self._last_slot[n] = slot                                              # slots between the last one and this one are skipped, not sent late
            raw = self.frame_bytes(n, slot)
            if raw is None: continue
            s = self.sample(n, slot); self.rx_ok += 1; self.sent[n] += 1
            out.append(('frame', Frame(raw, 'OK', s['rssi'], s['snr'], self.base_id, base_up)))
        if t_ms >= self._next_hb:
            self._next_hb = (t_ms // HB_PERIOD_MS + 1) * HB_PERIOD_MS              # one heartbeat after a pause, then back on the second
            out.append(('hb', Heartbeat(self.base_id, base_up, max(20, 90 - t_ms // 1_800_000), self.rx_ok, 0, 0, 0, base_up // 125)))
        return out

class SimulatorThread:
    """Polls a Schedule against the injected Clock (its mono_ms, so a FakeClock steps it and a REPLAY-style clock could scale it) and gives every item to on_item(kind, payload), the SerialReader callback.
    time 0 is the first poll. A failing handler is counted and never stops the thread. polls counts finished passes (a test steps the clock and waits for it to move). stop() ends it before the writer is stopped."""
    def __init__(self, clock, on_item, key, sys_id, scenario=DEFAULT_SCENARIO, seed=DEFAULT_SEED, base_id=1, poll_s=0.1, on_alive=None):
        self.clock, self.on_item, self.poll_s, self.on_alive = clock, on_item, poll_s, on_alive or (lambda: None)
        self.schedule = Schedule(scenario, seed, key, sys_id, base_id)
        self.counters = {'sim_frames': 0, 'sim_heartbeats': 0, 'sim_handler_errors': 0}
        self.polls, self.last_error, self._t0 = 0, None, None
        self._stop = threading.Event(); self._thread = threading.Thread(target=self._run, name='SimulatorThread', daemon=True)
    @property
    def scenario(self): return self.schedule.scenario
    @property
    def seed(self): return self.schedule.seed
    def start(self): self._thread.start(); return self
    def alive(self): return self._thread.is_alive()
    def stop(self, timeout_s=2): self._stop.set(); self._thread.join(timeout_s)
    def _run(self):
        self._t0 = self.clock.mono_ms()
        while not self._stop.is_set():
            self.on_alive()
            for kind, payload in self.schedule.poll(self.clock.mono_ms() - self._t0):
                if self._stop.is_set(): break
                try: self.on_item(kind, payload)
                except Exception as e: self.counters['sim_handler_errors'] += 1; self.last_error = repr(e)
                else: self.counters['sim_frames' if kind == 'frame' else 'sim_heartbeats'] += 1
            self.polls += 1
            self._stop.wait(self.poll_s)
