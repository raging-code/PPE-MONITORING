// patches/part19c_4_banner_conflict.mjs  (run from repo root: node patches/part19c_4_banner_conflict.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
const replace = (p, oldStr, newStr) => plan.push({ op: 'replace', p, oldStr, newStr });
const append = (p, text) => plan.push({ op: 'append', p, text });
function apply() {
  const state = new Map(), log = [];
  const get = (p) => state.has(p) ? state.get(p) : (fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && cur !== s.content && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : cur === s.content ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) {
      throw new Error(`MISSING file: ${s.p}`);
    } else if (s.op === 'replace') {
      const n = cur.split(s.oldStr).length - 1;
      if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
      else if (n === 0 && cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else throw new Error(`ANCHOR found ${n} times in ${s.p}: ${s.oldStr.slice(0, 60)}`);
    } else if (s.op === 'append') {
      if (cur.includes(s.text)) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : '\n') + s.text); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n'));
  console.log(DRY ? 'DRY RUN: nothing written' : `OK: ${state.size} file(s) written`);
}
try { await run(); apply(); } catch (e) { console.error('PATCH FAILED, nothing written:', e.message); process.exit(1); }

// ---- write only this part below ----
async function run() {
  replace('host/ppe_host/api/api_rest.py', '...  # idempotent while the banner is active (first time kept); ApiError STATE_CONFLICT when it is not', '...  # ApiError STATE_CONFLICT when the banner is not active or is already acknowledged (design 3.8 error-code list)');
  replace('host/ppe_host/api/api_rest.py', '  # idempotent while the banner is active; the port raises ApiError STATE_CONFLICT when it is not', '  # the port raises ApiError STATE_CONFLICT for a banner that is not active or is already acknowledged; a refused call writes no audit row');
  replace('host/tests/test_api_scba_banner.py', '        return R.BannerAck(kind, self.acked.setdefault(kind, 9000))      # a repeat keeps the first time', "        if kind in self.acked: raise R.ApiError(409, 'STATE_CONFLICT', 'banner is already acknowledged')      # design 3.8: already in the target state\n        self.acked[kind] = 9000; return R.BannerAck(kind, 9000)");
  replace('host/tests/test_api_scba_banner.py', "def test_banner_ack_accepts_no_body_and_a_repeat_returns_the_first_time(rig):\n    client, port = rig; a = post(client, '/api/system-banners/host_gap/ack'); port.acked['host_gap'] = 9000; b = post(client, '/api/system-banners/host_gap/ack', {})\n    assert a.status_code == b.status_code == 200 and a.json() == b.json()\n", "def test_banner_ack_accepts_no_body_and_a_second_ack_of_the_same_banner_is_409_state_conflict_with_no_second_audit_row(rig):\n    client, port = rig; a = post(client, '/api/system-banners/host_gap/ack'); b = post(client, '/api/system-banners/host_gap/ack', {})\n    assert a.status_code == 200 and b.status_code == 409 and envelope(b)['error_code'] == 'STATE_CONFLICT' and [x[0] for x in port.audits] == ['BANNER_ACK']\n");
  replace('docs/adr/0011.md', 'Banner ack: acknowledging an active banner again returns the first `acknowledged_ts`; the host sends', 'Banner ack: acknowledging a banner that is already acknowledged is a 409 STATE_CONFLICT (see below); the host sends');
  replace('docs/adr/0011.md', 'a banner that is not active gives 409 STATE_CONFLICT (proposal: nothing to acknowledge)', 'a banner that is not active, or is already acknowledged, gives 409 STATE_CONFLICT (the error-code list of 3.8 names a banner acknowledge on an item already in the target state; P19c-4 corrected the first version, which made a repeat an idempotent 200)');
  replace('docs/adr/0011.md', 'A repeat acknowledgement is audited again, as `ACK_ALERT` is. ', 'A refused acknowledgement writes no audit row. ');
  append('docs/PROGRESS.md', '- Part 19c-4 done: correction of P19c-2: a banner acknowledge on a banner that is already acknowledged is 409 STATE_CONFLICT (design 3.8 error-code list), not an idempotent 200; Port.ack_banner comment, the fake port and the repeat test in test_api_scba_banner.py and ADR 0011 updated; no route logic changed');
}
