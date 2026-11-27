/* Requirements: REQ-FW-002 */
/* P16a gcc test runner: SCBA machine (scba.c) and IMU-degraded mode (degraded.c) with the man-down machine as the slot owner.
   FW-07 to FW-10 are replayed from fw_vectors.h through a small rig that follows the call order of scba.h; the expected values are written here by scenario id.
   The other tests cover the SCBA table of Technical Summary section 7 that no scenario reaches. */
#include <stdio.h>
#include <string.h>
#include "abi.h"
#include "man_down.h"
#include "scba.h"
#include "degraded.h"
#include "constants.h"
#include "fw_vectors.h"
static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL: "); printf(__VA_ARGS__); printf("\n"); } } while (0)
#define HAS(a, bit) (((a) & (bit)) != 0)
typedef struct { md_state_t md; dg_state_t dg; sb_state_t sb; uint32_t last_slot, acts, all, md_acts; } rig_t;
static md_event_t M(md_ev_kind_t k, uint32_t arg) { md_event_t e; e.kind = k; e.arg = arg; return e; }
static sb_event_t B(sb_ev_kind_t k, uint32_t arg) { sb_event_t e; e.kind = k; e.arg = arg; return e; }
static dg_event_t D(dg_ev_kind_t k, uint32_t arg) { dg_event_t e; e.kind = k; e.arg = arg; return e; }
static void rig_init(rig_t *r) { memset(r, 0, sizeof *r); md_init(&r->md); dg_init(&r->dg); sb_init(&r->sb); }
static void add(rig_t *r, uint32_t a) { r->acts |= a; r->all |= a; }
static void sync(rig_t *r, uint32_t t) {  /* tell the SCBA machine who owns the slot, only when it changed */
  uint32_t slot = (md_checkin(&r->md) || dg_prompt(&r->dg) ? 1u : 0u) | (md_mandown(&r->md) ? 2u : 0u);
  dg_step(&r->dg, D(DG_EV_LATCHED, md_mandown(&r->md)), t);
  if (slot != r->last_slot) { r->last_slot = slot; add(r, sb_step(&r->sb, B(SB_EV_SLOT, slot), t)); }
}
static void tick(rig_t *r, uint32_t t) {
  r->md_acts |= md_step(&r->md, M(MD_EV_TICK, 0), t);
  if (HAS(dg_step(&r->dg, D(DG_EV_TICK, 0), t), DG_ACT_LATCH)) r->md_acts |= md_step(&r->md, M(MD_EV_DEGRADED_LATCH, 0), t);
  sync(r, t); add(r, sb_step(&r->sb, B(SB_EV_TICK, 0), t));
}
static void cancel(rig_t *r, uint32_t t) {  /* SCBA first, then the man-down and degraded machines */
  add(r, sb_step(&r->sb, B(SB_EV_CANCEL, 0), t));
  r->md_acts |= md_step(&r->md, M(MD_EV_CANCEL_JACKET, 0), t); dg_step(&r->dg, D(DG_EV_CANCEL, 0), t); sync(r, t);
}
static void feed(rig_t *r, fwe_t e, uint32_t t) {
  r->acts = 0; r->md_acts = 0;
  switch (e) {
    case FWE_SCBA_ON: add(r, sb_step(&r->sb, B(SB_EV_ON, 0), t)); break;
    case FWE_TICK: case FWE_SCBA_PROMPT_DUE: case FWE_SCBA_EXPIRY: tick(r, t); break;  /* the two markers are time stamps; the machines are driven by TICK */
    case FWE_CANCEL_JACKET: cancel(r, t); break;
    case FWE_STILL: r->md_acts |= md_step(&r->md, M(MD_EV_STILL, 0), t); sync(r, t); break;
    case FWE_MOTION: r->md_acts |= md_step(&r->md, M(MD_EV_MOTION, 0), t); sync(r, t); break;
    case FWE_IMPACT: r->md_acts |= md_step(&r->md, M(MD_EV_IMPACT, 0), t); sync(r, t); break;
    case FWE_IMU_FAULT: dg_step(&r->dg, D(DG_EV_IMU_FAULT, 0), t); break;
    default: break;
  }
}
static void play(rig_t *r, const char *id, size_t n) {  /* first n events of a scenario */
  rig_init(r);
  for (size_t i = 0; i < N_FW_SCN; i++) if (!strcmp(FW_SCN[i].id, id)) { for (size_t j = 0; j < n; j++) feed(r, FW_SCN[i].ev[j].ev, FW_SCN[i].ev[j].t); return; }
  CHECK(0, "scenario %s missing", id);
}
static void test_scenarios(void) {
  rig_t r;
  for (size_t i = 0; i < N_FW_SCN; i++) if (!strcmp(FW_SCN[i].machine, "scba")) CHECK(FW_SCN[i].n >= 5, "%s has events", FW_SCN[i].id);
  /* FW-07: SCBA prompt open, a fall check-in takes the slot, the SCBA clock keeps running, expiry while latched */
  play(&r, "FW-07", 2); CHECK(sb_on(&r.sb) && !r.sb.prompt_open, "FW-07 at 280000: ON, no prompt yet");
  play(&r, "FW-07", 3); CHECK(r.sb.prompt_open && sb_prompt_ui(&r.sb) && HAS(r.acts, SB_ACT_PROMPT_SHOW), "FW-07 at 300000: SCBA prompt open and shown");
  play(&r, "FW-07", 5); CHECK(md_checkin(&r.md) && !sb_prompt_ui(&r.sb) && r.sb.prompt_open && HAS(r.acts, SB_ACT_PROMPT_SUSPEND), "FW-07 at 300200: check-in active, SCBA UI suspended, expiry clock running");
  play(&r, "FW-07", 6); CHECK(md_checkin(&r.md) && !sb_prompt_ui(&r.sb) && !sb_expired(&r.sb), "FW-07 at 310100: check-in pending, SCBA UI still suspended");
  play(&r, "FW-07", 7); CHECK(md_mandown(&r.md) && !sb_expired(&r.sb), "FW-07 at 315200: latched, SCBA not yet expired");
  play(&r, "FW-07", 8); CHECK(sb_expired(&r.sb) && !sb_on(&r.sb) && HAS(r.acts, SB_ACT_EXPIRED | SB_ACT_CRITICAL_FRAME), "FW-07 at 320000: scba_expired, critical frame");
  CHECK(sb_deferral_ms(&r.sb) > 0 && sb_deferral_ms(&r.sb) <= 15000u && !sb_prompt_ui(&r.sb), "FW-07: deferred by the check-in for %u ms (<= 15 s)", (unsigned)sb_deferral_ms(&r.sb));
  /* FW-08: the degraded prompt defers the SCBA prompt the same way */
  play(&r, "FW-08", 4); CHECK(dg_prompt(&r.dg) && dg_degraded(&r.dg) && !sb_prompt_ui(&r.sb) && r.sb.prompt_open, "FW-08 at 305050: degraded prompt active, SCBA UI suspended, clock running");
  CHECK(!md_mandown(&r.md) && !sb_expired(&r.sb), "FW-08 at 305050: not latched, not expired");
  play(&r, "FW-08", 5); CHECK(sb_expired(&r.sb) && md_mandown(&r.md) && md_level(&r.md) == 2 && sb_deferral_ms(&r.sb) <= 15000u && sb_deferral_ms(&r.sb) > 0, "FW-08 at 320050: degraded latch, scba_expired, deferral <= 15 s");
  /* FW-09: latched, SCBA ON, the confirmation clock runs out with no prompt */
  play(&r, "FW-09", 4); CHECK(md_mandown(&r.md) && sb_on(&r.sb) && !r.sb.prompt_open, "FW-09 at 20000: latched, SCBA ON");
  play(&r, "FW-09", 5); CHECK(sb_expired(&r.sb) && !r.sb.shown_ever && md_mandown(&r.md) && md_level(&r.md) == 2 && HAS(r.acts, SB_ACT_EXPIRED), "FW-09 at 320000: scba_expired, no prompt ever shown, still DANGER");
  /* FW-10: a check-in answered with motion resumes the SCBA prompt */
  play(&r, "FW-10", 5); CHECK(md_checkin(&r.md) && r.sb.prompt_open && sb_prompt_ui(&r.sb) == 0 && !sb_expired(&r.sb), "FW-10 at 300300: the press answers the check-in, not the SCBA prompt");
  play(&r, "FW-10", 6); CHECK(!md_checkin(&r.md) && HAS(r.md_acts, MD_ACT_CANCEL_ACK) && !md_mandown(&r.md) && sb_prompt_ui(&r.sb) && HAS(r.acts, SB_ACT_PROMPT_RESUME), "FW-10 at 300900: check-in accepted, cancel_ack, SCBA UI resumed");
  play(&r, "FW-10", 7); CHECK(sb_prompt_ui(&r.sb) && !sb_expired(&r.sb) && sb_prompt_elapsed_ms(&r.sb, 300950) == 950u && sb_deferral_ms(&r.sb) == 700u, "FW-10 at 300950: resumed, not expired, clock elapsed 950 ms");
}
/* FW-04 with the real SCBA machine: Press 1 answers the prompt, three presses in 2 s are MAYDAY; the clock starts before 0 so the time wraps */
static void test_fw04(void) {
  rig_t r; rig_init(&r);
  add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0u - 300000u)); tick(&r, 0);
  CHECK(sb_prompt_ui(&r.sb), "FW-04: SCBA prompt open at t=0 (across the uint32 wrap)");
  cancel(&r, 0); CHECK(!r.sb.prompt_open && !sb_expired(&r.sb) && HAS(r.acts, SB_ACT_PROMPT_CLEARED) && !md_mandown(&r.md), "FW-04: Press 1 clears the SCBA prompt");
  cancel(&r, 600); cancel(&r, 1800);
  CHECK(md_status4_mayday(&r.md) && md_level(&r.md) == 2 && !sb_expired(&r.sb), "FW-04 at 1800: MAYDAY promoted retroactively");
}
static void run_to(rig_t *r, uint32_t from, uint32_t to) { for (uint32_t t = from; t <= to; t += 100) { r->acts = 0; tick(r, t); } }
static void test_cycle(void) {
  rig_t r; rig_init(&r);
  CHECK(!sb_on(&r.sb) && !sb_expired(&r.sb), "cold boot: SCBA OFF");
  add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); CHECK(sb_on(&r.sb) && HAS(r.acts, SB_ACT_STARTED), "switch and coupling ON starts the clock");
  run_to(&r, 100, 299900); CHECK(!r.sb.prompt_open, "no prompt before 300 s");
  run_to(&r, 300000, 300000); CHECK(sb_prompt_ui(&r.sb) && HAS(r.acts, SB_ACT_PROMPT_SHOW), "prompt at 300 s");
  run_to(&r, 300100, 319900); CHECK(sb_on(&r.sb) && !sb_expired(&r.sb), "still ON 19.9 s into the response");
  r.acts = 0; cancel(&r, 310000);
  CHECK(!r.sb.prompt_open && sb_on(&r.sb) && HAS(r.acts, SB_ACT_PROMPT_CLEARED), "a clean CANCEL answers the prompt");
  run_to(&r, 310100, 609900); CHECK(!r.sb.prompt_open, "the clock was renewed: next prompt 300 s after the answer");
  run_to(&r, 610000, 610000); CHECK(sb_prompt_ui(&r.sb), "second prompt at 610 s");
  run_to(&r, 610100, 629900); CHECK(sb_on(&r.sb), "19.9 s into the second response");
  run_to(&r, 630000, 630000); CHECK(sb_expired(&r.sb) && !sb_on(&r.sb) && HAS(r.acts, SB_ACT_EXPIRED | SB_ACT_CRITICAL_FRAME) && !md_mandown(&r.md), "no response in 20 s: scba_expired, back to OFF");
  CHECK(sb_step(&r.sb, B(SB_EV_TICK, 0), 700000) == 0 && sb_expired(&r.sb), "expired stays set with no event");
}
static void test_high_co(void) {
  rig_t r; rig_init(&r);
  add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); add(&r, sb_step(&r.sb, B(SB_EV_CO_HIGH, 1), 10000));
  run_to(&r, 10100, 119900); CHECK(!r.sb.prompt_open, "high CO: no prompt before 120 s");
  run_to(&r, 120000, 120000); CHECK(sb_prompt_ui(&r.sb), "high CO: prompt at 120 s");
  run_to(&r, 120100, 139900); CHECK(sb_on(&r.sb), "high CO: 19.9 s into the response");
  run_to(&r, 140000, 140000); CHECK(sb_expired(&r.sb), "high CO: expiry at 140 s");
  rig_init(&r); add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); run_to(&r, 100, 129900);
  add(&r, sb_step(&r.sb, B(SB_EV_CO_HIGH, 1), 130000)); CHECK(sb_prompt_ui(&r.sb), "CO turns high with the clock 130 s old: prompt at once");
  cancel(&r, 131000); add(&r, sb_step(&r.sb, B(SB_EV_CO_HIGH, 0), 132000));
  run_to(&r, 132100, 420900); CHECK(!r.sb.prompt_open, "lowering CO restores the 300 s period (clock from the answer at 131 s)");
  run_to(&r, 431000, 431000); CHECK(sb_prompt_ui(&r.sb), "prompt 300 s after the answer");
}
static void test_open_recover_boot(void) {
  rig_t r; rig_init(&r);
  add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); run_to(&r, 100, 320000); CHECK(sb_expired(&r.sb), "setup: expired");
  r.acts = 0; add(&r, sb_step(&r.sb, B(SB_EV_CANCEL, 0), 330000));
  CHECK(!sb_expired(&r.sb) && sb_on(&r.sb) && HAS(r.acts, SB_ACT_RECOVERED), "expired with the coupling mated: one clean CANCEL restores ON");
  CHECK(r.sb.clock_ms == 330000u, "recovery restarts the clock at zero");
  add(&r, sb_step(&r.sb, B(SB_EV_OFF, 0), 340000)); CHECK(!sb_on(&r.sb) && HAS(r.acts, SB_ACT_OPENED), "coupling opens: OFF at once");
  rig_init(&r); add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); run_to(&r, 100, 320000);
  add(&r, sb_step(&r.sb, B(SB_EV_OFF, 0), 321000));
  CHECK(sb_expired(&r.sb) && sb_step(&r.sb, B(SB_EV_CANCEL, 0), 322000) == 0 && sb_expired(&r.sb), "expired with the coupling open: CANCEL does not recover");
  add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 323000)); CHECK(!sb_expired(&r.sb) && sb_on(&r.sb), "a physical OFF to ON cycle recovers");
  rig_init(&r); add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); run_to(&r, 100, 320000);
  sb_step(&r.sb, B(SB_EV_SLOT, 2), 321000);
  CHECK(sb_step(&r.sb, B(SB_EV_CANCEL, 0), 322000) == 0 && sb_expired(&r.sb), "a CANCEL while latched (incl. the latch-clear press) never restores SCBA ON");
  sb_init(&r.sb); sb_step(&r.sb, B(SB_EV_BOOT, 3), 5000);
  CHECK(sb_on(&r.sb) && r.sb.clock_ms == 5000u && !sb_expired(&r.sb), "reset: stored ON and contacts closed: ON, clock restarts at zero");
  sb_step(&r.sb, B(SB_EV_BOOT, 1), 5000); CHECK(!sb_on(&r.sb), "reset: stored ON but the coupling is open: OFF");
  sb_step(&r.sb, B(SB_EV_BOOT, 2), 5000); CHECK(!sb_on(&r.sb), "cold power-on (nothing stored): OFF");
}
static void test_deferral_and_wrap(void) {
  rig_t r; rig_init(&r);  /* a short check-in only defers: the prompt resumes with a longer window, never an early expiry */
  add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); run_to(&r, 100, 299900);
  feed(&r, FWE_STILL, 299950); feed(&r, FWE_IMPACT, 299990); run_to(&r, 300000, 300000);
  CHECK(r.sb.prompt_open && !sb_prompt_ui(&r.sb) && md_checkin(&r.md), "prompt due during a check-in: opened but not shown");
  feed(&r, FWE_CANCEL_JACKET, 301000); feed(&r, FWE_MOTION, 302000);
  CHECK(!md_checkin(&r.md) && sb_prompt_ui(&r.sb) && !sb_expired(&r.sb), "check-in answered: the overdue prompt follows recovery");
  run_to(&r, 302100, 321900); CHECK(sb_on(&r.sb) && !sb_expired(&r.sb), "window grew by the 2 s deferral (to 322 s)");
  run_to(&r, 322000, 322000); CHECK(sb_expired(&r.sb), "no answer: expiry 20 s of response after the prompt was shown");
  rig_init(&r); add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0xFFFFFF00u)); r.sb.clock_ms = 0xFFFFFF00u;
  run_to(&r, 0xFFFFFF00u, 0xFFFFFF00u); CHECK(!r.sb.prompt_open, "wrap: no prompt at the start");
  CHECK(sb_step(&r.sb, B(SB_EV_TICK, 0), 0xFFFFFF00u + 300000u) != 0 && r.sb.prompt_open, "wrap: prompt 300 s later across the uint32 wrap");
  rig_init(&r); add(&r, sb_step(&r.sb, B(SB_EV_ON, 0), 0)); r.acts = 0; for (uint32_t t = 100; t <= 100000; t += 100) r.acts |= sb_step(&r.sb, B(SB_EV_TICK, 0), t);
  CHECK(r.acts == 0, "1000 ticks with nothing to report return no action");
}
static void test_degraded(void) {
  dg_state_t d; dg_init(&d);
  CHECK(dg_step(&d, D(DG_EV_TICK, 0), 1000) == 0 && !dg_degraded(&d), "healthy IMU: nothing happens");
  dg_step(&d, D(DG_EV_IMU_FAULT, 0), 10000); CHECK(dg_imu_fault(&d) && !dg_degraded(&d), "fault flag at once (status2 bit 5), mode after the grace");
  CHECK(dg_step(&d, D(DG_EV_TICK, 0), 14900) == 0 && !dg_prompt(&d), "no prompt in the 5 s grace");
  CHECK(HAS(dg_step(&d, D(DG_EV_TICK, 0), 15000), DG_ACT_PROMPT) && dg_prompt(&d) && dg_degraded(&d), "first prompt at the end of the 5 s grace");
  CHECK(HAS(dg_step(&d, D(DG_EV_CANCEL, 0), 16000), DG_ACT_CANCEL_ACK) && !dg_prompt(&d), "either button answers it (no motion test)");
  CHECK(dg_step(&d, D(DG_EV_TICK, 0), 45900) == 0, "the period restarts at the answer: no prompt at 29.9 s");
  CHECK(HAS(dg_step(&d, D(DG_EV_TICK, 0), 46000), DG_ACT_PROMPT), "next prompt 30 s after the answer");
  CHECK(dg_step(&d, D(DG_EV_TICK, 0), 60900) == 0 && dg_prompt(&d), "unanswered for 14.9 s: no latch");
  CHECK(HAS(dg_step(&d, D(DG_EV_TICK, 0), 61000), DG_ACT_LATCH) && !dg_prompt(&d), "unanswered for 15 s: latch DANGER");
  dg_step(&d, D(DG_EV_IMU_OK, 0), 62000); CHECK(dg_step(&d, D(DG_EV_TICK, 0), 66900) == 0 && dg_degraded(&d), "valid samples for 4.9 s: still degraded");
  CHECK(HAS(dg_step(&d, D(DG_EV_TICK, 0), 67000), DG_ACT_RESUMED) && !dg_degraded(&d) && !dg_imu_fault(&d), "valid samples for 5 s: normal mode");
  dg_init(&d); dg_step(&d, D(DG_EV_IMU_FAULT, 0), 0); dg_step(&d, D(DG_EV_LATCHED, 1), 100);
  CHECK(dg_step(&d, D(DG_EV_TICK, 0), 5000) == 0 && !dg_prompt(&d), "latched: no degraded prompts");
}
int main(void) {
  test_scenarios(); test_fw04(); test_cycle(); test_high_co(); test_open_recover_boot(); test_deferral_and_wrap(); test_degraded();
  printf("test_scba: SCBA and degraded mode, %d checks, %s\n", checks, fails ? "FAILED" : "all pass");
  return fails ? 1 : 0;
}
