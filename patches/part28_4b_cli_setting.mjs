// patches/part28_4b_cli_setting.mjs  (run from repo root: node patches/part28_4b_cli_setting.mjs [--dry] [--force])
// P28 Part 4b (ADR 0056). Needs part28_1 to _4a (and part28_4a_fix_ruff) applied first.
// New: `cli set-pin --operator-id N [--length 6..12 | --prompt]` (random PIN shown once, or typed twice and hidden; scrypt hash only; clears the lock and failure count, ends the operator's login sessions, writes PIN_SET offline).
// rotate-token and disable-operator also revoke the operator's login sessions. New setting session_hours (default 12, above 0 to 168, in HASH_EXCLUDED) read by HostPort for each new session.
// New files: host/tests/test_cli_pin.py, host/tests/test_session_hours.py. Edited: host/config/settings.json, ppe_host/settings.py, cli.py, host_port.py, api/security.py (a comment), test_settings.py and test_gen_constants.py (key counts 36 to 37),
//   test_host_port_pin.py (one test appended), docs/design/s01-settings.md, docs/adr/0056.md, docs/PROGRESS.md. The frozen design docx is not touched.
// Not here: the dashboard (P28-5), the Playwright test, a doctor row and the README note (P28-6).
// Safe to run twice. CRLF files keep their CRLF. --dry writes nothing.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), FORCE = process.argv.includes('--force');
const abs = (p) => path.join(ROOT, p), plan = [];
const put = (p, content, replaces) => plan.push({ op: 'put', p, content, replaces });
const replace = (p, o, n) => plan.push({ op: 'replace', p, o, n });
const append = (p, text) => plan.push({ op: 'append', p, text });
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toEol = (t, e) => t.replace(/\r\n/g, '\n').replace(/\n/g, e);
const lf = (s) => s.replace(/\r\n/g, '\n');
function apply() {
  const state = new Map(), log = [];
  const get = (p) => (state.has(p) ? state.get(p) : fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      const same = cur !== null && lf(cur) === lf(s.content), known = cur !== null && s.replaces && cur.includes(s.replaces);
      if (cur !== null && !same && !known && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : same ? 'unchanged' : 'overwrite'} ${s.p}`);
      if (!same) state.set(s.p, cur !== null && cur.includes('\r\n') ? toEol(s.content, '\r\n') : s.content);
    } else if (cur === null) throw new Error(`MISSING file: ${s.p} (run the earlier parts first, and run from the repo root)`);
    else if (s.op === 'replace') {
      const e = eolOf(cur), o = toEol(s.o, e), n = toEol(s.n, e), c = cur.split(o).length - 1;
      if (cur.includes(n)) log.push(`skip      ${s.p} (already applied)`);
      else if (c === 1) { state.set(s.p, cur.replace(o, () => n)); log.push(`edit      ${s.p}`); }
      else throw new Error(`ANCHOR found ${c} times in ${s.p}: ${s.o.slice(0, 70)}`);
    } else if (s.op === 'append') {
      const e = eolOf(cur), t = toEol(s.text, e);
      if (cur.includes(t.trim())) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : e) + t + e); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\ndone'));
}

put("host/tests/test_cli_pin.py", "\"\"\"P28-4b (ADR 0056): cli set-pin, and the login sessions that rotate-token and disable-operator end. Real migrated database, real scrypt, a temporary PPE_HOME. Requirements: REQ-SEC-002, REQ-SEC-004, REQ-SEC-005.\"\"\"\nimport json\nimport pytest\nfrom ppe_host import cli\nfrom ppe_host.api import pin_auth as P, security as S\nfrom ppe_host.io.db_writer import connect_db, init_event_seq\n\n@pytest.fixture\ndef env(tmp_path):\n    home, db = tmp_path / 'home', tmp_path / 'ops.db'; return home, db\ndef run(env, *args):\n    home, db = env; return cli.main(list(args) + ['--home', str(home), '--db', str(db)])\ndef salt(env): return json.loads((env[0] / 'config' / 'secrets.json').read_text())['server_salt']\ndef rows(env, sql, *p): c = connect_db(env[1], readonly=True); r = c.execute(sql, p).fetchall(); c.close(); return r\ndef pin_of(capsys):\n    out = capsys.readouterr().out; assert 'shown once' in out; return out.split('PIN (shown once, only its hash is stored): ')[1].strip()\ndef token_of(capsys): return capsys.readouterr().out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()\ndef two_operators(env, capsys):\n    run(env, 'create-operator', '--name', 'Ana'); ta = token_of(capsys); run(env, 'create-operator', '--name', 'Ben'); tb = token_of(capsys); return ta, tb\ndef login(env, oid, now=1000):\n    c = connect_db(env[1]); t, e, _ = P.create_session(c, salt(env), oid, False, now); c.close(); return t\ndef auth(env, tok, now=1000): return S.Authenticator(env[1], salt(env), 5, now_ms=lambda: now).authenticate(tok)\n\ndef test_set_pin_prints_a_random_pin_once_and_stores_only_its_scrypt_hash(env, capsys):\n    two_operators(env, capsys); assert run(env, 'set-pin', '--operator-id', '1') == 0; pin = pin_of(capsys)\n    assert S.valid_pin(pin) and len(pin) == 6\n    h, s, set_ts = rows(env, 'SELECT pin_hash, pin_salt, pin_set_ts FROM operators WHERE operator_id = 1')[0]\n    assert S.verify_pin(pin, h, s) and pin not in h + s and set_ts > 0 and rows(env, 'SELECT pin_hash FROM operators WHERE operator_id = 2') == [(None,)]\n    c = connect_db(env[1]); r = P.pin_login(c, 'Ana', pin, 5); assert r.status == 'ok' and r.operator.operator_id == 1\ndef test_set_pin_audits_pin_set_offline_with_session_null_and_event_seq_0_and_never_writes_the_pin(env, capsys):\n    two_operators(env, capsys); run(env, 'set-pin', '--operator-id', '1'); pin = pin_of(capsys)\n    a = rows(env, \"SELECT session_id, event_seq, operator_id, action, reason FROM audit_events WHERE action = 'PIN_SET'\")\n    assert a == [(None, 0, None, 'PIN_SET', 'operator_id 1')] and init_event_seq(connect_db(env[1], readonly=True)) == 1\n    assert pin not in str(rows(env, 'SELECT * FROM audit_events')) and pin not in (env[0] / 'config' / 'secrets.json').read_text()\ndef test_every_set_pin_gives_a_new_pin_and_the_old_one_stops_working(env, capsys):\n    two_operators(env, capsys); run(env, 'set-pin', '--operator-id', '1'); p1 = pin_of(capsys); run(env, 'set-pin', '--operator-id', '1'); p2 = pin_of(capsys)\n    c = connect_db(env[1]); assert p1 != p2 and P.pin_login(c, 'Ana', p2, 5).status == 'ok' and P.pin_login(c, 'Ana', p1, 5).status == 'rejected'\ndef test_length_sets_the_number_of_digits_and_a_length_outside_6_to_12_changes_nothing(env, capsys):\n    two_operators(env, capsys); assert run(env, 'set-pin', '--operator-id', '1', '--length', '10') == 0 and len(pin_of(capsys)) == 10\n    for n in ('5', '13', '0'): assert run(env, 'set-pin', '--operator-id', '1', '--length', n) == 1\n    assert 'PIN' not in capsys.readouterr().out and len(rows(env, \"SELECT * FROM audit_events WHERE action = 'PIN_SET'\")) == 1\ndef test_set_pin_clears_the_lock_and_the_failure_count_and_ends_the_login_sessions_of_that_operator_only(env, capsys):\n    two_operators(env, capsys); c = connect_db(env[1]); c.execute('UPDATE operators SET pin_fails = 3, pin_locked_until = 99999999999 WHERE operator_id = 1'); c.close()\n    a, b = login(env, 1), login(env, 2); assert auth(env, a) and auth(env, b)\n    run(env, 'set-pin', '--operator-id', '1'); out = capsys.readouterr().out\n    assert rows(env, 'SELECT pin_fails, pin_locked_until FROM operators WHERE operator_id = 1') == [(0, None)] and auth(env, a) is None and auth(env, b) is not None and '1 login session(s) ended' in out\ndef test_prompt_takes_a_typed_pin_twice_and_does_not_print_it(env, capsys, monkeypatch):\n    two_operators(env, capsys); import getpass; answers = iter(['482913', '482913']); monkeypatch.setattr(getpass, 'getpass', lambda prompt='': next(answers))\n    assert run(env, 'set-pin', '--operator-id', '1', '--prompt') == 0; out = capsys.readouterr().out; assert '482913' not in out and 'PIN set' in out\n    c = connect_db(env[1]); assert P.pin_login(c, 'Ana', '482913', 5).status == 'ok'\ndef test_prompt_refuses_two_different_or_invalid_pins_and_changes_nothing(env, capsys, monkeypatch):\n    two_operators(env, capsys); import getpass\n    for pair in (['482913', '482914'], ['123', '123'], ['12345a', '12345a']):\n        answers = iter(pair); monkeypatch.setattr(getpass, 'getpass', lambda prompt='', a=answers: next(a))\n        assert run(env, 'set-pin', '--operator-id', '1', '--prompt') == 1\n    assert rows(env, 'SELECT pin_hash FROM operators WHERE operator_id = 1') == [(None,)] and rows(env, \"SELECT * FROM audit_events WHERE action = 'PIN_SET'\") == []\ndef test_set_pin_for_an_unknown_or_a_disabled_operator_fails_and_changes_nothing(env, capsys):\n    two_operators(env, capsys); run(env, 'disable-operator', '--operator-id', '2'); capsys.readouterr()\n    assert run(env, 'set-pin', '--operator-id', '9') == 1 and run(env, 'set-pin', '--operator-id', '2') == 1\n    cap = capsys.readouterr(); assert 'PIN (shown' not in cap.out and 'disabled' in cap.err and rows(env, \"SELECT * FROM audit_events WHERE action = 'PIN_SET'\") == []\ndef test_rotate_token_ends_every_login_session_of_that_operator(env, capsys):\n    two_operators(env, capsys); a1, a2, b = login(env, 1), login(env, 1), login(env, 2)\n    assert run(env, 'rotate-token', '--operator-id', '1') == 0; out = capsys.readouterr().out\n    assert auth(env, a1) is None and auth(env, a2) is None and auth(env, b) is not None and '2 login session(s) ended' in out and token_of_text(out)\ndef token_of_text(out): return out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()\ndef test_rotate_token_without_sessions_prints_no_session_line(env, capsys):\n    two_operators(env, capsys); run(env, 'rotate-token', '--operator-id', '1'); assert 'login session' not in capsys.readouterr().out\ndef test_disable_operator_revokes_the_login_sessions_in_the_database(env, capsys):\n    two_operators(env, capsys); a, b = login(env, 1), login(env, 2); assert run(env, 'disable-operator', '--operator-id', '1') == 0\n    assert auth(env, a) is None and auth(env, b) is not None\n    assert [r[0] is not None for r in rows(env, 'SELECT revoked_ts FROM login_sessions ORDER BY operator_id')] == [True, False]\n", null);
put("host/tests/test_session_hours.py", "\"\"\"P28-4b (ADR 0056): the session_hours setting: default, override, range, and that it is not in settings_hash. Requirements: REQ-SEC-002.\"\"\"\nimport json\nimport pytest\nfrom ppe_host.settings import load_settings, settings_hash, HASH_EXCLUDED, SettingsError, DEFAULTS_PATH\n\ndef home(tmp_path, local=None):\n    (tmp_path / 'config').mkdir(parents=True, exist_ok=True)\n    if local is not None: (tmp_path / 'config' / 'settings.local.json').write_text(json.dumps(local))\n    return tmp_path\n\ndef test_the_default_is_12_hours_and_a_local_override_is_read(tmp_path):\n    assert load_settings(home(tmp_path))['session_hours'] == 12\n    s = load_settings(home(tmp_path / 'x', {'session_hours': 2.5})); assert s['session_hours'] == 2.5\ndef test_a_value_outside_above_0_to_168_or_of_the_wrong_type_is_refused(tmp_path):\n    for i, bad in enumerate((0, -1, 169, 1e9, True, '12', None)):\n        with pytest.raises(SettingsError): load_settings(home(tmp_path / str(i), {'session_hours': bad}))\n    assert load_settings(home(tmp_path / 'ok', {'session_hours': 168}))['session_hours'] == 168\ndef test_session_hours_is_not_in_settings_hash_so_changing_it_does_not_end_a_shift(tmp_path):\n    a = load_settings(home(tmp_path)); b = load_settings(home(tmp_path / 'y', {'session_hours': 4}))\n    assert 'session_hours' in HASH_EXCLUDED and settings_hash(a) == settings_hash(b)\ndef test_the_committed_default_file_holds_the_key():\n    assert json.loads(DEFAULTS_PATH.read_text(encoding='utf8'))['session_hours'] == 12\n", null);
replace("host/config/settings.json",
  "  \"login_backoff_cap_s\": 5,\n",
  "  \"login_backoff_cap_s\": 5,\n  \"session_hours\": 12,\n");
replace("host/ppe_host/settings.py",
  "'supervisor_restart_target_s')",
  "'supervisor_restart_target_s', 'session_hours')");
replace("host/ppe_host/settings.py",
  "    sec = home / 'config' / 'secrets.json'\n",
  "    h = values.get('session_hours')      # P28-4b (ADR 0056): hours a PIN login session lasts\n    if h is not None and not (0 < h <= 168): raise SettingsError('session_hours must be above 0 and at most 168')\n    sec = home / 'config' / 'secrets.json'\n");
replace("docs/design/s01-settings.md",
  "| zero_socket_alarm_s (deleted) |",
  "| session_hours | 12 | Hours a PIN login session lasts (ADR 0056, Proposed); above 0 and at most 168. A session also ends at once on log out, on a new PIN, on rotate-token and on disable-operator. Not in settings_hash. |\n| zero_socket_alarm_s (deleted) |");
replace("host/tests/test_settings.py",
  "len(s.values) == 36",
  "len(s.values) == 37");
replace("host/tests/test_settings.py",
  "len(HASH_EXCLUDED) == 17",
  "len(HASH_EXCLUDED) == 18");
replace("host/tests/test_gen_constants.py",
  "== (78, 36)",
  "== (78, 37)");
replace("host/ppe_host/api/security.py",
  "the session_hours setting is added in P28-4",
  "the session_hours setting overrides it (this is the fallback for a settings dict without the key)");
replace("host/ppe_host/host_port.py",
  "pin_auth.plan_session(self.auth.salt, operator_id, remember, self.ing.clock.wall_ms())",
  "pin_auth.plan_session(self.auth.salt, operator_id, remember, self.ing.clock.wall_ms(), self.settings.get('session_hours', sec.DEFAULT_SESSION_HOURS))");
replace("host/tests/test_gen_constants.py",
  "len(rows) == 28 and len(live) == 26",
  "len(rows) == 29 and len(live) == 27");
replace("host/ppe_host/cli.py",
  "            def write(): conn.execute('UPDATE operators SET token_hash = ?, token_issued_ts = ? WHERE operator_id = ?', (sec.hash_token(salt, token), now, a.operator_id)); return a.operator_id\n",
  "            ended = []      # P28-4b: the login sessions of the operator end with the old token\n            def write(): conn.execute('UPDATE operators SET token_hash = ?, token_issued_ts = ? WHERE operator_id = ?', (sec.hash_token(salt, token), now, a.operator_id)); ended.append(pin_auth.revoke_operator_sessions(conn, a.operator_id, now)); return a.operator_id\n");
replace("host/ppe_host/cli.py",
  "    print('rotate-token: operator_id %d (%s), the old token no longer works\\nTOKEN (shown once, only its hash is stored): %s' % (a.operator_id, name, token)); return 0",
  "    print('rotate-token: operator_id %d (%s), the old token no longer works\\n%sTOKEN (shown once, only its hash is stored): %s' % (a.operator_id, name, '%d login session(s) ended\\n' % ended[0] if ended[0] else '', token)); return 0");
replace("host/ppe_host/cli.py",
  "def cmd_rotate_token(a):\n    from .api import security as sec\n",
  "def cmd_rotate_token(a):\n    from .api import pin_auth, security as sec\n");
replace("host/ppe_host/cli.py",
  "                def write(): conn.execute('UPDATE operators SET active = 0 WHERE operator_id = ?', (a.operator_id,)); return a.operator_id\n",
  "                def write(): conn.execute('UPDATE operators SET active = 0 WHERE operator_id = ?', (a.operator_id,)); pin_auth.revoke_operator_sessions(conn, a.operator_id, int(time.time() * 1000)); return a.operator_id      # P28-4b: and its login sessions\n");
replace("host/ppe_host/cli.py",
  "def cmd_disable_operator(a):\n    try:\n",
  "def cmd_disable_operator(a):\n    from .api import pin_auth\n    try:\n");
replace("host/ppe_host/cli.py",
  "COMMANDS.update({\n    'create-operator':",
  "def cmd_set_pin(a):\n    \"\"\"P28-4b (ADR 0056): set or reset the PIN of an operator. The PIN is random (--length digits, 6 by default) and shown once, or typed twice and hidden with --prompt. It is never an argument, never logged and never stored: only its scrypt hash is.\n    The failure count and the lock are cleared, the operator's login sessions end, and PIN_SET is written (offline row: session_id NULL, event_seq 0).\"\"\"\n    import secrets\n    from .api import pin_auth, security as sec\n    cmd = 'set-pin'\n    try:\n        if a.prompt:\n            import getpass\n            pin = getpass.getpass('new PIN (6 to 12 digits): ')\n            if getpass.getpass('repeat the PIN: ') != pin: raise SettingsError('the two PINs differ; nothing changed')\n        else:\n            if not 6 <= a.length <= 12: raise SettingsError('--length must be 6 to 12')\n            pin = ''.join(secrets.choice('0123456789') for _ in range(a.length))\n        if not sec.valid_pin(pin): raise SettingsError('a PIN is 6 to 12 digits; nothing changed')\n        home, conn, (name, active) = _existing(a, cmd)\n        try:\n            if not active: raise SettingsError('operator %d (%s) is disabled; a disabled operator gets no PIN' % (a.operator_id, name))\n            now, ended = int(time.time() * 1000), []\n            def write():\n                first, second = pin_auth.plan_set_pin(a.operator_id, pin, now); conn.execute(*first); ended.append(conn.execute(*second).rowcount); return a.operator_id\n            _write_with_audit(conn, 'PIN_SET', write)\n        finally: conn.close()\n    except SettingsError as e: return _fail(cmd, str(e))\n    note = '%d login session(s) ended\\n' % ended[0] if ended[0] else ''\n    print('set-pin: operator_id %d (%s)\\n%s' % (a.operator_id, name, note) + ('PIN set (typed by you, not shown)' if a.prompt else 'PIN (shown once, only its hash is stored): %s' % pin)); return 0\n\nCOMMANDS.update({\n    'set-pin': (cmd_set_pin, [('--operator-id', {'type': int, 'required': True}), ('--length', {'type': int, 'default': 6, 'help': 'digits of the random PIN, 6 to 12'}), ('--prompt', {'action': 'store_true', 'help': 'type the PIN twice (hidden) instead of a random one'})] + OPERATOR_FLAGS),\n    'create-operator':");
replace("docs/adr/0056.md",
  "P28-4b (CLI set-pin, the session_hours setting, revoke on rotate and disable), P28-5 and P28-6 not done.",
  "P28-4b (CLI set-pin, the session_hours setting, revoke on rotate and disable) is done too; P28-5 and P28-6 are not.");
append("host/tests/test_host_port_pin.py",
  "def test_the_session_length_follows_the_session_hours_setting(tmp_path):\n    c, w, ing, p = hp(tmp_path); now = ing.clock.wall_ms(); p.settings = {**S, 'session_hours': 2}\n    token, expires = p.start_login_session(1, False); assert expires == now + 2 * HOUR\n    ing.clock.advance(2 * HOUR - 1); assert p.authenticate(token) is not None\n    ing.clock.advance(2); assert p.authenticate(token) is None; w.stop()");
append("docs/adr/0056.md",
  "- **P28-4b notes.** `cli set-pin --operator-id N` gives the operator a random PIN (--length 6 to 12 digits, 6 by default) that is printed once; --prompt reads a typed PIN twice with getpass instead. A PIN is never an argument, so it is not in a shell history. Only the scrypt hash and salt are stored. It clears the failure count and the 15-minute lock (this is how an administrator unlocks an operator before the lock runs out), ends that operator's login sessions, refuses a disabled operator, and writes PIN_SET offline (session_id NULL, event_seq 0). rotate-token and disable-operator now also revoke the operator's login sessions in the same transaction (rotate-token prints how many ended, before the TOKEN line). The setting session_hours (default 12, above 0 and at most 168, checked when the settings load) sets the session length; it is in HASH_EXCLUDED, so changing it does not end a shift. It lives in host/config/settings.json and s01-settings.md; the design docx is not touched. HostPort reads it for every new session; sessions already made keep their own expiry.");
append("docs/PROGRESS.md",
  "- Part 28-4b done (ADR 0056): `cli set-pin --operator-id N [--length 6..12 | --prompt]` (random PIN shown once, or typed twice and hidden; scrypt hash only; clears the lock and failure count, ends the operator's login sessions, writes PIN_SET offline); rotate-token and disable-operator revoke the operator's login sessions; the session_hours setting (default 12, range above 0 to 168, validated at load, in HASH_EXCLUDED) is read by HostPort for each new session. New tests: test_cli_pin.py, test_session_hours.py and one in test_host_port_pin.py; the key counts in test_settings.py and test_gen_constants.py go from 36 to 37 (HASH_EXCLUDED 17 to 18). No dashboard change yet (P28-5).");

try { apply(); } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
