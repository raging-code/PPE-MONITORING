// patches/part27b_3_req_ids.mjs  (run from repo root: node patches/part27b_3_req_ids.mjs [--dry])
// P27b Part 3 (ADR 0045): REQ ids in the test files, and the "Spec item has no test" check of design 8.1. Closes P27b.
// Edited (by hunks): tools/check_requirements.py (spec_without_test; firmware/tests/*.c is scanned), requirements/requirements.yaml (one header comment), host/tests/test_requirements.py (7 tests appended),
//   docs/PROGRESS.md (one bullet appended). New: docs/adr/0045.md.
// Tagged (one `Requirements:` line each, no test is renamed or changed): the Python tests in host/tests (inside the module docstring), the Vitest files in dashboard/tests and the Playwright specs in e2e/tests
//   (a `// Requirements:` comment, after the `@vitest-environment` line where a file has one), the four C tests in firmware/tests (a `/* Requirements: */` comment at the top).
// Safe to run twice (a file that already has the same line is skipped; a different Requirements line in the first lines, a Python file whose first line is not a docstring, or a hunk that does not match is refused with NOTHING WRITTEN).
// --dry writes nothing. CRLF files keep their CRLF.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), abs = (p) => path.join(ROOT, p);

// ---- which requirement each test file has tests of (judged from the file header, the test names and keyword searches; the test bodies were not all read)
const T = {
  'host/tests/test_advisory.py': ['REQ-RUL-010'],
  'host/tests/test_advisory_wire.py': ['REQ-RUL-010'],
  'host/tests/test_api_actions.py': ['REQ-API-001', 'REQ-API-008', 'REQ-RUL-002', 'REQ-RUL-004', 'REQ-SES-004'],
  'host/tests/test_api_endpoint_table.py': ['REQ-API-002'],
  'host/tests/test_api_models.py': ['REQ-API-004', 'REQ-API-010', 'REQ-API-011', 'REQ-RUL-001'],
  'host/tests/test_api_rest.py': ['REQ-API-001', 'REQ-API-008'],
  'host/tests/test_api_scba_banner.py': ['REQ-API-007', 'REQ-RUL-005'],
  'host/tests/test_api_security.py': ['REQ-SEC-001', 'REQ-SEC-002', 'REQ-SEC-004', 'REQ-SEC-005'],
  'host/tests/test_api_sessions_outage.py': ['REQ-API-012'],
  'host/tests/test_audio_files.py': ['REQ-AUD-001', 'REQ-AUD-004'],
  'host/tests/test_audio_thread.py': ['REQ-AUD-001', 'REQ-AUD-002', 'REQ-AUD-003', 'REQ-AUD-004', 'REQ-AUD-005', 'REQ-UI-004'],
  'host/tests/test_audio_wiring.py': ['REQ-AUD-003', 'REQ-AUD-004', 'REQ-AUD-005'],
  'host/tests/test_build_manifest.py': ['REQ-OPS-002'],
  'host/tests/test_checkin_scba.py': ['REQ-RUL-006'],
  'host/tests/test_ci_config.py': ['REQ-OPS-001'],
  'host/tests/test_cli_backup.py': ['REQ-DB-001'],
  'host/tests/test_cli_operators.py': ['REQ-SEC-004', 'REQ-SEC-005'],
  'host/tests/test_co_state.py': ['REQ-RUL-006'],
  'host/tests/test_co_threshold.py': ['REQ-RUL-006', 'REQ-RUL-009', 'REQ-RUL-011'],
  'host/tests/test_codec_vectors.py': ['REQ-ING-003'],
  'host/tests/test_csv_export.py': ['REQ-API-001', 'REQ-API-006', 'REQ-API-009', 'REQ-SEC-001'],
  'host/tests/test_db_schema.py': ['REQ-DB-001', 'REQ-DB-005', 'REQ-DB-006', 'REQ-RUL-001'],
  'host/tests/test_db_writer.py': ['REQ-DB-002', 'REQ-DB-003', 'REQ-DB-004'],
  'host/tests/test_e2e_config.py': ['REQ-UI-002'],
  'host/tests/test_effect_rows.py': ['REQ-RUL-002', 'REQ-RUL-008'],
  'host/tests/test_episodes.py': ['REQ-RUL-002', 'REQ-RUL-003', 'REQ-RUL-006'],
  'host/tests/test_gen_ws.py': ['REQ-API-004', 'REQ-RUL-001'],
  'host/tests/test_golden_vectors.py': ['REQ-RUL-006'],
  'host/tests/test_gv_bytes.py': ['REQ-RUL-006'],
  'host/tests/test_heat_shadow.py': ['REQ-RUL-006'],
  'host/tests/test_host_health.py': ['REQ-DB-002'],
  'host/tests/test_host_port.py': ['REQ-API-005', 'REQ-API-008', 'REQ-RUL-002', 'REQ-RUL-004'],
  'host/tests/test_ingest.py': ['REQ-DB-002', 'REQ-ING-003'],
  'host/tests/test_link_battery.py': ['REQ-RUL-003', 'REQ-RUL-006'],
  'host/tests/test_locks_lint.py': ['REQ-OPS-001', 'REQ-OPS-002'],
  'host/tests/test_man_down.py': ['REQ-RUL-006'],
  'host/tests/test_notices.py': ['REQ-RUL-007', 'REQ-RUL-008', 'REQ-RUL-011', 'REQ-RUL-012'],
  'host/tests/test_open_state.py': ['REQ-API-003', 'REQ-REC-003', 'REQ-REC-004'],
  'host/tests/test_p25_release.py': ['REQ-REC-001'],
  'host/tests/test_purge_session.py': ['REQ-SES-003'],
  'host/tests/test_recovery.py': ['REQ-REC-003'],
  'host/tests/test_recovery_run.py': ['REQ-REC-001', 'REQ-REC-002', 'REQ-REC-005'],
  'host/tests/test_runtime.py': ['REQ-REC-005', 'REQ-REC-008'],
  'host/tests/test_scba_replay.py': ['REQ-RUL-005'],
  'host/tests/test_sensor_fault.py': ['REQ-RUL-006'],
  'host/tests/test_seq_classifier.py': ['REQ-ING-004'],
  'host/tests/test_serial_reader.py': ['REQ-ING-002'],
  'host/tests/test_session_start.py': ['REQ-DB-006', 'REQ-REC-001', 'REQ-REC-007'],
  'host/tests/test_sessions.py': ['REQ-REC-004', 'REQ-SES-002', 'REQ-SES-003', 'REQ-SES-004'],
  'host/tests/test_startup.py': ['REQ-REC-007'],
  'host/tests/test_wire.py': ['REQ-API-007', 'REQ-API-011'],
  'host/tests/test_wire_2b1.py': ['REQ-API-007'],
  'host/tests/test_ws_hub.py': ['REQ-API-005', 'REQ-API-010', 'REQ-API-011', 'REQ-SEC-001', 'REQ-SEC-004'],
  'dashboard/tests/a11y_static.test.ts': ['REQ-UI-007'],
  'dashboard/tests/ack_cards.test.tsx': ['REQ-API-003', 'REQ-UI-003', 'REQ-UI-009'],
  'dashboard/tests/ack_logic.test.ts': ['REQ-API-003', 'REQ-UI-009'],
  'dashboard/tests/alert_rules.test.ts': ['REQ-RUL-004', 'REQ-UI-001'],
  'dashboard/tests/banners.test.ts': ['REQ-API-007', 'REQ-UI-008'],
  'dashboard/tests/banners_ui.test.tsx': ['REQ-API-007', 'REQ-UI-008'],
  'dashboard/tests/bridge_login.test.ts': ['REQ-SEC-003'],
  'dashboard/tests/cards.test.tsx': ['REQ-UI-001'],
  'dashboard/tests/cards_group.test.ts': ['REQ-UI-001', 'REQ-UI-003'],
  'dashboard/tests/catalog.test.ts': ['REQ-RUL-001'],
  'dashboard/tests/controller.test.ts': ['REQ-SEC-003'],
  'dashboard/tests/gate.test.ts': ['REQ-AUD-001', 'REQ-AUD-002'],
  'dashboard/tests/gate_ui.test.tsx': ['REQ-AUD-001'],
  'dashboard/tests/hotspots.test.ts': ['REQ-UI-005'],
  'dashboard/tests/jacket.test.tsx': ['REQ-UI-005', 'REQ-UI-006'],
  'dashboard/tests/layout_ui.test.tsx': ['REQ-UI-003', 'REQ-UI-008', 'REQ-UI-010'],
  'dashboard/tests/readings_logic.test.ts': ['REQ-SES-001', 'REQ-UI-001'],
  'dashboard/tests/reducer.test.ts': ['REQ-API-004', 'REQ-UI-001'],
  'dashboard/tests/shift_logic.test.ts': ['REQ-SES-001', 'REQ-SES-002', 'REQ-SES-004'],
  'dashboard/tests/shift_ui.test.tsx': ['REQ-SES-001', 'REQ-SES-002', 'REQ-SES-004'],
  'dashboard/tests/sidepanel_ui.test.tsx': ['REQ-SES-001', 'REQ-UI-001'],
  'dashboard/tests/socket.test.ts': ['REQ-API-004'],
  'dashboard/tests/trend_logic.test.ts': ['REQ-UI-008'],
  'dashboard/tests/watchdog.test.ts': ['REQ-UI-001', 'REQ-UI-009'],
  'dashboard/tests/watchdog_ui.test.tsx': ['REQ-UI-001', 'REQ-UI-009'],
  'e2e/tests/no_live_data.spec.ts': ['REQ-UI-002'],
  'e2e/tests/start_monitoring.spec.ts': ['REQ-AUD-001', 'REQ-UI-002'],
  'firmware/tests/test_frame.c': ['REQ-FW-001'],
  'firmware/tests/test_nvs.c': ['REQ-FW-003', 'REQ-FW-004'],
  'firmware/tests/test_rules_fw.c': ['REQ-FW-002'],
  'firmware/tests/test_scba.c': ['REQ-FW-002'],
};

// ---- hunks in files that already exist
const EDITS = {
  'tools/check_requirements.py': [
    ['  - a test file names an id that is not in the file. Test files are host/tests/*.py, dashboard/tests/*.ts(x) and e2e/tests/*.ts.',
     '  - a requirement with status Spec has no test that names it (design 8.1, P27b-3; Proposed and Decided are not checked);\n  - a test file names an id that is not in the file. Test files are host/tests/*.py, dashboard/tests/*.ts(x), e2e/tests/*.ts and firmware/tests/*.c.'],
    ['(information only: P27b-3 adds the ids to the test names and the "Spec item has no test" check)', '(information only; the ids sit in the module docstring or a header comment of each test file, P27b-3, ADR 0045)'],
    ["('e2e/tests', '*.ts'))", "('e2e/tests', '*.ts'), ('firmware/tests', '*.c'))"],
    ['def check(root=ROOT):',
     'def spec_without_test(doc, used):\n    """One line per requirement with status Spec that no test file names (design 8.1: CI fails when a Spec item has no test)."""\n    return [\'%s: %s is Spec and no test names it\' % (FILE.as_posix(), r[\'id\']) for r in doc[\'requirements\'] if isinstance(r, dict) and r.get(\'status\') == \'Spec\' and r.get(\'id\') not in used]\n\ndef check(root=ROOT):'],
    ['    for tok, where in sorted(scan(root).items()):', '    used = scan(root)\n    for tok, where in sorted(used.items()):'],
    ['    return bad, doc\n\ndef main(argv):', "    if isinstance(doc, dict) and isinstance(doc.get('requirements'), list): bad += spec_without_test(doc, used)\n    return bad, doc\n\ndef main(argv):"],
  ],
  'requirements/requirements.yaml': [
    ['# A test names a requirement by writing its id in the test name or docstring (P27b-3 adds those).',
     '# A test file names a requirement with one `Requirements:` line: in the module docstring (Python), a header comment (TypeScript, C). P27b-3, ADR 0045.'],
  ],
};

const refuse = [], out = [], writes = [];
const lf = (s) => s.replace(/\r\n/g, '\n');
const keep = (raw, t) => (raw.includes('\r\n') ? t.replace(/\n/g, '\r\n') : t);

// ---- the hunks
for (const [rel, hunks] of Object.entries(EDITS)) {
  if (!fs.existsSync(abs(rel))) { refuse.push(`${rel}: not found (run from the repo root)`); continue; }
  const raw = fs.readFileSync(abs(rel), 'utf8'); let t = lf(raw), n = 0, bad = false;
  hunks.forEach(([oldT, newT], i) => {
    const c = t.split(oldT).length - 1;
    if (t.includes(newT)) { /* already there */ }
    else if (c === 1) { t = t.replace(oldT, () => newT); n++; }
    else { refuse.push(`${rel}: hunk ${i + 1} does not match (${c} places); the file is not in the P27b-2 state`); bad = true; }
  });
  if (bad) continue;
  if (n) writes.push([rel, keep(raw, t)]);
  out.push(`${n ? 'edit   ' : 'already'} ${rel}${n ? ` (${n} hunk${n > 1 ? 's' : ''})` : ''}`);
}

// ---- the Requirements line in each test file
const tagged = { py: 0, ts: 0, c: 0 }, skipped = [];
for (const [rel, ids] of Object.entries(T)) {
  if (!fs.existsSync(abs(rel))) { refuse.push(`${rel}: not found`); continue; }
  const raw = fs.readFileSync(abs(rel), 'utf8'), L = lf(raw).split('\n'), line = 'Requirements: ' + ids.join(', ');
  const have = /Requirements: (REQ-[A-Z]{2,3}-\d{3}(?:, REQ-[A-Z]{2,3}-\d{3})*)/.exec(L.slice(0, 6).join('\n'));
  if (have) { if (have[1] === ids.join(', ')) skipped.push(rel); else refuse.push(`${rel}: has a Requirements line with other ids (${have[1]})`); continue; }
  const first = L[0], kind = rel.endsWith('.py') ? 'py' : rel.endsWith('.c') ? 'c' : 'ts';
  if (kind === 'py') {
    const q = (first.match(/"""/g) || []).length;
    if (!first.startsWith('"""') || q > 2) { refuse.push(`${rel}: the first line is not the start of a plain docstring`); continue; }
    let k = 0;                                                                       // the line that closes the docstring
    if (q === 1) { k = L.findIndex((l, i) => i > 0 && l.includes('"""')); if (k < 1 || (L[k].match(/"""/g) || []).length !== 1) { refuse.push(`${rel}: cannot find the end of the module docstring`); continue; } }
    if (L[k].trim() === '"""') L.splice(k, 0, line + '.');                          // the closing quotes are alone on their line
    else if (/"""\s*$/.test(L[k])) L[k] = L[k].replace(/"""\s*$/, ' ' + line + '."""');
    else { refuse.push(`${rel}: the module docstring does not end its closing line`); continue; }
  } else if (kind === 'c') L.unshift('/* ' + line + ' */');
  else L.splice(/@vitest-environment/.test(first) ? 1 : 0, 0, '// ' + line);
  writes.push([rel, keep(raw, L.join('\n'))]); tagged[kind]++;
}
out.push(`tag     ${tagged.py} Python, ${tagged.ts} TypeScript and ${tagged.c} C test files${skipped.length ? ` (${skipped.length} already tagged)` : ''}`);

// ---- what the tags add up to (read from the requirements file, never from memory)
const yamlPath = abs('requirements/requirements.yaml');
let allIds = [], hazards = [];
if (fs.existsSync(yamlPath)) {
  const y = lf(fs.readFileSync(yamlPath, 'utf8'));
  allIds = [...y.matchAll(/^  - id: (REQ-[A-Z]{2,3}-\d{3})$/gm)].map((m) => m[1]);
  hazards = [...y.matchAll(/^  (H\d+):\n    title: .*\n    requirements: \[(.*)\]$/gm)].map((m) => [m[1], m[2].split(',').map((s) => s.trim())]);
}
const named = new Set(Object.values(T).flat()), unknown = [...named].filter((i) => !allIds.includes(i));
if (unknown.length) refuse.push('the mapping names ids that are not in requirements.yaml: ' + unknown.join(', '));
const unnamed = allIds.filter((i) => !named.has(i)), deadHazards = hazards.filter(([, rs]) => !rs.some((r) => named.has(r))).map(([h]) => h);
const thin = hazards.filter(([, rs]) => rs.some((r) => named.has(r)) && rs.some((r) => !named.has(r))).map(([h, rs]) => `${h} ${rs.filter((r) => named.has(r)).length} of ${rs.length}`);
const nFiles = Object.keys(T).length, short = (s) => s.replace(/^REQ-/, '');
const cnt = (kind, re) => tagged[kind] + skipped.filter((s) => re.test(s)).length, cPy = cnt('py', /\.py$/), cTs = cnt('ts', /\.tsx?$/), cC = cnt('c', /\.c$/);

// ---- the tests appended to host/tests/test_requirements.py
const sortedNamed = [...named].sort().map(short);
const idLines = []; for (let i = 0; i < sortedNamed.length; i += 10) idLines.push("    '" + sortedNamed.slice(i, i + 10).join(' ') + (i + 10 < sortedNamed.length ? ' ' : '') + "'");
const TESTS = [
  '',
  '# ---- P27b-3 (ADR 0045): ids in the test files, the Spec check, the firmware tests ----',
  '# The ids of the requirements that tests name today, without the prefix, so that this file names none of them itself. A tag must not be dropped by accident.',
  'NAMED_TODAY = (',
  ...idLines,
  ').split()',
  "def with_status(status, rid='API-001'):",
  '    d = doc()',
  "    for r in d['requirements']:",
  "        if r['id'] == P + rid: r['status'] = status",
  '    return d',
  '',
  'def test_a_spec_requirement_that_no_test_names_is_reported_by_its_id(tmp_path):',
  "    assert problems(tmp_path, with_status('Spec')) == ['requirements/requirements.yaml: %sAPI-001 is Spec and no test names it' % P]",
  '',
  'def test_a_spec_requirement_that_a_test_file_names_passes(tmp_path):',
  "    assert problems(tmp_path, with_status('Spec'), {'host/tests/test_a.py': '\"\"\"Requirements: %sAPI-001.\"\"\"\\n' % P}) == []",
  '',
  'def test_proposed_and_decided_requirements_need_no_test(tmp_path):',
  "    assert problems(tmp_path / 'a', with_status('Proposed')) == [] and problems(tmp_path / 'b', with_status('Decided')) == []",
  '',
  'def test_only_the_spec_status_is_checked_so_one_missing_test_is_one_line(tmp_path):',
  "    d = with_status('Spec'); d['requirements'][0]['status'] = 'Spec'",
  "    assert len(problems(tmp_path, d)) == 2                                                    # the first requirement and API-001, nothing else of the other 72",
  '',
  'def test_a_c_test_in_firmware_tests_is_scanned_and_an_unknown_id_in_it_is_reported(tmp_path):',
  "    assert problems(tmp_path, tests={'firmware/tests/t.c': '/* %sZZZ-999 */\\n' % P}) == ['firmware/tests/t.c:1: %sZZZ-999 is not in requirements/requirements.yaml' % P]",
  '',
  'def test_every_id_in_a_python_test_file_sits_in_the_module_docstring():',
  '    import ast',
  "    for p in sorted((ROOT / 'host' / 'tests').glob('*.py')):",
  "        text = p.read_text(encoding='utf-8'); ids = set(CR.LOOSE.findall(text))",
  "        if ids: assert ids <= set(CR.LOOSE.findall(ast.get_docstring(ast.parse(text)) or '')), p.name",
  '',
  'def test_the_requirements_that_tests_name_today_stay_named():',
  '    assert {P + x for x in NAMED_TODAY} <= set(CR.scan(ROOT))',
  '',
].join('\n');
{
  const rel = 'host/tests/test_requirements.py';
  if (!fs.existsSync(abs(rel))) refuse.push(`${rel}: not found`);
  else {
    const raw = fs.readFileSync(abs(rel), 'utf8'); let t = lf(raw);
    if (t.includes('def test_the_requirements_that_tests_name_today_stay_named')) out.push(`already ${rel}`);
    else { if (!t.endsWith('\n')) t += '\n'; writes.push([rel, keep(raw, t + TESTS)]); out.push(`edit    ${rel} (7 tests appended)`); }
  }
}

// ---- the ADR and the PROGRESS bullet
const list = (a) => (a.length ? a.join(', ') : 'none');
const ADR = [
  '# ADR 0045: requirement ids in the tests and the Spec check (P27b-3)',
  '',
  'Status: Proposed (decided in the P27b sessions; confirm at the next design review).',
  `Design: Rev 3.45 is frozen (8.1: "Test names and docstrings include the REQ ID, and CI fails if an ID in a test is missing from the file, or a Spec item has no test"). No host behaviour, frame, migration, constant, setting or REST route changes, and no test is renamed or changed. This closes P27b (ADR 0043: lock files and lint; ADR 0044: the file, the hazard map and the unknown-id check).`,
  '',
  `- **Where an id goes.** One line per test file, \`Requirements: REQ-..., REQ-...\`: inside the module docstring of a Python test, as a \`//\` comment at the top of a Vitest or Playwright file (after the \`@vitest-environment\` line where there is one), as a \`/* */\` comment at the top of a C test. ${nFiles} files carry one (${cPy} Python, ${cTs} TypeScript, ${cC} C). The ids are not put into the names of single tests: that would rename about 1,350 tests whose names already say what they check, and the design asks for "names and docstrings", which a docstring line meets. The check reads any id-shaped token, so a test that names an id in its own name or docstring later is counted the same way.`,
  '- **What a tag means, and what it does not.** The file holds at least one test of that design 8 row. It does not say the row is fully covered. The mapping was made from the file headers, the test names and keyword searches; **the test bodies were not all read**, so it is a Proposed mapping like the hazard map of ADR 0044. Known partial cases: REQ-UI-004 is named by the host alarm tests only (broadcast to host alarm within 300 ms; the 500 ms pop-up half of the row has no test, ADR 0042); REQ-RUL-009 is named by the CO hold tests of the rule engine only (no test checks the Held label text on the card); REQ-FW-004 is named by the NVS test that builds the boot frame, not by a watchdog or brown-out scenario.',
  `- **Spec check.** \`spec_without_test\` in \`tools/check_requirements.py\`: one line, \`requirements/requirements.yaml: REQ-X-nnn is Spec and no test names it\`, for each requirement with status Spec that no test file names; exit 1. Proposed and Decided are not checked, as the design says "a Spec item". All ${allIds.length} requirements are still Proposed (ADR 0044), so on the real tree the check has nothing to check, and that is the honest state. Four new tests prove it works: a Spec requirement with no test is reported by id, the same one passes when a test file names it, Proposed and Decided need no test, and only the Spec ones are counted.`,
  '- **Firmware tests are scanned.** `firmware/tests/*.c` joins `host/tests`, `dashboard/tests` and `e2e/tests`, because the D-FW rows (REQ-FW-001 to REQ-FW-004) are tested only in C. The four C files got a comment line; nothing else in them changed.',
  '- **Two guards on the tags.** `test_every_id_in_a_python_test_file_sits_in_the_module_docstring` keeps the convention (a stray id in a comment of a Python test fails it). `test_the_requirements_that_tests_name_today_stay_named` fails when a tag is removed; the ids are listed without the `REQ-` prefix so the test file itself names none, and so cannot make every requirement look covered.',
  `- **Not named by any test today (${unnamed.length} of ${allIds.length}):** ${list(unnamed)}. REQ-FW-005 (cross-chip PHY, D9) and REQ-ML-001 (model file, Tier 2, D12) are not host tests by design. For REQ-ING-001 (mode isolation) and REQ-REC-006 (motion-state restart) I found no test by keyword; one may exist under another name, or they are missing. \`python tools/check_requirements.py --report\` lists them at any time.`,
  `- **Hazards (design 7).** Hazards with no named requirement at all: ${list(deadHazards)}. Hazards where only some of their requirements are named: ${list(thin)}. A hazard whose only tests are D9 or D11 (soak, hardware) cannot be covered by this repository, as ADR 0044 says.`,
  '- **Checked here (development sandbox, Linux).** The patch runs and is safe to run twice; the check passes on the patched tree; every tagged Python file still parses and holds its line in its module docstring; the new tests ran under a minimal stand-in for pytest (no network, so pytest, ruff and the Vitest and Playwright runs were not available). **Not run:** the full pytest suite, ruff, Vitest, Playwright, the firmware gcc tests, Windows, GitHub Actions. The comment lines in the TypeScript, C and YAML files cannot change what a test does, but the first real runs are the operator\'s.',
  '- **Open, please confirm.** (1) One line per file, not an id in each test name. (2) The mapping of files to requirements, especially the partial cases above. (3) That `firmware/tests/*.c` is scanned. (4) Whether the first rows should be promoted to Spec at the next design review, which is what turns the Spec check on. (5) What to do about the requirements no test names.',
  '',
].join('\n');
const PROG = `- Part 27b-3 done (ADR 0045; P27b complete): the ids sit in the tests: ${nFiles} test files carry one \`Requirements:\` line (${cPy} Python inside the module docstring, ${cTs} Vitest and Playwright files and ${cC} firmware C tests as a header comment); no test is renamed or changed; ${named.size} of ${allIds.length} requirements are named by at least one test, not named: ${list(unnamed)}; tools/check_requirements.py now also fails (exit 1) for a requirement with status Spec that no test names, and scans firmware/tests/*.c; host/tests/test_requirements.py has 7 more tests (the Spec check in four cases, a C file is scanned, ids only in module docstrings, the named ones stay named); docs/adr/0045.md (Proposed); all ${allIds.length} requirements are still Proposed, so the Spec check has nothing to check yet; the file to requirement mapping is judged from headers and test names, the bodies were not all read; the sandbox had no network, so the full pytest suite, ruff, Vitest, Playwright and the firmware gcc tests were NOT run after this part; NOT run on Windows or in GitHub Actions; open for the operator: the mapping, partial cases (REQ-UI-004, REQ-RUL-009, REQ-FW-004), the unnamed requirements, promoting rows to Spec, firmware tests scanned\n`;
{
  const rel = 'docs/adr/0045.md', have = fs.existsSync(abs(rel)) ? lf(fs.readFileSync(abs(rel), 'utf8')) : null;
  if (have === null) { writes.push([rel, ADR]); out.push(`new     ${rel}`); }
  else if (have === ADR) out.push(`already ${rel}`); else refuse.push(`${rel}: exists with other content, not overwritten`);
  const pr = 'docs/PROGRESS.md';
  if (!fs.existsSync(abs(pr))) refuse.push(`${pr}: not found`);
  else {
    const raw = fs.readFileSync(abs(pr), 'utf8'); let t = lf(raw);
    if (t.includes('Part 27b-3 done')) out.push(`already ${pr}`);
    else { if (!t.endsWith('\n')) t += '\n'; writes.push([pr, keep(raw, t + PROG)]); out.push(`edit    ${pr} (1 bullet appended)`); }
  }
}

console.log(out.join('\n'));
console.log(`\n${named.size} of ${allIds.length} requirements named. Not named: ${list(unnamed)}. Hazards with nothing named: ${list(deadHazards)}.`);
if (refuse.length) { console.error('\nNOTHING WRITTEN:\n' + refuse.join('\n')); process.exit(1); }
if (DRY) { console.log(`\n--dry: ${writes.length} file(s) would be written, nothing was.`); process.exit(0); }
for (const [rel, text] of writes) { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), text, 'utf8'); }
console.log(`\nwrote ${writes.length} file(s).${writes.length ? '\nNext: python tools/check_requirements.py --report, python -m ruff check host tools, python -m pytest host/tests -q, then (dashboard) npm run lint and npm test, and the firmware gcc tests if you run them' : ' Nothing to do.'}`);
