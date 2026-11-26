// patches/part24_3b2b3_adr0033.mjs  (run from repo root: node patches/part24_3b2b3_adr0033.mjs [--dry] [--force])
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
const putB64 = (p, b64) => put(p, Buffer.from(b64, 'base64').toString('utf8'));
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
  putB64('docs/adr/0033.md', 'IyBBRFIgMDAzMzogTGluaywgc3lzdGVtIGFuZCBhZHZpc29yeSBtZXNzYWdlcyAoUDI0LTNiLTJiKSBhbmQgd2hhdCBzdGF5cyBvcGVuCgpTdGF0dXM6IFByb3Bvc2VkIChkZWNpZGVkIGluIHRoZSBQMjQtM2ItMmIgc2Vzc2lvbnM7IGNvbmZpcm0gYXQgdGhlIG5leHQgZGVzaWduIHJldmlldykuCkRlc2lnbjogUmV2IDMuNDUgaXMgZnJvemVuLiBOb3RoaW5nIGluIHRoZSBmcmFtZSwgdGhlIG1pZ3JhdGlvbiwgYGNvbnN0YW50cy5qc29uYCwgdGhlIHNldHRpbmdzIGtleXMgb3IgYGFwaS9tb2RlbHMucHlgIGNoYW5nZXMuCgotICoqU3BsaXQgb2YgUDI0LTNiLTJiIChkb25lKS4qKiAyYi1pIGBsaW5rYCBhbmQgYHN5c3RlbWAgbWVzc2FnZXMgKGB3aXJlLnB5YCwgdGVzdF93aXJlXzJiMS5weSk7IDJiLWlpIGFkdmlzb3J5IHJvd3MgYW5kIHRoZSBgYWR2aXNvcnlgIG1lc3NhZ2UgKGBpby9pbmdlc3QucHlgLCBgd2lyZS5weWAsIHRlc3RfYWR2aXNvcnlfd2lyZS5weSk7IDJiLWlpaSB0aGlzIEFEUiBhbmQgdGhlIGRvYyB0b3VjaC11cHMuIFAyNC0zYyAoc3RlcHMgOCB0byAxMCkgaXMgdW5jaGFuZ2VkLgotICoqTGluayBtZXNzYWdlcy4qKiBgV2lyZS5saW5rX3N0YXRlKG5vZGUpYCBpcyBkZXJpdmVkIGZyb20gdGhlIGVuZ2luZSAoYG5vdF9jb25uZWN0ZWRgLCBgb2tgLCBgd2Vha19zaWduYWxgLCBgc2lnbmFsX2xvc3RgLCBgbGlua19sb3N0YCwgYHJlY292ZXJlZGApLiBPbmUgYGxpbmtgIG1lc3NhZ2UgZ29lcyBvdXQgcGVyIGNoYW5nZSwgbm90IHBlciBmcmFtZSwgYW5kIHRoZSBzbmFwc2hvdCBjYWxscyB0aGUgc2FtZSBmdW5jdGlvbiwgc28gYSBzbmFwc2hvdCBhbmQgdGhlIGxpdmUgbWVzc2FnZXMgY2Fubm90IGRpc2FncmVlLiBBdCBgYXR0YWNoKClgIHRoZSBjdXJyZW50IHN0YXRlcyBhcmUgcmVjb3JkZWQgYXMgYWxyZWFkeSBrbm93biwgc28gYSBzdGFydC11cCBzZW5kcyBubyBtZXNzYWdlLgotICoqU3lzdGVtIG1lc3NhZ2VzLioqIFRoZSBib2R5IGlzIGJ1aWx0IGZyb20gSGVhbHRoIChiYXNlKSwgdGhlIHJlY292ZXJpbmcgZmxhZywgdGhlIHNlc3Npb24sIGFuZCB0aGUgYmFubmVyIHNvdXJjZXMuIEEgbmV3IG1lc3NhZ2UgaXMgc2VudCBvbmx5IHdoZW4gdGhlIGJvZHkgY2hhbmdlcywgZXhjZXB0IGByZWplY3RlZF9mcmFtZXNgLCB3aGljaCByaWRlcyBvbiB0aGUgMSBIeiBgV2lyZS50aWNrKClgIG9ubHkuIGBCQU5ORVJfQUNLYCBnb2VzIG91dCBhdCBvbmNlIGZyb20gYEhvc3RQb3J0LmFja19iYW5uZXJgLCBub3Qgb24gdGhlIG5leHQgdGljay4KLSAqKkh1YiBtZXRob2RzIGFyZSBvcHRpb25hbC4qKiBgcHVibGlzaF9saW5rYCwgYHB1Ymxpc2hfc3lzdGVtYCBhbmQgYHB1Ymxpc2hfYWR2aXNvcnlgIGFyZSBjYWxsZWQgb25seSB3aGVuIHRoZSBodWIgaGFzIHRoZW0sIHNvIGFuIG9sZGVyIGh1YiBvciBhIHRlc3QgaHViIGtlZXBzIHdvcmtpbmcuCi0gKipBZHZpc29yeSBpcyBvZmYgdW50aWwgYSBXaXJlIHR1cm5zIGl0IG9uIChkZWNpc2lvbikuKiogYEluZ2VzdC5hZHZfY2ZnYCBpcyBgTm9uZWAgYnkgZGVmYXVsdCBhbmQgYGFkdmlzb3J5X3N0ZXBgIGlzIHNraXBwZWQgd2hpbGUgaXQgaXMgYE5vbmVgLiBgV2lyZS5lbmFibGVfYWR2aXNvcnkoaGVhcnRiZWF0X3MpYCBmb3J3YXJkcyB0byBgSW5nZXN0LmVuYWJsZV9hZHZpc29yeWAsIHdoaWNoIGlzIGlkZW1wb3RlbnQ7IGEgc2Vjb25kIGNhbGwgcmVwbGFjZXMgdGhlIGNvbmZpZyB3aXRob3V0IHJlc2V0dGluZyBgQWR2aXNvcnlTdGF0ZWAuIE5vdGhpbmcgaW4gdGhlIGhvc3QgY2FsbHMgaXQgeWV0OiBQMjQtM2MgcGFzc2VzIGBhZHZpc29yeV9oZWFydGJlYXRfc2AgZnJvbSBgc2V0dGluZ3MuanNvbmAgd2hlbiBpdCBidWlsZHMgdGhlIGhvc3QuIFRoZSB2YWx1ZSAzMDAgaXMgc3RpbGwgb24gdGhlIHNpZ24tb2ZmIGxpc3QgKENvZGluZyBHdWlkZSBzZWN0aW9uIDYpLgotICoqV2hlcmUgdGhlIHJvdyBpcyB3cml0dGVuLioqIGBhZHZpc29yeV9zdGVwYCBydW5zIGFmdGVyIGBzdGVwKClgIG9uIGV2ZXJ5IGBmcmFtZSgpYCBhbmQgYHRpY2soKWAgYW5kIGl0cyBgQWR2aXNvcnlSb3dgIGVmZmVjdHMgZ2V0IG9uZSBgYWR2aXNvcnlfc3VtbWFyaWVzYCByb3cgZWFjaCwgaW4gdGhlIHNhbWUgdW5pdCBhcyB0aGUgZnJhbWUgb3IgdGljayAoc28gc2FtZSBjb21taXQsIHN0cmljdCBgZXZlbnRfc2VxYCBvcmRlcikuIGBzb3VyY2VgIGlzIGFsd2F5cyBgdGFibGVgIGFuZCBgcGFzc2FnZV9pZHNgIHN0YXlzIE5VTEwgaW4gVGllciAxLgotICoqTm8gcmVhZC1iYWNrLioqIEFsZXJ0cyBhbmQgZXBpc29kZXMgYXJlIHJlYWQgYmFjayBmcm9tIHRoZWlyIHJvd3MgYmVjYXVzZSB0aGUgZGFzaGJvYXJkIG5lZWRzIHRoZSBkYXRhYmFzZSBpZC4gQW4gYWR2aXNvcnkgcm93IGhhcyBubyBpZCBvbiB0aGUgd2lyZSAoMy44KSwgc28gaXRzIG1lc3NhZ2UgaXMgYnVpbHQgc3RyYWlnaHQgZnJvbSB0aGUgZWZmZWN0LgotICoqS25vd24gd2VhayB0ZXN0LioqIGB0ZXN0X2FfdGlja19hbHNvX3J1bnNfYWR2aXNvcnlfc3RlcF9vbmNlX2VuYWJsZWRgIG9ubHkgYXNzZXJ0cyBgPj0gbjBgLiBBIHNoYXJwZXIgY2hlY2sgKGFkdmFuY2UgdGhlIEZha2VDbG9jayBwYXN0IGBhZHZpc29yeV9oZWFydGJlYXRfc2AsIHRoZW4gZXhwZWN0IGEgdW5pdCBhbmQgZXhhY3RseSBvbmUgbmV3IHJvdykgaXMgbGVmdCBmb3IgUDI0LTNjLCB3aGVuIHRoZSByZWFsIGRyaXZlciBleGlzdHMuCi0gKipTdGlsbCBPUEVOICh1bmNoYW5nZWQgZnJvbSBBRFIgMDAzMik6IGB1bnBlcnNpc3RlZGAuKiogVGhlIHdpcmUgc3RpbGwgaGFzIG5vIGB1bnBlcnNpc3RlZGAgZmllbGQsIGFuZCB0aGUgaW50ZXJpbSBydWxlIG9mIEFEUiAwMDMyIChob2xkIHRoZSBtZXNzYWdlIHVudGlsIHRoZSBjb21taXQsIHNlbmQgbm9uZSBmb3IgYSByZWplY3RlZCByb3cpIHN0YXlzLiBUaGUgaG9zdCBhbGFybSBkb2VzIG5vdCBkZXBlbmQgb24gaXQuIEl0IG5lZWRzIHlvdXIgZGVjaXNpb24gKGEpIGFkZCB0aGUgZmllbGQgYW5kIGEgcHJvdmlzaW9uYWwgaWQsIG9yIChiKSBrZWVwIHRoZSBpbnRlcmltIHJ1bGUsIGJlZm9yZSB0aGUgZGFzaGJvYXJkIChQMjIpLgo=');
  append('docs/adr/0032.md', '- **Update (ADR 0033).** P24-3b-2b is done: link, system and advisory messages are in `wire.py`; the `unpersisted` decision above is still OPEN and the interim rule stands.');
  replace('host/ppe_host/wire.py', '(ADR 0032: the wire has no unpersisted field yet, which needs a decision).', '(ADR 0032 and ADR 0033: the wire has no unpersisted field yet, which needs a decision).');
  put('host/tests/test_adr0033.py', String.raw`"""P24-3b-2b-iii: ADR 0033 exists, is Proposed, and keeps the unpersisted decision open (ADR 0032 and 0033 must not drift apart)."""
from pathlib import Path
ADR = Path(__file__).resolve().parents[2] / 'docs' / 'adr'
def test_adr_0033_is_proposed_and_keeps_unpersisted_open():
    t = (ADR / '0033.md').read_text(encoding='utf8')
    assert t.startswith('# ADR 0033') and 'Status: Proposed' in t and 'unpersisted' in t and 'OPEN' in t
def test_adr_0032_points_to_0033():
    assert 'ADR 0033' in (ADR / '0032.md').read_text(encoding='utf8')
`);
  append('docs/PROGRESS.md', '- Part 24-3b-2b-iii done: docs/adr/0033.md (link, system and advisory messages; advisory off until P24-3c calls Wire.enable_advisory; unpersisted still OPEN), pointer added to ADR 0032 and to the wire.py header, host/tests/test_adr0033.py (2 tests). P24-3b is finished; steps 8 to 10 are P24-3c');
}
