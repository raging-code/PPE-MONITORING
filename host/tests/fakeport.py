"""Test helpers for the serial layer (P12-1; P12-2 reuses them): a fake port that replays scripted chunks, and a builder for the frozen Frame JSON line."""
import json, threading

def frame_line(raw_hex, rssi=-68.5, snr=9.2, base_verify='OK', uptime_ms=12345, base_id=1):
    return (json.dumps({'v': 1, 'type': 'frame', 'base_id': base_id, 'uptime_ms': uptime_ms, 'rssi': rssi, 'snr': snr, 'base_verify': base_verify, 'raw_hex': raw_hex}) + '\n').encode()

def hb_line(uptime_ms=13000, bat_pct=85, rx_ok=412, rx_bad_len=0, rx_bad_crc=1, rx_bad_mac=0, beacon_tx=105, base_id=1):
    return (json.dumps({'v': 1, 'type': 'hb', 'base_id': base_id, 'uptime_ms': uptime_ms, 'bat_pct': bat_pct, 'rx_ok': rx_ok, 'rx_bad_len': rx_bad_len,
                        'rx_bad_crc': rx_bad_crc, 'rx_bad_mac': rx_bad_mac, 'beacon_tx': beacon_tx}) + '\n').encode()

class FakePort:
    """readline(size) behaves like pyserial: up to size bytes, stopping after an LF; b'' when nothing is left (a timeout). A script entry may also be an
    Exception instance: it is raised once (a pulled USB cable). `drained` is set when the script is used up."""
    def __init__(self, script):
        self.data, self.errors, self.closed, self.drained = bytearray(), [], False, threading.Event()
        self.script = list(script)
    def readline(self, size=-1):
        if not self.data:
            while self.script:
                s = self.script.pop(0)
                if isinstance(s, Exception): raise s
                self.data += s
                break
        if not self.data:
            self.drained.set(); threading.Event().wait(0.002); return b''
        n = self.data.find(b'\n') + 1 or len(self.data)
        n = min(n, size) if size and size > 0 else n
        out = bytes(self.data[:n]); del self.data[:n]; return out
    def close(self): self.closed = True
