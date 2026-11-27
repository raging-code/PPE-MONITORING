// patches/part24b_3_host_health.mjs  (run from repo root: node patches/part24b_3_host_health.mjs [--dry])
// P24b Part 3: host health checks. io/health.py gets HostHealth (QUEUE_OVERFLOW, HOST_BATTERY, DISK_LOW, the host_power string) with
// disk_free_gb() (stdlib), default_battery() (psutil if installed, else unknown) and host_power_str(); runtime.py writes LOGGING_FAULT from the
// DBWriter callback, builds and ticks HostHealth (after Health) and adds the HOST BATTERY audio item ('host_power', rank 5 at or below host_bat_warn_pct);
// serve.py gives Wire the host_power reader; tests/conftest.py never reads the real battery; test_serve.py stubs gain the host_health part;
// new host/tests/test_host_health.py. Each edit is an anchored replace that must match exactly once; an already-applied edit is skipped; nothing is written if any edit fails.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), abs = (p) => path.join(ROOT, p);
const EDITS = {
 "host/ppe_host/io/health.py": [
  [
   "emit(kind, detail) is Ingest.system_event.\"\"\"\nimport json, threading",
   "emit(kind, detail) is Ingest.system_event.\nP24b adds HostHealth: QUEUE_OVERFLOW, HOST_BATTERY and DISK_LOW, and the host_power string for the snapshot banner.\"\"\"\nimport json, shutil, threading"
  ],
  [
   "                self.last_counters = m; self.emit('COUNTERS', self.counters.detail())\n",
   "                self.last_counters = m; self.emit('COUNTERS', self.counters.detail())\n\n\ndef disk_free_gb(path):\n    \"\"\"Free space in GB on the disk that holds `path` (stdlib). None if it cannot be read.\"\"\"\n    try: return shutil.disk_usage(path).free / 1e9\n    except OSError: return None\n\ndef default_battery():\n    \"\"\"(on_battery, percent) of the laptop. The standard library cannot read a battery, so this uses psutil if it is installed; without it, or on a machine with no battery, the answer is (False, None): unknown is never reported as 'on battery'.\"\"\"\n    try:\n        import psutil\n        b = psutil.sensors_battery()\n        return (False, None) if b is None else (b.power_plugged is False, None if b.percent is None else int(b.percent))\n    except Exception: return False, None\n\ndef host_power_str(on_battery, pct, warn_pct):\n    \"\"\"The string Wire sends as host_power (the dashboard's parseHostPower): 'ac' on mains; 'battery' on battery (notice banner, no sound); 'battery N%' only at or below warn_pct (warning banner, beep), because the dashboard shows the warning whenever a number is present.\"\"\"\n    if not on_battery: return 'ac'\n    return 'battery %d%%' % pct if pct is not None and pct <= warn_pct else 'battery'\n\nclass HostHealth:\n    \"\"\"P24b host checks, called once a second from Runtime.tick. QUEUE_OVERFLOW: when the writer's queue_overflow counter has grown, one event per overflow_log_s (the event itself goes through the same queue). Once a minute (check_interval_s) the battery and the free disk are read:\n    HOST_BATTERY is logged when the laptop goes on battery and again when it falls to warn_pct or below; DISK_LOW when free space falls below disk_min_gb. Each is logged once at onset and again only after the condition has cleared (the schema has no 'back' kind; the banner just stops). Readers are injectable (None means the real ones, looked up at call time); a reader that raises is treated as unknown.\"\"\"\n    def __init__(self, clock, emit, writer, disk_path, read_battery=None, read_disk_gb=None, warn_pct=30, disk_min_gb=1.0, check_interval_s=60, overflow_log_s=60):\n        self.clock, self.emit, self.writer, self.disk_path = clock, emit, writer, disk_path\n        self._read_battery, self._read_disk_gb, self.warn_pct, self.disk_min_gb = read_battery, read_disk_gb, warn_pct, disk_min_gb\n        self.check_ms, self.overflow_ms = check_interval_s * 1000, overflow_log_s * 1000\n        self.on_battery, self.pct, self.disk_gb = False, None, None\n        self._bat_level, self._disk_low = 0, False                              # _bat_level: 0 mains, 1 on battery, 2 at or below warn_pct\n        self._last_check = None; self._seen_overflow = 0; self._last_overflow_log = None\n    def tick(self):\n        self._overflow(); m = self.clock.mono_ms()\n        if self._last_check is None or m - self._last_check >= self.check_ms: self._last_check = m; self.check()\n    def _overflow(self):\n        n = self.writer.counters['queue_overflow']\n        if n <= self._seen_overflow: return\n        m = self.clock.mono_ms()\n        if self._last_overflow_log is not None and m - self._last_overflow_log < self.overflow_ms: return    # counted, logged at the next allowed time\n        self.emit('QUEUE_OVERFLOW', '%d unit(s) over the writer queue limit since the last report (total %d)' % (n - self._seen_overflow, n))\n        self._seen_overflow, self._last_overflow_log = n, m\n    def check(self):\n        \"\"\"Read the battery and the disk now (also called by tests).\"\"\"\n        try: self.on_battery, self.pct = (self._read_battery or default_battery)()\n        except Exception: self.on_battery, self.pct = False, None\n        level = 0 if not self.on_battery else 2 if self.pct is not None and self.pct <= self.warn_pct else 1\n        if level > self._bat_level: self.emit('HOST_BATTERY', 'on battery' + ('' if self.pct is None else ' %d%%' % self.pct) + ('' if level == 1 else ' (at or below %d%%)' % self.warn_pct))\n        self._bat_level = level\n        try: self.disk_gb = (self._read_disk_gb or disk_free_gb)(self.disk_path)\n        except Exception: self.disk_gb = None\n        low = self.disk_gb is not None and self.disk_gb < self.disk_min_gb\n        if low and not self._disk_low: self.emit('DISK_LOW', 'free %.2f GB, minimum %.2f GB' % (self.disk_gb, self.disk_min_gb))\n        self._disk_low = low\n    def host_power(self): return host_power_str(self.on_battery, self.pct, self.warn_pct)\n    def audio_level(self):\n        \"\"\"None on mains; 'NONE' on battery (no sound); 'WARNING' at or below warn_pct (the beep, rank 5).\"\"\"\n        return None if self._bat_level == 0 else 'WARNING' if self._bat_level == 2 else 'NONE'\n"
  ]
 ],
 "host/ppe_host/runtime.py": [
  [
   "import logging, threading",
   "import json, logging, threading"
  ],
  [
   "from .io.health import Counters, Health",
   "from .io.health import Counters, Health, HostHealth"
  ],
  [
   "        self.writer = DBWriter(st.db_path, self.clock)",
   "        self.writer = DBWriter(st.db_path, self.clock, on_logging_fault=lambda table, msg: self.ingest.system_event('LOGGING_FAULT', json.dumps({'table': table, 'error': msg}, sort_keys=True, separators=(',', ':'))))   # the lambda reads self.ingest only when a fault happens, after __init__"
  ],
  [
   "        self.health = self.ingest.health = Health(self.clock, self.ingest.system_event, counters, interval_s=s['counters_interval_s'])\n        self.started, self.wire, self.port, self.ticks = False, None, None, 0   # wire and port are set by serve.build_app (step 10)",
   "        self.health = self.ingest.health = Health(self.clock, self.ingest.system_event, counters, interval_s=s['counters_interval_s'])\n        self.host_health = HostHealth(self.clock, self.ingest.system_event, self.writer, st.db_path.parent, warn_pct=s['host_bat_warn_pct'], disk_min_gb=s['host_disk_min_gb'])\n        self.started, self.wire, self.port, self.ticks = False, None, None, 0   # wire and port are set by serve.build_app (step 10)"
  ],
  [
   "        for name, fn in (('host_tick', self.offer_tick), ('health', self.health.tick), ('audio', self.audio_refresh), ('wire', lambda: self.wire.tick() if self.wire is not None else None), ('stamp', lambda: self.liveness.stamp('tick'))):",
   "        for name, fn in (('host_tick', self.offer_tick), ('health', self.health.tick), ('host_health', self.host_health.tick), ('audio', self.audio_refresh), ('wire', lambda: self.wire.tick() if self.wire is not None else None), ('stamp', lambda: self.liveness.stamp('tick'))):"
  ],
  [
   "        BASE OFFLINE (the Health flag; it cannot be acknowledged), LOGGING FAULT and HOST GAP (acknowledgeable). Not here yet: RECOVERING (P25 ends it, so it is added there), HOST BATTERY (P24b).",
   "        BASE OFFLINE (the Health flag; it cannot be acknowledged), LOGGING FAULT and HOST GAP (acknowledgeable). HOST BATTERY ('host_power': beep at or below host_bat_warn_pct, silent while only on battery). Not here yet: RECOVERING (P25 ends it, so it is added there)."
  ],
  [
   "                if on: items.append(dict(alert_type=kind, level=level, acknowledged=ack is not None))\n        return items",
   "                if on: items.append(dict(alert_type=kind, level=level, acknowledged=ack is not None))\n        lvl = self.host_health.audio_level()\n        if lvl is not None: items.append(dict(alert_type='host_power', level=lvl, acknowledged=False))      # not acknowledgeable: it ends when the laptop is plugged in\n        return items"
  ]
 ],
 "host/ppe_host/serve.py": [
  [
   "    wire = Wire(port, LoopHub(hub, loop), audio_fault=lambda: bool(rt.audio is not None and rt.audio.audio_fault)).attach(); wire.enable_advisory(s['advisory_heartbeat_s'])",
   "    wire = Wire(port, LoopHub(hub, loop), audio_fault=lambda: bool(rt.audio is not None and rt.audio.audio_fault), host_power=rt.host_health.host_power).attach(); wire.enable_advisory(s['advisory_heartbeat_s'])"
  ]
 ],
 "host/tests/conftest.py": [
  [
   "    monkeypatch.setattr(M, 'watchdog_exit', lambda code: M.WATCHDOG_EXITS.append(code))\n",
   "    monkeypatch.setattr(M, 'watchdog_exit', lambda code: M.WATCHDOG_EXITS.append(code))\n\n@pytest.fixture(autouse=True)\ndef _no_real_battery(monkeypatch):\n    \"\"\"HostHealth reads the laptop battery by default (P24b); a test must never depend on the machine it runs on.\"\"\"\n    from ppe_host.io import health\n    monkeypatch.setattr(health, 'default_battery', lambda: (False, None))\n"
  ]
 ],
 "host/tests/test_serve.py": [
  [
   "    return NS(offer_tick=part('host_tick'), health=NS(tick=part('health')), audio_refresh=part('audio'), wire=NS(tick=part('wire')) if wire else None, ticks=0)",
   "    return NS(offer_tick=part('host_tick'), health=NS(tick=part('health')), host_health=NS(tick=part('host_health')), audio_refresh=part('audio'), wire=NS(tick=part('wire')) if wire else None, ticks=0)"
  ],
  [
   "def test_tick_runs_host_tick_then_health_then_audio_then_wire():",
   "def test_tick_runs_host_tick_then_health_then_host_health_then_audio_then_wire():"
  ],
  [
   "    assert order == ['host_tick', 'health', 'audio', 'wire'] * 2 and s.ticks == 2",
   "    assert order == ['host_tick', 'health', 'host_health', 'audio', 'wire'] * 2 and s.ticks == 2"
  ],
  [
   "    for bad in ('host_tick', 'health', 'audio', 'wire'):",
   "    for bad in ('host_tick', 'health', 'host_health', 'audio', 'wire'):"
  ],
  [
   "        assert order == ['host_tick', 'health', 'audio', 'wire'] and s.ticks == 1",
   "        assert order == ['host_tick', 'health', 'host_health', 'audio', 'wire'] and s.ticks == 1"
  ],
  [
   "    order = []; s = stub(order, wire=False); R.Runtime.tick(s); assert order == ['host_tick', 'health', 'audio']",
   "    order = []; s = stub(order, wire=False); R.Runtime.tick(s); assert order == ['host_tick', 'health', 'host_health', 'audio']"
  ]
 ]
};
const NEW_FILES = {
 "host/tests/test_host_health.py": "\"\"\"P24b-3: HostHealth (QUEUE_OVERFLOW, HOST_BATTERY, DISK_LOW, the host_power string), the LOGGING_FAULT callback and the HOST BATTERY audio item.\"\"\"\nimport json\nfrom types import SimpleNamespace as NS\nfrom ppe_host import runtime as R\nfrom ppe_host.clock import FakeClock\nfrom ppe_host.io import health as H\nfrom test_startup import home, run, NOW\n\ndef make(bat=(False, None), disk=5.0, **kw):\n    clock, ev = FakeClock(0, 0), []\n    w = NS(counters={'queue_overflow': 0})\n    st = dict(bat=bat, disk=disk)\n    hh = H.HostHealth(clock, lambda k, d: ev.append((k, d)), w, '.', read_battery=lambda: st['bat'], read_disk_gb=lambda p: st['disk'], **kw)\n    return hh, clock, ev, w, st\n\ndef test_host_power_string_matches_what_the_dashboard_parses():\n    assert H.host_power_str(False, 10, 30) == 'ac' and H.host_power_str(True, None, 30) == 'battery' and H.host_power_str(True, 80, 30) == 'battery'\n    assert H.host_power_str(True, 30, 30) == 'battery 30%' and H.host_power_str(True, 22, 30) == 'battery 22%'      # a number appears only at or below the threshold\n\ndef test_mains_and_enough_disk_log_nothing_and_read_once_a_minute():\n    hh, c, ev, w, st = make(); calls = []; hh._read_battery = lambda: calls.append(1) or (False, None)\n    for _ in range(59): hh.tick(); c.advance(1000)\n    assert len(calls) == 1 and ev == []                                       # the first tick reads at once, the next read is 60 s later\n    c.advance(1000); hh.tick(); assert len(calls) == 2 and hh.host_power() == 'ac' and hh.audio_level() is None\n\ndef test_on_battery_is_logged_once_then_again_at_the_threshold_then_after_a_return_to_mains():\n    hh, c, ev, w, st = make(); st['bat'] = (True, 80); hh.check(); hh.check()\n    assert ev == [('HOST_BATTERY', 'on battery 80%')] and hh.audio_level() == 'NONE' and hh.host_power() == 'battery'\n    st['bat'] = (True, 25); hh.check(); hh.check()\n    assert ev[-1] == ('HOST_BATTERY', 'on battery 25% (at or below 30%)') and len(ev) == 2 and hh.audio_level() == 'WARNING' and hh.host_power() == 'battery 25%'\n    st['bat'] = (False, 25); hh.check(); assert len(ev) == 2 and hh.audio_level() is None and hh.host_power() == 'ac'\n    st['bat'] = (True, None); hh.check(); assert len(ev) == 3 and ev[-1][1] == 'on battery'                          # unknown percent: notice only\n\ndef test_disk_low_is_logged_at_onset_and_again_only_after_it_cleared():\n    hh, c, ev, w, st = make(); st['disk'] = 0.5; hh.check(); hh.check()\n    assert ev == [('DISK_LOW', 'free 0.50 GB, minimum 1.00 GB')]\n    st['disk'] = 2.0; hh.check(); st['disk'] = 0.9; hh.check(); assert [k for k, _ in ev] == ['DISK_LOW', 'DISK_LOW']\n\ndef test_unknown_readings_are_not_alarms():\n    hh, c, ev, w, st = make(disk=None); hh.check(); assert ev == []\n    def boom(): raise OSError('x')\n    hh._read_battery = boom; hh._read_disk_gb = lambda p: (_ for _ in ()).throw(OSError('x')); hh.check(); assert ev == [] and hh.host_power() == 'ac'\n\ndef test_queue_overflow_is_logged_when_the_counter_grows_and_at_most_once_a_minute():\n    hh, c, ev, w, st = make(); hh.tick(); assert ev == []\n    w.counters['queue_overflow'] = 3; c.advance(1000); hh.tick(); assert ev == [('QUEUE_OVERFLOW', '3 unit(s) over the writer queue limit since the last report (total 3)')]\n    w.counters['queue_overflow'] = 5; c.advance(1000); hh.tick(); assert len(ev) == 1                                  # inside the minute: counted, not logged\n    c.advance(60000); hh.tick(); assert ev[-1][1] == '2 unit(s) over the writer queue limit since the last report (total 5)' and len(ev) == 2\n    c.advance(120000); hh.tick(); assert len(ev) == 2                                                                  # no growth, no event\n\ndef test_a_custom_threshold_is_used():\n    hh, c, ev, w, st = make(warn_pct=50, disk_min_gb=10.0); st['bat'] = (True, 45); st['disk'] = 5.0; hh.check()\n    assert [k for k, _ in ev] == ['HOST_BATTERY', 'DISK_LOW'] and hh.host_power() == 'battery 45%'\n\n# ---- through the Runtime ----\nfrom test_audio_wiring import mk, events\nfrom fakeaudio import FakeBackend\n\ndef close(rt, st): rt.writer.conn.close(); st.close()\n\ndef test_the_runtime_builds_host_health_from_settings(tmp_path):\n    st, rt = mk(tmp_path, FakeBackend())\n    assert rt.host_health.warn_pct == st.settings['host_bat_warn_pct'] and rt.host_health.disk_min_gb == st.settings['host_disk_min_gb']\n    assert rt.host_health.disk_path == st.db_path.parent and rt.host_health.host_power() == 'ac'; close(rt, st)\n\ndef test_the_1hz_tick_runs_host_health_and_a_failure_does_not_stop_the_others(tmp_path):\n    st, rt = mk(tmp_path, FakeBackend()); seen = []\n    rt.host_health.tick = lambda: seen.append('hh') or (_ for _ in ()).throw(RuntimeError('x'))\n    rt.liveness.stamp = lambda n: seen.append(n); rt.tick()\n    assert seen == ['hh', 'tick'] and rt.ticks == 1; close(rt, st)\n\ndef test_audio_items_carry_host_power_only_when_on_battery(tmp_path):\n    st, rt = mk(tmp_path, FakeBackend()); rt.port = NS(banner_state=lambda k: (False, None)); assert rt.audio_items() == []\n    rt.host_health._bat_level = 1; assert rt.audio_items() == [dict(alert_type='host_power', level='NONE', acknowledged=False)]\n    rt.host_health._bat_level = 2; assert rt.audio_items() == [dict(alert_type='host_power', level='WARNING', acknowledged=False)]; close(rt, st)\n\ndef test_a_low_battery_reaches_the_audio_thread_as_the_beep(tmp_path):\n    from ppe_host.io.audio_watchdog import host_rank, RANK_WARNING\n    from ppe_host.io.audio_watchdog import load_catalog\n    cat = load_catalog()\n    assert host_rank('host_power', 'WARNING', cat) == (RANK_WARNING, 'beep') and host_rank('host_power', 'NONE', cat) is None\n\ndef test_a_logging_fault_in_the_writer_becomes_a_system_event(tmp_path):\n    st, rt = mk(tmp_path, FakeBackend()); rt.writer.on_logging_fault('alerts', 'UNIQUE constraint failed: x')\n    rt.writer.start(); rt.writer.stop(drain=True)\n    import sqlite3; c = sqlite3.connect(str(st.db_path)); rows = c.execute(\"SELECT detail FROM system_events WHERE kind = 'LOGGING_FAULT'\").fetchall(); c.close()\n    assert [json.loads(r[0]) for r in rows] == [{'table': 'alerts', 'error': 'UNIQUE constraint failed: x'}]; st.close()\n\ndef test_serve_gives_wire_the_host_power_reader(tmp_path):\n    import inspect; from ppe_host import serve\n    assert 'host_power=rt.host_health.host_power' in inspect.getsource(serve.build_app)\n"
};
const plan = [], errors = [], log = [];
for (const [rel, hunks] of Object.entries(EDITS)) {
  if (!fs.existsSync(abs(rel))) { errors.push(`missing   ${rel}`); continue; }
  const raw = fs.readFileSync(abs(rel), 'utf8'), crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n'), n = 0, skipped = 0;
  for (const [oldS, newS] of hunks) {
    const c = text.split(oldS).length - 1;
    if (text.includes(newS)) skipped++;                                    // already applied (checked first: an insertion keeps its old anchor)
    else if (c === 1) { text = text.replace(oldS, () => newS); n++; }
    else errors.push(`anchor    ${rel}: ${c} match(es) for "${oldS.slice(0, 70).replace(/\n/g, '\\n')}"`);
  }
  plan.push([rel, crlf ? text.replace(/\n/g, '\r\n') : text]);
  log.push(`edit      ${rel} (${n} applied, ${skipped} already there)`);
}
for (const [rel, content] of Object.entries(NEW_FILES)) {
  if (fs.existsSync(abs(rel))) { log.push(`skip      ${rel} (exists)`); continue; }
  plan.push([rel, content]); log.push(`create    ${rel}`);
}
if (errors.length) { console.error(errors.join('\n')); console.error('NOTHING WRITTEN: the tree is not the expected P24b Part 2 state.'); process.exit(1); }
if (!DRY) for (const [rel, content] of plan) { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), content); }
console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\nDone. Now: cd host; python -m pytest tests -q'));
