// patches/part16b_nvs_latch.mjs  (run from repo root: node patches/part16b_nvs_latch.mjs [--dry] [--force])
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
  put('firmware/components/nvs_latch/nvs_latch.h', String.raw`/* Persisted node state: man-down latch cause, SCBA mode, boot_ctr (Technical Summary section 7 "Persist man-down latch...", design 11.2).
   Pure C: no ESP-IDF, no I/O, no clock, no globals. Flash is reached only through nvsl_backend_t (ESP-IDF NVS at P17, a mock in test_nvs.c).
   THREE ROUTES:
   nvsl_boot()    once per boot, before the 10 Hz loop starts (blocking is allowed): reads the three records, commits boot_ctr+1, returns what the machines need.
   nvsl_observe() from fsm_task every 100 ms with latch_cause = md_mandown(&md) ? md.cause : 0 and scba_on = sb_on(&sb). RAM only: it never calls the backend,
                  so flash can not delay the alarm or the loop.
   nvsl_service() from a LOW-priority task on core 0 (about 1 Hz): writes what changed (set, commit, read back, compare). A failure logs nvs_fault and the next call
                  retries, so the caller's period is the log rate. Nothing is written while the values are unchanged (design 11.2 note 3: no periodic writes).
   Records are 3 bytes {NVSL_MAGIC, v, ~v}. A latch record that is present but unreadable or invalid fails safe as latched (MAN_DOWN); a missing key is unlatched.
   SCBA ON is restored after brown-out, watchdog and software reset, not after power-on; an unreadable SCBA record means OFF. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "frame.h"
#define NVSL_MAGIC 0xA7u
#define NVSL_BOOT_TRIES 3u        /* synchronous attempts to commit boot_ctr at boot (ADR 0004) */
#define NVSL_REBOOT_HINT_MS 30000u /* status2 bit 3, "first 30 s" (ADR 0004) */
#define NVSL_RESTORED_MS 60000u    /* status3 bit 4, "set for 60 s after an unclean reset" (ADR 0004) */
enum { NVSL_IO_OK = 0, NVSL_IO_NOT_FOUND = 1, NVSL_IO_ERR = 2 };
typedef enum { NVSL_FAULT_NONE = 0, NVSL_FAULT_LATCH_CORRUPT, NVSL_FAULT_LATCH_READ, NVSL_FAULT_SCBA_BAD, NVSL_FAULT_BOOT_CTR_BAD,
               NVSL_FAULT_WRITE, NVSL_FAULT_COMMIT, NVSL_FAULT_READBACK } nvsl_fault_t;
typedef struct {
  void *ctx;
  int (*get)(void *ctx, const char *key, uint8_t *buf, size_t cap, size_t *len);  /* NVSL_IO_* */
  int (*set)(void *ctx, const char *key, const uint8_t *buf, size_t len);         /* 0 = staged */
  int (*commit)(void *ctx);                                                       /* 0 = durable */
  uint32_t (*random)(void *ctx);
  void (*log)(void *ctx, const char *event, int fault);                           /* event is "nvs_fault"; a firmware log, not a host event */
} nvsl_backend_t;
typedef struct { uint8_t latch_cause, scba_on, boot_ctr, reset_cause, latch_restored; } nvsl_boot_t;  /* latch_cause: MD_EV_BOOT arg; scba_on: SB_EV_BOOT arg bit 0 */
typedef struct { nvsl_backend_t be; uint8_t latch_want, latch_stored, scba_want, scba_stored, boot_ctr, reset_cause, restored_latch; uint32_t boot_ms, faults; } nvsl_t;

void nvsl_init(nvsl_t *n, const nvsl_backend_t *be);
nvsl_boot_t nvsl_boot(nvsl_t *n, uint8_t reset_cause, uint32_t now_ms);  /* reset_cause is an ABI_RESET_CAUSE_* value */
void nvsl_observe(nvsl_t *n, uint8_t latch_cause, uint8_t scba_on);
uint32_t nvsl_service(nvsl_t *n);                                        /* returns the number of records made durable by this call */
uint32_t nvsl_faults(const nvsl_t *n);
uint8_t nvsl_boot_ctr(const nvsl_t *n);
uint8_t nvsl_status2_reboot(const nvsl_t *n, uint32_t now_ms);           /* status2 bit 3 mask, or 0 */
uint8_t nvsl_status3_restored(const nvsl_t *n, uint32_t now_ms);         /* status3 bit 4 and the cause in bits 5 to 6, or 0; not for a power-on reset */
uint8_t nvsl_status4_latch_restored(const nvsl_t *n);                    /* status4 bit 1 mask: from a restored latch until it is cleared */
void nvsl_apply_boot_fields(const nvsl_t *n, uint32_t now_ms, frame_fields_t *f);  /* the first frame after a boot: seq 0, boot_ctr, the status bits above ORed in */
`);
  put('firmware/components/nvs_latch/nvs_latch.c', String.raw`#include "nvs_latch.h"
#include <string.h>
#include "abi.h"
#define LATCH_NONE 0u
#define LATCH_MAN_DOWN 1u
#define LATCH_MAYDAY 2u
#define LATCH_UNKNOWN 0xFFu  /* stored record is missing or bad: the next observed value is written */
static uint32_t since(uint32_t now, uint32_t t) { return now - t; }  /* wrap-safe */
static int fault(nvsl_t *n, nvsl_fault_t f) { n->faults++; if (n->be.log) n->be.log(n->be.ctx, "nvs_fault", (int)f); return -1; }
static void rec_enc(uint8_t r[3], uint8_t v) { r[0] = NVSL_MAGIC; r[1] = v; r[2] = (uint8_t)~v; }
static int rec_dec(const uint8_t *r, size_t len, uint8_t *v) { if (len != 3 || r[0] != NVSL_MAGIC || r[2] != (uint8_t)~r[1]) return -1; *v = r[1]; return 0; }
/* io: NVSL_IO_OK with *v set, NVSL_IO_NOT_FOUND, NVSL_IO_ERR (unreadable) or 3 (present but invalid) */
static int read_rec(nvsl_t *n, const char *key, uint8_t *v) {
  uint8_t b[8]; size_t len = 0; int io = n->be.get(n->be.ctx, key, b, sizeof b, &len);
  if (io != NVSL_IO_OK) return io;
  return rec_dec(b, len, v) ? 3 : NVSL_IO_OK;
}
static int write_rec(nvsl_t *n, const char *key, uint8_t v) {  /* set, commit, read back, compare */
  uint8_t r[3], g[8]; size_t len = 0; rec_enc(r, v);
  if (n->be.set(n->be.ctx, key, r, sizeof r)) return fault(n, NVSL_FAULT_WRITE);
  if (n->be.commit(n->be.ctx)) return fault(n, NVSL_FAULT_COMMIT);
  if (n->be.get(n->be.ctx, key, g, sizeof g, &len) != NVSL_IO_OK || len != sizeof r || memcmp(g, r, sizeof r)) return fault(n, NVSL_FAULT_READBACK);
  return 0;
}
void nvsl_init(nvsl_t *n, const nvsl_backend_t *be) { memset(n, 0, sizeof *n); n->be = *be; n->latch_stored = LATCH_NONE; }
nvsl_boot_t nvsl_boot(nvsl_t *n, uint8_t reset_cause, uint32_t now_ms) {
  nvsl_boot_t b; uint8_t v = 0, prev = 0; int io;
  memset(&b, 0, sizeof b); n->reset_cause = reset_cause; n->boot_ms = now_ms; b.reset_cause = reset_cause;
  io = read_rec(n, "latch", &v);  /* a present-but-bad or unreadable latch fails safe as latched; a missing key is unlatched */
  if (io == NVSL_IO_OK && v <= LATCH_MAYDAY) { b.latch_cause = v; n->latch_stored = v; }
  else if (io == NVSL_IO_NOT_FOUND) { b.latch_cause = LATCH_NONE; n->latch_stored = LATCH_NONE; }
  else { fault(n, io == NVSL_IO_ERR ? NVSL_FAULT_LATCH_READ : NVSL_FAULT_LATCH_CORRUPT); b.latch_cause = LATCH_MAN_DOWN; n->latch_stored = LATCH_UNKNOWN; }
  n->latch_want = b.latch_cause; b.latch_restored = b.latch_cause != LATCH_NONE; n->restored_latch = b.latch_restored;
  io = read_rec(n, "scba", &v);
  if (io == NVSL_IO_OK && v <= 1u) { n->scba_stored = v; b.scba_on = (uint8_t)(v && reset_cause != ABI_RESET_CAUSE_POWER_ON); }
  else if (io == NVSL_IO_NOT_FOUND) n->scba_stored = 0;
  else { fault(n, NVSL_FAULT_SCBA_BAD); n->scba_stored = LATCH_UNKNOWN; }
  n->scba_want = b.scba_on;
  io = read_rec(n, "boot_ctr", &prev);  /* absent = new flash = 0; unreadable = a random value, logged, and the host re-baseline rule takes over */
  if (io == NVSL_IO_NOT_FOUND) n->boot_ctr = 1;
  else if (io == NVSL_IO_OK) n->boot_ctr = (uint8_t)(prev + 1u);
  else { fault(n, NVSL_FAULT_BOOT_CTR_BAD); n->boot_ctr = (uint8_t)n->be.random(n->be.ctx); }
  for (unsigned i = 0; i < NVSL_BOOT_TRIES; i++) if (!write_rec(n, "boot_ctr", n->boot_ctr)) break;  /* a failure still uses the value in RAM */
  b.boot_ctr = n->boot_ctr;
  return b;
}
void nvsl_observe(nvsl_t *n, uint8_t latch_cause, uint8_t scba_on) {
  n->latch_want = latch_cause; n->scba_want = scba_on ? 1u : 0u;
  if (latch_cause == LATCH_NONE) n->restored_latch = 0;  /* status4 bit 1 stays until the latch is cleared */
}
uint32_t nvsl_service(nvsl_t *n) {
  uint32_t w = 0; uint8_t v = n->latch_want;  /* copies: fsm_task may change the wanted values while a slow write is running; the next call writes them */
  if (v != n->latch_stored && !write_rec(n, "latch", v)) { n->latch_stored = v; w++; }
  v = n->scba_want;
  if (v != n->scba_stored && !write_rec(n, "scba", v)) { n->scba_stored = v; w++; }
  return w;
}
uint32_t nvsl_faults(const nvsl_t *n) { return n->faults; }
uint8_t nvsl_boot_ctr(const nvsl_t *n) { return n->boot_ctr; }
uint8_t nvsl_status2_reboot(const nvsl_t *n, uint32_t now) { return since(now, n->boot_ms) < NVSL_REBOOT_HINT_MS ? ABI_STATUS2_REBOOT_HINT_MASK : 0; }
uint8_t nvsl_status3_restored(const nvsl_t *n, uint32_t now) {
  if (n->reset_cause == ABI_RESET_CAUSE_POWER_ON || since(now, n->boot_ms) >= NVSL_RESTORED_MS) return 0;
  return (uint8_t)(ABI_STATUS3_RESTORED_MASK | ((n->reset_cause << ABI_STATUS3_RESET_CAUSE_SHIFT) & ABI_STATUS3_RESET_CAUSE_MASK));
}
uint8_t nvsl_status4_latch_restored(const nvsl_t *n) { return n->restored_latch ? ABI_STATUS4_LATCH_RESTORED_MASK : 0; }
void nvsl_apply_boot_fields(const nvsl_t *n, uint32_t now, frame_fields_t *f) {
  f->seq = 0; f->boot_ctr = n->boot_ctr; f->status2 |= nvsl_status2_reboot(n, now); f->status3 |= nvsl_status3_restored(n, now); f->status4 |= nvsl_status4_latch_restored(n);
}
`);
  put('firmware/tests/test_nvs.c', String.raw`/* P16b gcc test runner: components/nvs_latch with a mocked NVS, the man-down and SCBA machines, and the frame packer (boot frame).
   The mock keeps a durable copy and a staged copy per key; a power cut drops the staged copy. Injection: failed set, failed commit, read-back mismatch,
   unreadable key, power cut during commit, slow commit. Timing proof of "never stalls the 10 Hz loop" is the D2 bench test; here the proof is that
   nvsl_observe() and md_step() make no backend call at all. */
#include <stdio.h>
#include <string.h>
#include "abi.h"
#include "constants.h"
#include "man_down.h"
#include "scba.h"
#include "nvs_latch.h"
static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL: "); printf(__VA_ARGS__); printf("\n"); } } while (0)
#define HAS(a, bit) (((a) & (bit)) != 0)
typedef struct { char key[12]; uint8_t d[8], sd[8]; size_t len, slen; int used, staged; } ent_t;
typedef struct { ent_t e[4]; int fail_get_n, fail_set, fail_commit, bad_readback, cut_on_commit, slow; const char *fail_get; unsigned gets, sets, commits, logs; uint32_t latency_ms, rnd; int last_fault; } mock_t;
static ent_t *find(mock_t *m, const char *k, int make) {
  for (int i = 0; i < 4; i++) if (m->e[i].used && !strcmp(m->e[i].key, k)) return &m->e[i];
  if (make) for (int i = 0; i < 4; i++) if (!m->e[i].used) { strcpy(m->e[i].key, k); m->e[i].used = 1; m->e[i].len = 0; return &m->e[i]; }
  return 0;
}
static int m_get(void *c, const char *k, uint8_t *b, size_t cap, size_t *len) {
  mock_t *m = c; m->gets++; if (m->fail_get && m->fail_get_n > 0 && !strcmp(m->fail_get, k)) { m->fail_get_n--; return NVSL_IO_ERR; }  /* the next read of this key fails */
  ent_t *e = find(m, k, 0); if (!e || !e->len) return NVSL_IO_NOT_FOUND;
  *len = e->len < cap ? e->len : cap; memcpy(b, e->d, *len); return NVSL_IO_OK;
}
static int m_set(void *c, const char *k, const uint8_t *b, size_t len) {
  mock_t *m = c; m->sets++; if (m->fail_set > 0) { m->fail_set--; return 1; }
  ent_t *e = find(m, k, 1); memcpy(e->sd, b, len); e->slen = len; e->staged = 1; return 0;
}
static int m_commit(void *c) {
  mock_t *m = c; if (m->slow) m->latency_ms += 50;
  if (m->cut_on_commit) { m->cut_on_commit = 0; for (int i = 0; i < 4; i++) m->e[i].staged = 0; return 1; }  /* power lost before the commit */
  if (m->fail_commit > 0) { m->fail_commit--; return 1; }
  m->commits++;
  for (int i = 0; i < 4; i++) if (m->e[i].staged) { memcpy(m->e[i].d, m->e[i].sd, 8); m->e[i].len = m->e[i].slen; m->e[i].staged = 0; if (m->bad_readback) { m->bad_readback = 0; m->e[i].d[1] ^= 0xFFu; } }
  return 0;
}
static uint32_t m_rand(void *c) { return ((mock_t *)c)->rnd; }
static void m_log(void *c, const char *ev, int f) { mock_t *m = c; if (!strcmp(ev, "nvs_fault")) { m->logs++; m->last_fault = f; } }
static void poke(mock_t *m, const char *k, const uint8_t *b, size_t len) { ent_t *e = find(m, k, 1); memcpy(e->d, b, len); e->len = len; }
static void poke_rec(mock_t *m, const char *k, uint8_t v) { uint8_t r[3] = { NVSL_MAGIC, v, (uint8_t)~v }; poke(m, k, r, 3); }
static int rec_is(mock_t *m, const char *k, uint8_t v) { ent_t *e = find(m, k, 0); return e && e->len == 3 && e->d[0] == NVSL_MAGIC && e->d[1] == v && e->d[2] == (uint8_t)~v; }

typedef struct { md_state_t md; sb_state_t sb; nvsl_t nv; mock_t *m; nvsl_boot_t bi; uint32_t boot_acts, t0; } node_t;
static md_event_t M(md_ev_kind_t k, uint32_t a) { md_event_t e; e.kind = k; e.arg = a; return e; }
static sb_event_t B(sb_ev_kind_t k, uint32_t a) { sb_event_t e; e.kind = k; e.arg = a; return e; }
static uint8_t cause(const node_t *n) { return md_mandown(&n->md) ? (uint8_t)n->md.cause : 0; }
static void boot(node_t *n, mock_t *m, uint8_t reset_cause, uint32_t t, int contacts) {  /* RAM is lost on every reset; the mock keeps flash */
  nvsl_backend_t be; be.ctx = m; be.get = m_get; be.set = m_set; be.commit = m_commit; be.random = m_rand; be.log = m_log;
  memset(n, 0, sizeof *n); n->m = m; n->t0 = t; nvsl_init(&n->nv, &be); n->bi = nvsl_boot(&n->nv, reset_cause, t);
  n->boot_acts = md_step(&n->md, M(MD_EV_BOOT, n->bi.latch_cause), t);
  sb_step(&n->sb, B(SB_EV_BOOT, (uint32_t)(n->bi.scba_on | (contacts ? 2u : 0u))), t); nvsl_observe(&n->nv, cause(n), sb_on(&n->sb));
}
static uint32_t md(node_t *n, md_ev_kind_t k, uint32_t arg, uint32_t t) { uint32_t a = md_step(&n->md, M(k, arg), t); nvsl_observe(&n->nv, cause(n), sb_on(&n->sb)); return a; }
static void latch_at(node_t *n, uint32_t t) { md(n, MD_EV_STILL, 0, t); md(n, MD_EV_TICK, 0, t + 30000u); }
static void clear_latch(node_t *n, uint32_t t) { md(n, MD_EV_JACKET_HOLD, 3000, t); md(n, MD_EV_CANCEL_JACKET, 0, t + 1000u); md(n, MD_EV_MOTION, 0, t + 1100u); }
static const uint8_t KEY[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
static frame_fields_t boot_frame(node_t *n, uint32_t t) {  /* what the radio task would send first: pack, then classify and decode like the host */
  frame_fields_t f, d; uint8_t raw[ABI_FRAME_BYTES]; memset(&f, 0, sizeof f);
  f.id_mode = 0x41; f.flags = (uint8_t)(md_level(&n->md) | (md_mandown(&n->md) ? ABI_FLAGS_MANDOWN_MASK : 0)); f.status4 = md_status4_mayday(&n->md) ? ABI_STATUS4_MAYDAY_MASK : 0; f.seq = 99;
  nvsl_apply_boot_fields(&n->nv, t, &f); frame_pack(raw, &f, KEY, 90);
  CHECK(frame_classify(raw, sizeof raw, KEY, 90, &d, 0) == FRAME_OK, "boot frame packs and verifies"); return d;
}

static void test_erased_and_idle(void) {
  mock_t m; node_t n; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1);
  CHECK(n.bi.latch_cause == 0 && !n.bi.scba_on && n.bi.boot_ctr == 1 && !md_mandown(&n.md) && !HAS(n.boot_acts, MD_ACT_LATCH_RESTORED), "erased flash: unlatched, SCBA OFF, boot_ctr 1");
  CHECK(nvsl_faults(&n.nv) == 0 && m.logs == 0, "erased flash is not a fault");
  CHECK(m.commits == 1 && rec_is(&m, "boot_ctr", 1), "boot_ctr committed before the first frame (1 write)");
  for (int i = 0; i < 1000; i++) { md(&n, MD_EV_TICK, 0, 100u * (uint32_t)(i + 1)); nvsl_service(&n.nv); }
  CHECK(m.commits == 1 && m.sets == 1, "1000 steps, unchanged: 0 NVS writes");
}
static void test_set_clear_counts(void) {
  mock_t m; node_t n; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); unsigned base = m.commits;
  latch_at(&n, 1000); CHECK(md_mandown(&n.md), "latched after 30 s of stillness");
  CHECK(nvsl_service(&n.nv) == 1 && m.commits == base + 1 && rec_is(&m, "latch", MD_CAUSE_MAN_DOWN), "latch set records exactly 1 write");
  for (int i = 0; i < 1000; i++) { md(&n, MD_EV_TICK, 0, 31000u + 100u * (uint32_t)i); nvsl_service(&n.nv); }
  CHECK(m.commits == base + 1, "1000 steps with the latch unchanged: 0 more writes");
  clear_latch(&n, 140000); CHECK(!md_mandown(&n.md), "two-action clear");
  CHECK(nvsl_service(&n.nv) == 1 && m.commits == base + 2 && rec_is(&m, "latch", 0), "latch clear records exactly 1 write");
  for (int i = 0; i < 1000; i++) { md(&n, MD_EV_TICK, 0, 150000u + 100u * (uint32_t)i); nvsl_service(&n.nv); }
  CHECK(m.commits == base + 2, "1000 steps after the clear: 0 more writes");
}
static void test_mayday_upgrade_restore(void) {
  mock_t m; node_t n; frame_fields_t d; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); latch_at(&n, 0); nvsl_service(&n.nv);
  unsigned base = m.commits; md(&n, MD_EV_CANCEL_JACKET, 0, 40000); md(&n, MD_EV_CANCEL_JACKET, 0, 40500); md(&n, MD_EV_CANCEL_JACKET, 0, 41000);
  CHECK(md_status4_mayday(&n.md) && nvsl_service(&n.nv) == 1 && m.commits == base + 1 && rec_is(&m, "latch", MD_CAUSE_MAYDAY), "MAYDAY upgrade of a latched man-down: 1 write, cause 2");
  boot(&n, &m, ABI_RESET_CAUSE_WATCHDOG, 60000, 1);
  CHECK(n.bi.latch_cause == MD_CAUSE_MAYDAY && md_status4_mayday(&n.md) && md_level(&n.md) == 2 && HAS(n.boot_acts, MD_ACT_FULL_ALARM | MD_ACT_LATCH_RESTORED), "a latch stored as MAYDAY comes back as MAYDAY, full alarm");
  d = boot_frame(&n, 60000); CHECK((d.status4 & 0x12) == 0x12 && (d.flags & 0x06) == 0x06, "boot frame: status4 bits 1 and 4, mandown, DANGER");
}
static void test_resets(void) {
  uint8_t causes[3] = { ABI_RESET_CAUSE_BROWN_OUT, ABI_RESET_CAUSE_WATCHDOG, ABI_RESET_CAUSE_SOFTWARE };
  for (int i = 0; i < 3; i++) {
    mock_t m; node_t n; frame_fields_t d; memset(&m, 0, sizeof m); poke_rec(&m, "boot_ctr", 7); poke_rec(&m, "latch", MD_CAUSE_MAN_DOWN);
    boot(&n, &m, causes[i], 5000, 1); d = boot_frame(&n, 5000);
    CHECK(d.boot_ctr == 8 && rec_is(&m, "boot_ctr", 8) && d.seq == 0, "reset %d: boot_ctr+1 committed, seq 0", causes[i]);
    CHECK((d.status2 & ABI_STATUS2_REBOOT_HINT_MASK) && (d.status3 & ABI_STATUS3_RESTORED_MASK) && ((d.status3 & ABI_STATUS3_RESET_CAUSE_MASK) >> 5) == causes[i], "reset %d: status2 bit 3, status3 bit 4, cause in bits 5 to 6", causes[i]);
    CHECK((d.status4 & ABI_STATUS4_LATCH_RESTORED_MASK) && (d.flags & ABI_FLAGS_MANDOWN_MASK) && HAS(n.boot_acts, MD_ACT_LATCH_RESTORED), "reset %d: latch restored, status4 bit 1, mandown 1", causes[i]);
    CHECK(nvsl_status3_restored(&n.nv, 5000 + 59999) && !nvsl_status3_restored(&n.nv, 5000 + 60000), "reset %d: status3 bit 4 lasts 60 s", causes[i]);
    CHECK(nvsl_status2_reboot(&n.nv, 5000 + 29999) && !nvsl_status2_reboot(&n.nv, 5000 + 30000), "reset %d: reboot hint lasts 30 s", causes[i]);
  }
  { mock_t m; node_t n; frame_fields_t d; memset(&m, 0, sizeof m); poke_rec(&m, "boot_ctr", 7); poke_rec(&m, "latch", MD_CAUSE_MAN_DOWN); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); d = boot_frame(&n, 0);
    CHECK(d.boot_ctr == 8 && !(d.status3 & ABI_STATUS3_RESTORED_MASK) && (d.status4 & 2) && md_mandown(&n.md), "power-on: boot_ctr+1, no unclean-reset bit, the latch is still restored"); }
  { mock_t m; node_t n; memset(&m, 0, sizeof m); poke_rec(&m, "latch", MD_CAUSE_MAN_DOWN); boot(&n, &m, ABI_RESET_CAUSE_WATCHDOG, 0, 1);
    CHECK(nvsl_status4_latch_restored(&n.nv) && (md(&n, MD_EV_TICK, 0, 100000), nvsl_status4_latch_restored(&n.nv)), "status4 bit 1 stays set while the latch is");
    clear_latch(&n, 101000); CHECK(!nvsl_status4_latch_restored(&n.nv) && nvsl_service(&n.nv) == 1 && rec_is(&m, "latch", 0), "status4 bit 1 drops at the clear, the clear is stored"); }
}
static void test_clock_wrap(void) {
  mock_t m; node_t n; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_WATCHDOG, 0xFFFFFF00u, 1);
  CHECK(nvsl_status3_restored(&n.nv, 0xFFFFFF00u + 59999u) && !nvsl_status3_restored(&n.nv, 0xFFFFFF00u + 60000u), "status3 bit 4 window across the now_ms wrap");
  CHECK(nvsl_status2_reboot(&n.nv, 0xFFFFFF00u + 29999u) && !nvsl_status2_reboot(&n.nv, 0xFFFFFF00u + 30000u), "reboot hint window across the now_ms wrap");
}
static void test_corrupt_and_unreadable(void) {
  static const uint8_t bad[4][3] = { { 0x00, 1, 0xFE }, { NVSL_MAGIC, 1, 0x01 }, { NVSL_MAGIC, 9, 0xF6 }, { NVSL_MAGIC, 1, 0xFE } };
  for (int i = 0; i < 4; i++) {
    mock_t m; node_t n; memset(&m, 0, sizeof m); poke(&m, "latch", bad[i], i == 3 ? 2 : 3); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1);
    CHECK(md_mandown(&n.md) && md_level(&n.md) == 2 && n.bi.latch_cause == MD_CAUSE_MAN_DOWN && m.logs == 1 && m.last_fault == NVSL_FAULT_LATCH_CORRUPT, "corrupt latch %d: comes back latched, nvs_fault logged", i);
    CHECK(nvsl_service(&n.nv) == 1 && rec_is(&m, "latch", MD_CAUSE_MAN_DOWN) && md_mandown(&n.md), "corrupt latch %d: record repaired, still latched", i);
  }
  { mock_t m; node_t n; memset(&m, 0, sizeof m); poke_rec(&m, "boot_ctr", 3); m.fail_get = "latch"; m.fail_get_n = 1; boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1);
    CHECK(md_mandown(&n.md) && m.last_fault == NVSL_FAULT_LATCH_READ && m.logs == 1, "unreadable latch storage: latched, nvs_fault"); }
  { mock_t m; node_t n; memset(&m, 0, sizeof m); poke_rec(&m, "scba", 1); poke_rec(&m, "boot_ctr", 3); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1);
    CHECK(!md_mandown(&n.md) && m.logs == 0, "other keys present, latch key missing: unlatched, no fault"); }
}
static void test_power_cut(void) {
  mock_t m; node_t n; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); latch_at(&n, 1000);
  m.cut_on_commit = 1; CHECK(md_mandown(&n.md) && nvsl_service(&n.nv) == 0 && !rec_is(&m, "latch", 1), "power cut before the commit: nothing durable");
  boot(&n, &m, ABI_RESET_CAUSE_BROWN_OUT, 40000, 1);
  CHECK(!md_mandown(&n.md) && n.bi.latch_cause == 0 && !nvsl_status4_latch_restored(&n.nv), "after the cut the node comes back unlatched");
  md(&n, MD_EV_STILL, 0, 41000); md(&n, MD_EV_TICK, 0, 70999); CHECK(!md_mandown(&n.md), "29.999 s of stillness: not yet");
  md(&n, MD_EV_TICK, 0, 71000); CHECK(md_mandown(&n.md) && nvsl_service(&n.nv) == 1 && rec_is(&m, "latch", 1), "latch is set again after the stillness timer and stored");
}
static void test_write_failures(void) {
  mock_t m; node_t n; uint32_t a; unsigned calls; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1);
  m.fail_set = 1000000; m.slow = 1; md(&n, MD_EV_STILL, 0, 1000); calls = m.gets + m.sets + m.commits;
  a = md(&n, MD_EV_TICK, 0, 31000);
  CHECK(HAS(a, MD_ACT_FULL_ALARM) && md_level(&n.md) == 2 && md_mandown(&n.md), "failing storage: the alarm starts in the same 10 Hz step");
  CHECK(m.gets + m.sets + m.commits == calls, "the loop path (md_step, observe) makes no flash call");
  for (int i = 0; i < 5; i++) { md(&n, MD_EV_TICK, 0, 31100u + 100u * (uint32_t)i); CHECK(nvsl_service(&n.nv) == 0 && md_level(&n.md) == 2, "failed write %d: still alarming, nothing durable", i); }
  CHECK(m.logs == 5 && m.last_fault == NVSL_FAULT_WRITE && nvsl_faults(&n.nv) == 5, "each failed attempt logs nvs_fault");
  m.fail_set = 0; CHECK(nvsl_service(&n.nv) == 1 && rec_is(&m, "latch", 1) && m.latency_ms == 50, "storage recovers: the retry makes it durable (1 write, slow commit)");
  CHECK(nvsl_service(&n.nv) == 0, "nothing more to write");
  clear_latch(&n, 200000); m.fail_commit = 1; CHECK(nvsl_service(&n.nv) == 0 && m.last_fault == NVSL_FAULT_COMMIT && nvsl_service(&n.nv) == 1 && rec_is(&m, "latch", 0), "failed commit: logged, retried, clear stored");
  latch_at(&n, 300000); m.bad_readback = 1; CHECK(nvsl_service(&n.nv) == 0 && m.last_fault == NVSL_FAULT_READBACK && nvsl_service(&n.nv) == 1 && rec_is(&m, "latch", 1), "read-back mismatch: logged, rewritten");
}
static void test_boot_ctr(void) {
  mock_t m; node_t n; memset(&m, 0, sizeof m);
  for (int i = 1; i <= 20; i++) { boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); CHECK(n.bi.boot_ctr == i && rec_is(&m, "boot_ctr", (uint8_t)i), "power cycle %d: boot_ctr %d", i, i); }
  m.fail_get = "boot_ctr"; m.fail_get_n = 1; m.rnd = 0x5C; boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1);
  CHECK(n.bi.boot_ctr == 0x5C && m.last_fault == NVSL_FAULT_BOOT_CTR_BAD && rec_is(&m, "boot_ctr", 0x5C), "failed NVS read: a random boot_ctr is used, logged and stored");
  m.fail_get = 0; boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); CHECK(n.bi.boot_ctr == 0x5D, "the next boot continues from the stored value");
  poke_rec(&m, "boot_ctr", 255); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); CHECK(n.bi.boot_ctr == 0, "u8 counter wraps");
  m.fail_set = 3; boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); CHECK(n.bi.boot_ctr == 1 && m.logs >= 3 && !rec_is(&m, "boot_ctr", 1) && rec_is(&m, "boot_ctr", 0), "commit fails 3 times at boot: RAM value used, nvs_fault logged");
}
static void test_scba_mode(void) {
  mock_t m; node_t n; memset(&m, 0, sizeof m); boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 0, 1); unsigned base = m.commits;
  sb_step(&n.sb, B(SB_EV_ON, 0), 1000); nvsl_observe(&n.nv, 0, sb_on(&n.sb)); CHECK(nvsl_service(&n.nv) == 1 && rec_is(&m, "scba", 1) && m.commits == base + 1, "SCBA ON is stored (1 write)");
  boot(&n, &m, ABI_RESET_CAUSE_BROWN_OUT, 5000, 1); CHECK(n.bi.scba_on && sb_on(&n.sb), "brown-out: SCBA ON restored");
  boot(&n, &m, ABI_RESET_CAUSE_WATCHDOG, 5000, 0); CHECK(n.bi.scba_on && !sb_on(&n.sb), "watchdog with the contacts open: restored value is not applied");
  boot(&n, &m, ABI_RESET_CAUSE_POWER_ON, 5000, 1); CHECK(!n.bi.scba_on && !sb_on(&n.sb) && nvsl_service(&n.nv) == 1 && rec_is(&m, "scba", 0), "cold power-on: SCBA OFF, and OFF is stored");
}
int main(void) {
  test_erased_and_idle(); test_set_clear_counts(); test_mayday_upgrade_restore(); test_resets(); test_clock_wrap(); test_corrupt_and_unreadable(); test_power_cut(); test_write_failures(); test_boot_ctr(); test_scba_mode();
  printf("test_nvs: nvs_latch and reset behaviour, %d checks, %s\n", checks, fails ? "FAILED" : "all pass");
  return fails ? 1 : 0;
}
`);
  putB64('docs/adr/0004.md', 'IyBBRFIgMDAwNDogbnZzX2xhdGNoIChQMTZiKSwgdmFsdWVzIGFuZCByZWFkaW5ncyB0aGUgY29uc3RhbnRzIGZpbGUgZG9lcyBub3QgaG9sZAoKU3RhdHVzOiBQcm9wb3NlZCAoZGVjaWRlZCBpbiB0aGUgUDE2YiBzZXNzaW9uOyBjb25maXJtIGF0IHRoZSBuZXh0IGRlc2lnbiByZXZpZXcpLgpEZXNpZ246IFJldiAzLjQ1IGlzIGZyb3plbiBhbmQgYHNoYXJlZC9jb25zdGFudHMuanNvbmAgaGFzIG5vIGtleSBmb3IgdGhlc2UgdmFsdWVzOyB0aGUgVGVjaG5pY2FsIFN1bW1hcnkgKHNlY3Rpb24gNyBhbmQgdGhlIGZyYW1lIHRhYmxlKSBnaXZlcyB0aGVtIGluIHByb3NlLgoKVmFsdWVzLCBhcyBgI2RlZmluZWBzIGluIGBmaXJtd2FyZS9jb21wb25lbnRzL252c19sYXRjaC9udnNfbGF0Y2guaGAgKHNhbWUgYXBwcm9hY2ggYXMgQURSIDAwMDIgYW5kIDAwMDMpOiBgTlZTTF9SRUJPT1RfSElOVF9NU2AgMzAwMDAgKHN0YXR1czIgYml0IDMsICJmaXJzdCAzMCBzIiksIGBOVlNMX1JFU1RPUkVEX01TYCA2MDAwMCAoc3RhdHVzMyBiaXQgNCwgInNldCBmb3IgNjAgcyBhZnRlciBhbiB1bmNsZWFuIHJlc2V0IiksIGBOVlNMX0JPT1RfVFJJRVNgIDMgKHN5bmNocm9ub3VzIGF0dGVtcHRzIHRvIGNvbW1pdCBib290X2N0ciBhdCBib290OyB0aGUgVGVjaG5pY2FsIFN1bW1hcnkgZ2l2ZXMgbm8gbnVtYmVyKS4gSWYgdGhlIG93bmVyIHByZWZlcnMgcmVhbCBrZXlzLCBhZGQgdGhlbSB0byBgY29uc3RhbnRzLmpzb25gLCByZWdlbmVyYXRlLCBhbmQgZGVsZXRlIHRoZSBkZWZpbmVzLgoKUmVhZGluZ3MgdGhlIHRlc3RzIHBpbjoKLSBUaGUgcmVib290IGhpbnQgaXMgc2V0IG9uIGV2ZXJ5IGJvb3QsIHBvd2VyLW9uIGluY2x1ZGVkIChib290X2N0ciByaXNlcyBvbiBldmVyeSBib290KS4gc3RhdHVzMyBiaXQgNCBhbmQgdGhlIGNhdXNlIGluIGJpdHMgNSB0byA2IGFyZSBzZXQgb25seSBmb3IgYW4gdW5jbGVhbiByZXNldCAoYnJvd24tb3V0LCB3YXRjaGRvZywgc29mdHdhcmUpLCBuZXZlciBhZnRlciBwb3dlci1vbi4gVGhlIGxhdGNoIGlzIHJlc3RvcmVkIG9uIGV2ZXJ5IGJvb3QgaW5jbHVkaW5nIHBvd2VyLW9uIChzdGF0dXM0IGJpdCAxLCB1bnRpbCB0aGUgbGF0Y2ggaXMgY2xlYXJlZCkuCi0gU0NCQSBPTiBpcyByZXN0b3JlZCBhZnRlciBicm93bi1vdXQsIHdhdGNoZG9nIGFuZCBzb2Z0d2FyZSByZXNldCBvbmx5OyBjb2xkIHBvd2VyLW9uIGlzIE9GRiAoVGVjaG5pY2FsIFN1bW1hcnkpLiBBbiB1bnJlYWRhYmxlIG9yIGludmFsaWQgU0NCQSByZWNvcmQgbWVhbnMgT0ZGLCB0aGUgc2FmZSBzaWRlIGZvciBDTyBzdXBwcmVzc2lvbi4gVGhlIGNvbnRhY3RzIG11c3QgYWxzbyBiZSBjbG9zZWQgKHNjYmEuYykuCi0gQSBsYXRjaCByZWNvcmQgdGhhdCBpcyBwcmVzZW50IGJ1dCBpbnZhbGlkLCBvciB3aG9zZSByZWFkIGZhaWxzLCBpcyBNQU5fRE9XTiBhbmQgbG9ncyBgbnZzX2ZhdWx0YDsgdGhlIHNlcnZpY2UgdGFzayB0aGVuIHJld3JpdGVzIGEgdmFsaWQgcmVjb3JkLiBBIG1pc3Npbmcga2V5IGlzIHVubGF0Y2hlZCBhbmQgaXMgbm90IGEgZmF1bHQuCi0gYG52c2xfb2JzZXJ2ZSgpYCBpcyBSQU0gb25seTsgYG52c2xfc2VydmljZSgpYCB3cml0ZXMgYWZ0ZXIgdGhlIGFsYXJtIGhhcyBzdGFydGVkIChzZXQsIGNvbW1pdCwgcmVhZCBiYWNrLCBjb21wYXJlKSBhbmQgcmV0cmllcyBvbiB0aGUgbmV4dCBjYWxsLCBsb2dnaW5nIGBudnNfZmF1bHRgIGZvciBlYWNoIGZhaWxlZCBhdHRlbXB0LiBBIGJvb3RfY3RyIHRoYXQgY2Fubm90IGJlIHJlYWQgaXMgYSByYW5kb20gYnl0ZSwgc3RvcmVkIGFuZCBsb2dnZWQ7IG9uZSB0aGF0IGNhbm5vdCBiZSBjb21taXR0ZWQgYWZ0ZXIgMyB0cmllcyBpcyB1c2VkIGZyb20gUkFNIGFuZCB0aGUgbmV4dCBib290IG1heSByZXBlYXQgaXQuCi0gUG9zdHVyZSBjYWxpYnJhdGlvbiBpcyBub3Qgc3RvcmVkIGhlcmU6IHRoZSBUZWNobmljYWwgU3VtbWFyeSBsaXN0cyBpdCB3aXRoIHRoZSBsYXRjaCwgYnV0IHRoZSBQMTYgcm93IGFuZCB0aGUgSEFORE9GRiBuYW1lIG9ubHkgdGhlIGxhdGNoIGNhdXNlLCBTQ0JBIG1vZGUgYW5kIGJvb3RfY3RyLgoKTm90IHByb3ZlbiBoZXJlOiB0aGUgcmVhbCB0aW1pbmcgb2YgYW4gTlZTIGVyYXNlIGFnYWluc3QgdGhlIDEwIEh6IGxvb3AgYW5kIGEgcmVhbCBicm93bi1vdXQuIFRob3NlIGFyZSB0aGUgRDIgYmVuY2ggdGVzdHMgKFAxNykuCg==');
  replace('tools/run_gcc_tests.py', String.raw`'test_scba': ('rules_fw', ['man_down', 'scba', 'degraded'])}  # P16b adds nvs_latch`, String.raw`'test_scba': ('rules_fw', ['man_down', 'scba', 'degraded']),
         'test_nvs': ('nvs_latch', ['nvs_latch', '../frame/aes128', '../frame/cmac', '../frame/crc8', '../frame/frame', '../rules_fw/man_down', '../rules_fw/scba'])}`);
  replace('tools/run_gcc_tests.py', String.raw`'-I', f'firmware/components/{comp}', '-I', 'firmware/tests',`, String.raw`'-I', f'firmware/components/{comp}', '-I', 'firmware/components/frame', '-I', 'firmware/components/rules_fw', '-I', 'firmware/tests',`);
  append('docs/PROGRESS.md', '- Part 16b done: firmware/components/nvs_latch (latch cause, SCBA mode and boot_ctr behind a backend interface; nvsl_boot restores the latch and commits boot_ctr+1, nvsl_observe is RAM only, nvsl_service writes only on change with read-back and retry and logs nvs_fault; corrupt or unreadable latch comes back latched, missing key unlatched; status2 bit 3 for 30 s, status3 bit 4 and cause for 60 s after an unclean reset, status4 bit 1 until the latch clears), firmware/tests/test_nvs.c (mocked NVS with failure, power-cut and slow-write injection), docs/adr/0004.md; P16 is complete; next is P17 (bench)');
}
