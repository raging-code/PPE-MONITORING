"""io/serial_reader.py (P12-1): the serial line layer of design 1 (Serial layer, frozen Base-to-Host JSON ABI).
Pieces: LineAssembler (bytes to lines, bounded), parse_line (one line to a Frame or Heartbeat), open_serial (DTR and RTS False before open),
SerialReader (the dedicated reader thread: bounded readline, retry every serial_retry_s, SERIAL_LOST / SERIAL_BACK reported once per outage).
Nothing here verifies a frame or touches the database: the ingest pipeline (P12-2) receives items through the on_item callback.
Line rule: a line whose content (without LF or CR) is 512 bytes or more is discarded up to the next LF and counted once as serial_framing_errors.
Lines are decoded with errors='replace'. Partial lines, bad JSON and binary garbage are counted in serial_bad_lines and dropped."""
import json, math, threading
from typing import NamedTuple, Optional
from .. import constants as K

READ_SIZE = K.MAX_LINE_BYTES + 1          # readline(513): max_line_bytes + 1
VERIFY_VALUES = ('OK', 'BAD_LEN', 'BAD_CRC', 'BAD_MAC')
HB_FIELDS = ('base_id', 'uptime_ms', 'bat_pct', 'rx_ok', 'rx_bad_len', 'rx_bad_crc', 'rx_bad_mac', 'beacon_tx')
HEX = frozenset('0123456789abcdefABCDEF')

class Frame(NamedTuple):
    raw: bytes                     # the frame bytes as the base forwarded them (any length: BAD_LEN frames are forwarded too)
    base_verify: str               # the base's own result: OK | BAD_LEN | BAD_CRC | BAD_MAC
    rssi: Optional[float]
    snr: Optional[float]
    base_id: int
    base_uptime_ms: int

class Heartbeat(NamedTuple):
    base_id: int
    uptime_ms: int
    bat_pct: int
    rx_ok: int
    rx_bad_len: int
    rx_bad_crc: int
    rx_bad_mac: int
    beacon_tx: int

class LineAssembler:
    """Turns the chunks that readline(513) returns into lines, never holding 512 bytes or more. feed() returns a list of ('line', bytes) and
    ('framing', None) items. One oversized line gives one 'framing' item, however many chunks it spans. Feeding the same bytes in any chunking gives the same items."""
    def __init__(self): self.buf, self.discarding = bytearray(), False
    def feed(self, chunk):
        out, chunk = [], bytes(chunk)
        while chunk:
            i = chunk.find(b'\n')
            part, chunk = (chunk, b'') if i < 0 else (chunk[:i], chunk[i + 1:])
            if self.discarding:
                if i >= 0: self.discarding = False                  # the LF that ends the oversized line
                continue
            self.buf += part
            if len(self.buf.rstrip(b'\r')) >= K.MAX_LINE_BYTES:
                out.append(('framing', None)); self.buf.clear(); self.discarding = i < 0
            elif i >= 0:
                out.append(('line', bytes(self.buf))); self.buf.clear()
        return out

def _int(v): return isinstance(v, int) and not isinstance(v, bool) and v >= 0
def _num(v): return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

def parse_line(line):
    """One line (bytes or str) to ('frame', Frame), ('hb', Heartbeat), ('empty', None) or ('bad', reason). Never raises."""
    try:
        text = line.decode('utf-8', errors='replace') if isinstance(line, (bytes, bytearray)) else str(line)
        text = text.strip('\r\n\x00 \t')
        if not text: return 'empty', None
        try: d = json.loads(text)
        except (ValueError, RecursionError): return 'bad', 'bad_json'
        if not isinstance(d, dict): return 'bad', 'not_object'
        if d.get('v') != 1 or isinstance(d.get('v'), bool): return 'bad', 'bad_version'
        t = d.get('type')
        if t == 'frame':
            h, bv = d.get('raw_hex'), d.get('base_verify')
            if not (isinstance(h, str) and len(h) % 2 == 0 and set(h) <= HEX and bv in VERIFY_VALUES and _int(d.get('base_id')) and _int(d.get('uptime_ms'))): return 'bad', 'bad_frame'
            rssi, snr = d.get('rssi'), d.get('snr')
            if (rssi is not None and not _num(rssi)) or (snr is not None and not _num(snr)): return 'bad', 'bad_frame'
            return 'frame', Frame(bytes.fromhex(h), bv, None if rssi is None else float(rssi), None if snr is None else float(snr), d['base_id'], d['uptime_ms'])
        if t == 'hb':
            if not all(_int(d.get(k)) for k in HB_FIELDS): return 'bad', 'bad_hb'
            return 'hb', Heartbeat(*(d[k] for k in HB_FIELDS))
        return 'bad', 'unknown_type'
    except Exception: return 'bad', 'bad_line'        # defensive: the parser must never kill the reader thread

def open_serial(port, baud=K.SERIAL_BAUD, timeout_s=0.5, write_timeout_s=None, serial_module=None):
    """Open a pyserial port with DTR and RTS set False BEFORE open (design 1: a DTR or RTS pulse resets an ESP32). The port is created unopened
    (Serial() with no port argument), configured, then opened. timeout_s lets the reader thread see a stop request; write_timeout_s is for P12b's writer thread."""
    if serial_module is None:
        import serial as serial_module
    ser = serial_module.Serial()
    ser.port, ser.baudrate, ser.timeout = port, baud, timeout_s
    if write_timeout_s is not None: ser.write_timeout = write_timeout_s
    ser.dtr = False; ser.rts = False
    ser.open()
    return ser

class SerialReader:
    """The dedicated reader thread. open_port() returns an object with readline(size) -> bytes (b'' on timeout) and close().
    on_item(kind, payload) gets 'frame' and 'hb' items on this thread; on_link(event, detail) gets 'SERIAL_LOST' (detail 'open' or 'read') once per outage
    and 'SERIAL_BACK' when reading resumes after one. The first successful open is not a SERIAL_BACK."""
    def __init__(self, open_port, on_item, on_link=None, retry_s=K.SERIAL_RETRY_S):
        self.open_port, self.on_item, self.on_link, self.retry_s = open_port, on_item, on_link or (lambda e, d: None), retry_s
        self.counters = {'serial_framing_errors': 0, 'serial_bad_lines': 0, 'serial_lines_ok': 0, 'serial_handler_errors': 0}
        self.lost, self.port, self.last_error = False, None, None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name='SerialReaderThread', daemon=True)
    def start(self): self._thread.start(); return self
    def stop(self, timeout_s=2):
        self._stop.set(); self._thread.join(timeout_s)
        p = self.port
        if p is not None:
            try: p.close()
            except Exception: pass
    def alive(self): return self._thread.is_alive()

    def _lose(self, detail):
        if not self.lost: self.lost = True; self.on_link('SERIAL_LOST', detail)
    def _run(self):
        asm = LineAssembler()
        while not self._stop.is_set():
            try: self.port = self.open_port()
            except Exception as e:
                self.last_error = repr(e); self._lose('open'); self._stop.wait(self.retry_s); continue
            if self.lost: self.lost = False; self.on_link('SERIAL_BACK', None)
            asm = LineAssembler()                                   # a reopened port starts on a clean line boundary
            try:
                while not self._stop.is_set():
                    chunk = self.port.readline(READ_SIZE)
                    if chunk: self._items(asm.feed(chunk))
            except Exception as e:
                self.last_error = repr(e); self._lose('read')
            try: self.port.close()
            except Exception: pass
            self.port = None
            if not self._stop.is_set(): self._stop.wait(self.retry_s)
    def _items(self, items):
        c = self.counters
        for kind, data in items:
            if kind == 'framing': c['serial_framing_errors'] += 1; continue
            k, p = parse_line(data)
            if k == 'empty': continue
            if k == 'bad': c['serial_bad_lines'] += 1; continue
            c['serial_lines_ok'] += 1
            try: self.on_item(k, p)
            except Exception as e: c['serial_handler_errors'] += 1; self.last_error = repr(e)      # a bad handler never stops the reader
