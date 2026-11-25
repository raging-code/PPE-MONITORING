"""P12-1: serial line layer (design 1, Serial layer): bounded lines, frozen JSON parsing, DTR and RTS False before open, reader thread outage handling, fuzz.
The fuzz tests use a seeded random generator, so a failure repeats exactly."""
import json, random, time
from pathlib import Path
from ppe_host.io.serial_reader import LineAssembler, parse_line, open_serial, SerialReader, Frame, Heartbeat, READ_SIZE
from fakeport import FakePort, frame_line, hb_line

VECTORS = Path(__file__).resolve().parents[2] / 'shared' / 'vectors' / 'frames.json'
DESIGN_FRAME = b'{"v":1,"type":"frame","base_id":1,"uptime_ms":12345,"rssi":-68.5,"snr":9.2,"base_verify":"OK","raw_hex":"0100"}\n'
DESIGN_HB = b'{"v":1,"type":"hb","base_id":1,"uptime_ms":13000,"bat_pct":85,"rx_ok":412,"rx_bad_len":0,"rx_bad_crc":1,"rx_bad_mac":0,"beacon_tx":105}\n'

def until(cond, t=3.0):
    end = time.time() + t
    while time.time() < end:
        if cond(): return True
        time.sleep(0.005)
    return cond()

def test_the_frozen_frame_and_heartbeat_lines_parse():
    k, f = parse_line(DESIGN_FRAME); assert k == 'frame' and f == Frame(b'\x01\x00', 'OK', -68.5, 9.2, 1, 12345)
    k, h = parse_line(DESIGN_HB); assert k == 'hb' and h == Heartbeat(1, 13000, 85, 412, 0, 1, 0, 105)

def test_every_vector_survives_the_json_round_trip_including_bad_length_frames():
    for f in json.load(open(VECTORS))['frames']:
        k, p = parse_line(frame_line(f['hex'], base_verify='BAD_LEN' if f['expect']['result'] == 'BAD_LEN' else 'OK'))
        assert k == 'frame' and p.raw == bytes.fromhex(f['hex']), f['id']       # a 22-byte or 24-byte frame is forwarded and parsed, never dropped here
    assert parse_line(frame_line(''))[0] == 'frame'                             # an empty frame is a BAD_LEN row, not a parser error

def test_bad_lines_are_dropped_with_a_reason_and_never_raise():
    bad = {b'{"v":1,"type":"fra': 'bad_json', b'\xff\xfe\x00garbage\x80': 'bad_json', b'[1,2]': 'not_object', b'{"v":2,"type":"hb"}': 'bad_version',
           b'{"v":true,"type":"hb"}': 'bad_version', b'{"v":1,"type":"zzz"}': 'unknown_type', b'{"v":1}': 'unknown_type',
           frame_line('0'): 'bad_frame', frame_line('zz'): 'bad_frame', frame_line('00', base_verify='MAYBE'): 'bad_frame', frame_line('00', rssi='x'): 'bad_frame',
           frame_line('00', base_id=True): 'bad_frame', frame_line('00', uptime_ms=-1): 'bad_frame', b'{"v":1,"type":"hb","base_id":1}': 'bad_hb',
           b'{"v":1,"type":"frame","base_id":1,"uptime_ms":1,"base_verify":"OK","raw_hex":"00","rssi":NaN}': 'bad_frame'}
    for line, why in bad.items(): assert parse_line(line) == ('bad', why), (line, parse_line(line))
    assert parse_line(b'\r\n') == ('empty', None) and parse_line(b'') == ('empty', None)

def test_line_length_rule_511_passes_512_or_more_is_one_framing_error_and_the_next_line_survives():
    a = LineAssembler(); ok = b'x' * 511
    assert a.feed(ok + b'\n') == [('line', ok)]
    assert a.feed(b'x' * 512 + b'\n' + DESIGN_FRAME) == [('framing', None), ('line', DESIGN_FRAME[:-1])]
    boot = LineAssembler(); out = []
    for i in range(0, 5000, 513): out += boot.feed(b'\x9f' * min(513, 5000 - i))     # ROM boot garbage: no LF for 5000 bytes
    out += boot.feed(b'\n' + DESIGN_FRAME)
    assert out == [('framing', None), ('line', DESIGN_FRAME[:-1])]                    # one error for the whole run, memory never above the cap
    assert len(boot.buf) == 0

def test_fuzz_chunking_never_changes_the_result_and_the_buffer_stays_bounded():
    rnd = random.Random(12)
    pieces = [DESIGN_FRAME, DESIGN_HB, b'\n', b'\r\n', b'{"v":1', b'\xff\xfe', b'x' * 511 + b'\n', b'x' * 600 + b'\n', b'y' * 1500]
    for _ in range(300):
        stream = b''.join(rnd.choice(pieces) if rnd.random() < .7 else bytes(rnd.randrange(256) for _ in range(rnd.randrange(0, 40))) for _ in range(rnd.randrange(1, 25)))
        whole = LineAssembler().feed(stream); a, got, i = LineAssembler(), [], 0
        while i < len(stream):
            n = rnd.randrange(1, READ_SIZE + 1); got += a.feed(stream[i:i + n]); i += n; assert len(a.buf) < 512
        assert got == whole
        assert all(len(d.rstrip(b'\r')) < 512 for k, d in whole if k == 'line')

def test_fuzz_parse_line_never_raises_on_random_input():
    rnd = random.Random(7); seeds = [DESIGN_FRAME, DESIGN_HB]
    for _ in range(20000):
        b = bytearray(rnd.choice(seeds) if rnd.random() < .5 else b''.join(bytes([rnd.randrange(256)]) for _ in range(rnd.randrange(0, 60))))
        for _ in range(rnd.randrange(0, 4)):
            if b: b[rnd.randrange(len(b))] = rnd.randrange(256)
        assert parse_line(bytes(b))[0] in ('frame', 'hb', 'bad', 'empty')

class FakeSerialModule:
    """Records every call and attribute set on the port, in order."""
    calls = []
    class Serial:
        def __init__(self, *a, **kw): FakeSerialModule.calls.append(('init', a, kw))
        def __setattr__(self, k, v): FakeSerialModule.calls.append(('set', k, v)); object.__setattr__(self, k, v)
        def open(self): FakeSerialModule.calls.append(('open',))

def test_the_port_is_opened_with_dtr_and_rts_false_set_before_the_open_call():
    FakeSerialModule.calls = []; ser = open_serial('COM4', 115200, write_timeout_s=0.2, serial_module=FakeSerialModule)
    c = FakeSerialModule.calls; names = [x[1] if x[0] == 'set' else x[0] for x in c]
    assert c[0] == ('init', (), {})                                                       # created unopened: Serial(port) would open at once, with DTR and RTS asserted
    assert ('set', 'dtr', False) in c and ('set', 'rts', False) in c and ('set', 'port', 'COM4') in c and ('set', 'baudrate', 115200) in c and ('set', 'write_timeout', 0.2) in c
    assert names.index('dtr') < names.index('open') and names.index('rts') < names.index('open') and names[-1] == 'open' and names.count('open') == 1

def run_reader(ports, **kw):
    items, links = [], []; it = iter(ports)
    def open_port():
        p = next(it)
        if isinstance(p, Exception): raise p
        return p
    r = SerialReader(open_port, lambda k, p: items.append((k, p)), lambda e, d: links.append((e, d)), retry_s=0.005, **kw).start()
    return r, items, links

def test_boot_garbage_without_a_newline_counts_one_framing_error_and_never_blocks_the_reader():
    port = FakePort([b'\xe9\x00\x1f' * 2000 + b'\n', frame_line('0100'), hb_line()])
    r, items, links = run_reader([port]); assert until(lambda: len(items) == 2 and port.drained.is_set())
    assert [k for k, _ in items] == ['frame', 'hb'] and r.counters['serial_framing_errors'] == 1 and r.counters['serial_bad_lines'] == 0 and r.alive() and links == []
    r.stop(); assert not r.alive() and port.closed

def test_partial_lines_bad_json_and_garbage_are_counted_and_the_good_lines_around_them_arrive():
    port = FakePort([b'{"v":1,"ty\n', frame_line('01'), b'\xff\xfe\x00\n', b'\n', hb_line(), b'not json\n'])
    r, items, links = run_reader([port]); assert until(lambda: port.drained.is_set() and r.counters['serial_lines_ok'] == 2)
    assert [k for k, _ in items] == ['frame', 'hb'] and r.counters['serial_bad_lines'] == 3; r.stop()

def test_port_loss_and_return_log_serial_lost_once_per_outage_and_serial_back_on_reopen():
    p1, p2 = FakePort([frame_line('01'), OSError('device removed')]), FakePort([frame_line('02')])
    r, items, links = run_reader([OSError('no port'), OSError('no port'), p1, OSError('still gone'), p2])
    assert until(lambda: [p.raw for k, p in items] == [b'\x01', b'\x02'])
    assert links == [('SERIAL_LOST', 'open'), ('SERIAL_BACK', None), ('SERIAL_LOST', 'read'), ('SERIAL_BACK', None)]      # three failed opens in a row: still one SERIAL_LOST
    assert p1.closed; r.stop()

def test_a_failing_handler_is_counted_and_does_not_stop_the_reader():
    port = FakePort([frame_line('01'), frame_line('02')]); seen = []
    def handler(k, p):
        seen.append(p.raw)
        if p.raw == b'\x01': raise RuntimeError('boom')
    r = SerialReader(lambda: port, handler, retry_s=0.005).start()
    assert until(lambda: seen == [b'\x01', b'\x02']) and r.counters['serial_handler_errors'] == 1 and r.alive(); r.stop()
