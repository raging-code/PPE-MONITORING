/* Requirements: REQ-FW-003, REQ-FW-004 */
/* P16b gcc test runner: components/nvs_latch with a mocked NVS, the man-down and SCBA machines, and the frame packer (boot frame).
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
