// patches/part_doc_review_decisions.mjs  (run from repo root: node patches/part_adr0067_audio_probe_result.mjs [--dry] [--force])
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force');
const plan = [];
const abs = (p) => path.join(ROOT, p);
const put = (p, content) => plan.push({ op: 'put', p, content });
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
      if (cur.includes(s.newStr)) log.push(`skip      ${s.p} (already applied)`);
      else if (n === 1) { state.set(s.p, cur.replace(s.oldStr, () => s.newStr)); log.push(`edit      ${s.p}`); }
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
append("docs/adr/0032.md", "\n## Review decision (2026-11-28)\n\nDecided by the project owner (design-review preparation: \"decide what is best\"): **option (b), keep the interim rule.** A unit not committed within `commit_wait_ms` is held in `Wire.pending`; a row the writer rejected sends no message and its `event_seq` goes into `Wire.unpersisted`. Option (a) is not built: it changes `models.py`, `ws.schema.json`, `ws.ts` and the dashboard for a case the host alarm does not depend on, and the node card still shows its level while an alert message is held. The wording of design 1 (\"carries `unpersisted=1`\") is to be amended at the next design revision (the .docx stays frozen). Revisit only if the trial shows alert cards arriving late. Status stays Proposed until the design review.\n");
append("docs/adr/0033.md", "\n## Review decision (2026-11-28)\n\nThe OPEN `unpersisted` item is decided in ADR 0032: option (b), keep the interim rule.\n");
append("docs/adr/0043.md", "\n## Review decision (2026-11-28)\n\nDecided by the project owner (design-review preparation): **fix it, do not write an exception.** Only a mouse click selects a node from an alert card; a keyboard user cannot. The fix, as its own small part: make the heading (alias and level) of `AlertCard.tsx` a real `<button type=\"button\">` that calls `onSelect`; keep the card-wide click for the mouse, with a comment that the keyboard path is the heading button; do not give the whole card `role=\"button\"`, because Acknowledge and Resolve inside it would be nested interactive elements. In the same part, turn on Biome's accessibility rules so it cannot return unnoticed. Not built yet. Status stays Proposed until the design review.\n");
replace("docs/adr/0056.md", "Status: Proposed (the four decisions below are the suggested defaults; confirm them or change them before P28-3).", "Status: Decided (the four decisions below were confirmed by the project owner in design-review preparation, 2026-11-28; P28-3 and P28-4a were built on them).");
append("docs/adr/0056.md", "\n## Review decision (2026-11-28)\n\nDecisions 1 to 4 are confirmed as written: 12 hours with the `session_hours` setting, a 6 to 12 digit PIN stored as a salted scrypt hash, a 15-minute lock after 5 consecutive failures on the PIN form only (the operator token is never locked, so the incident commander is never blind), and \"remember me\" off by default. The remaining parts (P28-4b onward) go ahead on these. Changing any of them later would need a new migration.\n");
append("docs/adr/0042.md", "\n## Review decision (2026-11-28)\n\nThe 500 ms dashboard share of the man-down path stays **provisional**. Confirming it is a bench measurement, not a review decision: browser performance marks over at least 100 events. Owner: the project owner, during the camera-timed bench session; the result is recorded as an ADR in the style of ADR 0066 and ADR 0067. No number is invented before then.\n");
append("docs/adr/0052.md", "\n## Review decision (2026-11-28)\n\nThe 500 ms dashboard share of the man-down path stays **provisional**. Confirming it is a bench measurement, not a review decision: browser performance marks over at least 100 events. Owner: the project owner, during the camera-timed bench session; the result is recorded as an ADR in the style of ADR 0066 and ADR 0067. No number is invented before then.\n");
append("docs/adr/0036.md", "\n## Review decision (2026-11-28)\n\nDecided by the project owner (design-review preparation): (1) The poll interval and the overflow log interval (60 s each) are **accepted for the trial**; they only drive logging, not alarms. (2) For the battery, **read it with `ctypes` and `GetSystemPowerStatus` instead of adding `psutil`**: the host is Windows-only (it uses `winsound`), so this adds no dependency to the lock files or the release folder. Without `psutil` the HOST BATTERY warning never fires, which is a worse failure than a missing feature. Not built; check the code first for whether a later part already changed this. (3) DISK_LOW stays a logged event with no banner for the trial. Status stays Proposed until the design review.\n");
append("docs/adr/0003.md", "\n## Review decision (2026-11-28)\n\nThe values are **kept as taken from the Technical Summary** for now; changing them without hardware evidence would be guesswork. The sign-off is the bench run on built hardware, with the result recorded. Not confirmable from software.\n");
append("docs/adr/0004.md", "\n## Review decision (2026-11-28)\n\nThe values are **kept as taken from the Technical Summary** for now; changing them without hardware evidence would be guesswork. The sign-off is the bench run on built hardware, with the result recorded. Not confirmable from software.\n");
append("docs/PROGRESS.md", "- Design-review decisions recorded (docs only; 2026-11-28): the six items that needed a real decision. ADR 0032 and 0033: keep the interim `unpersisted` rule (option b) and amend design 1 later. ADR 0043: fix the AlertCard keyboard selection with a heading button and turn on Biome's accessibility rules (decided, not built). ADR 0056: PIN login decisions confirmed, status Decided. ADR 0042 and 0052: the 500 ms share stays provisional until the bench measurement. ADR 0036: 60 s intervals accepted for the trial, battery to be read with ctypes GetSystemPowerStatus instead of psutil (decided, not built), DISK_LOW stays log-only. ADR 0003 and 0004: values kept, sign-off is the hardware bench. All other ADRs stay Proposed until the design review. No code, wire, setting or migration change.\n");
}
