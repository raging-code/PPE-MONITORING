"""services/serial_drain.py (S7-2, ADR 0058): the serial drain of design 3.10 and 1 (Operating mode isolation).
In SIMULATOR and REPLAY the host still reads the base station's serial line, but only to find out that live hardware is sending. Nothing read here is ingested: no frame, no heartbeat, no
count reaches the rule engine, the gate or the database, and nothing is ever written to the port. When a frame arrives that the host itself verifies (23 bytes, CRC-8 and AES-CMAC with this
host's key and sys_id, the same check as ingest) the detector writes one LIVE_FRAME_IN_TEST_MODE row (not droppable) and logs an error.
Rate rule: the first valid frame writes a row at once; after that at most one row per ALERT_EVERY_S (60 s of the injected Clock's mono time), whose detail counts the valid frames since the last row,
so a base that sends all day gives a few rows an hour, not one per frame. A frame that does not verify (BAD_LEN, BAD_CRC, BAD_MAC, a frame of another sys_id or key) is counted and ignored:
only valid MAC-verified frames are evidence of live hardware of this system. Heartbeats are counted and ignored (a base with no node in range still sends them, but that is not node traffic)."""
import json, logging, threading
from ..core import crypto_abi as ca

log = logging.getLogger('ppe.drain')
ALERT_EVERY_S = 60

class LiveTrafficDetector:
    """on_item(kind, payload) is the SerialReader callback of the drain. emit(kind, detail, droppable) is Ingest.system_event. Called from the drain thread only; the counters are read by tests."""
    def __init__(self, clock, emit, key, sys_id, every_s=ALERT_EVERY_S):
        self.clock, self.emit, self.key, self.sys_id, self.every_ms = clock, emit, bytes(key), sys_id, int(every_s * 1000)
        self.counters = {'drain_frames': 0, 'drain_valid': 0, 'drain_heartbeats': 0, 'drain_events': 0}
        self._pending, self._last_ms = 0, None
        self._lock = threading.Lock()
    def on_item(self, kind, payload):
        with self._lock:
            if kind == 'hb': self.counters['drain_heartbeats'] += 1; return
            if kind != 'frame': return
            self.counters['drain_frames'] += 1
            try: ok = ca.verify_frame(payload.raw, self.key, self.sys_id) == 'OK'
            except Exception: ok = False                                       # the detector must never raise into the reader
            if not ok: return
            self.counters['drain_valid'] += 1; self._pending += 1
            now = self.clock.mono_ms()
            if self._last_ms is not None and 0 <= now - self._last_ms < self.every_ms: return
            n, self._pending, self._last_ms = self._pending, 0, now
            detail = json.dumps({'node_id': ca.node_id_of(payload.raw), 'base_id': payload.base_id, 'valid_frames': n, 'seq': ca.decode_frame(payload.raw)['seq']}, sort_keys=True, separators=(',', ':'))
        log.error('LIVE_FRAME_IN_TEST_MODE: %s', detail)
        self.emit('LIVE_FRAME_IN_TEST_MODE', detail, False)
        with self._lock: self.counters['drain_events'] += 1
