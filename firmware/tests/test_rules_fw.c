/* Requirements: REQ-FW-002 */
/* P15 gcc test runner: components/rules_fw man-down and MAYDAY machine. FW-01 to FW-06 are replayed from the generated fw_vectors.h (shared/vectors/fw_scenarios.json);
   the expected values are written here, by scenario id. The other tests cover the rules of Technical Summary section 7 that no scenario reaches.
   KNOWN() marks a place where a scenario's expected value disagrees with the Technical Summary rule; it must stay different (docs/adr/0002.md). */
#include <stdio.h>
#include <string.h>
#include "abi.h"
#include "man_down.h"
#include "fw_vectors.h"
static int fails, checks, known;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL: "); printf(__VA_ARGS__); printf("\n"); } } while (0)
#define KNOWN(c, ...) do { checks++; if (c) { fails++; printf("FAIL: known vector mismatch is gone: "); printf(__VA_ARGS__); printf("\n"); } else known++; } while (0)
#define HAS(a, bit) (((a) & (bit)) != 0)

static md_event_t E(md_ev_kind_t k, uint32_t arg) { md_event_t e; e.kind = k; e.arg = arg; return e; }
static md_ev_kind_t map(fwe_t e) {
  switch (e) {
    case FWE_IMPACT: return MD_EV_IMPACT; case FWE_STILL: return MD_EV_STILL; case FWE_MOTION: return MD_EV_MOTION;
    case FWE_CANCEL_JACKET: return MD_EV_CANCEL_JACKET; case FWE_TICK: return MD_EV_TICK;
    default: return MD_EV_NONE;  /* SCBA and IMU events belong to the SCBA machine (P16) */
  }
}
/* Replays the first n events of a scenario; acts[i] is the action mask of event i. */
static md_state_t replay(const char *id, size_t n, uint32_t acts[]) {
  md_state_t s; md_init(&s);
  for (size_t i = 0; i < N_FW_SCN; i++) if (!strcmp(FW_SCN[i].id, id)) {
    for (size_t j = 0; j < n && j < FW_SCN[i].n; j++) { uint32_t a = md_step(&s, E(map(FW_SCN[i].ev[j].ev), 0), FW_SCN[i].ev[j].t); if (acts) acts[j] = a; }
    return s;
  }
  CHECK(0, "scenario %s not in fw_vectors.h", id); return s;
}
static void test_scenarios(void) {
  uint32_t a[8] = {0}; md_state_t s;
  for (size_t i = 0; i < N_FW_SCN; i++) if (!strcmp(FW_SCN[i].machine, "man_down")) CHECK(FW_SCN[i].n >= 3, "%s has events", FW_SCN[i].id);
  /* FW-01: CANCEL with a motionless chest during a check-in */
  s = replay("FW-01", 2, a); CHECK(md_checkin(&s) && md_level(&s) == 1 && !md_mandown(&s) && HAS(a[1], MD_ACT_CHECKIN_PROMPT), "FW-01 at 15000: check-in raised, WARNING");
  s = replay("FW-01", 3, a); CHECK(s.press_pending && md_checkin(&s), "FW-01 at 15500: press pending");
  s = replay("FW-01", 4, a); CHECK(HAS(a[3], MD_ACT_LOG_CANCEL_NO_MOTION) && HAS(a[3], MD_ACT_PROMPT_REISSUE) && !s.press_pending && md_checkin(&s) && !md_mandown(&s), "FW-01 at 25500: cancel_no_motion, prompt re-issued");
  CHECK(md_stillness_ms(&s, 25500) == 25500, "FW-01: the rejected press did not reset the stillness timer");
  s = replay("FW-01", 5, a); CHECK(md_stillness_ms(&s, 30000) == 30000, "FW-01 at 30000: stillness 30 s");
  KNOWN(!md_mandown(&s), "FW-01 at 30000: vector says mandown 0; the rule latches at stillness >= 30 s");
  CHECK(md_mandown(&s) && s.cause == MD_CAUSE_MAN_DOWN, "FW-01 at 30000: man-down latched by the 30 s rule");
  /* FW-02: a fall-started check-in is not auto-cleared by 3 s of motion */
  s = replay("FW-02", 2, a); CHECK(md_checkin(&s) && s.fall_started && md_level(&s) == 0 && HAS(a[1], MD_ACT_CHECKIN_PROMPT), "FW-02 at 200: fall-started check-in, notice only");
  s = replay("FW-02", 3, a); CHECK(md_checkin(&s) && !md_mandown(&s), "FW-02 at 3200: bare motion does not clear it");
  s = replay("FW-02", 5, a); CHECK(md_mandown(&s) && s.cause == MD_CAUSE_MAN_DOWN, "FW-02 at 18200: unanswered fall check-in latched after 10 s");
  KNOWN(md_checkin(&s) && !md_mandown(&s), "FW-02 at 18200: vector says still pending, mandown 0; the rule latches after 10 s");
  /* FW-03 to FW-05: MAYDAY */
  s = replay("FW-03", 2, a); CHECK(!md_mandown(&s), "FW-03: two presses are not MAYDAY");
  s = replay("FW-03", 3, a); CHECK(md_mandown(&s) && md_level(&s) == 2 && md_status4_mayday(&s) && s.cause == MD_CAUSE_MAYDAY, "FW-03 at 900: MAYDAY, DANGER, status4 bit 4");
  CHECK(HAS(a[2], MD_ACT_FULL_ALARM) && HAS(a[2], MD_ACT_LATCH_SET) && HAS(a[2], MD_ACT_CRITICAL_FRAME), "FW-03: full alarm, latch write, critical frame");
  s = replay("FW-04", 2, a); CHECK(!md_mandown(&s), "FW-04: Press 1 alone is not MAYDAY");
  s = replay("FW-04", 4, a); CHECK(md_status4_mayday(&s) && md_level(&s) == 2, "FW-04 at 1800: MAYDAY promoted retroactively");
  s = replay("FW-05", 4, a); CHECK(s.press_pending && md_checkin(&s), "FW-05: Press 1 is pending its motion test");
  s = replay("FW-05", 6, a); CHECK(md_status4_mayday(&s) && md_level(&s) == 2 && !s.press_pending, "FW-05 at 16500: MAYDAY although Press 1 was pending");
  /* FW-06: MAYDAY on a latched man-down */
  s = replay("FW-06", 3, a); CHECK(md_mandown(&s) && s.cause == MD_CAUSE_MAN_DOWN && !md_status4_mayday(&s) && HAS(a[2], MD_ACT_LATCH_SET), "FW-06 at 15200: man-down latched, bit 4 clear");
  s = replay("FW-06", 6, a); CHECK(md_mandown(&s) && md_status4_mayday(&s) && s.cause == MD_CAUSE_MAYDAY && md_level(&s) == 2, "FW-06 at 20900: cause upgraded, bit 4 set");
  CHECK(HAS(a[5], MD_ACT_LATCH_SET) && HAS(a[5], MD_ACT_CRITICAL_FRAME) && !HAS(a[5], MD_ACT_FULL_ALARM), "FW-06: new critical frame and latch write, no second alarm start");
  CHECK(md_step(&s, E(MD_EV_MOTION, 0), 21000) == 0 && md_step(&s, E(MD_EV_TICK, 0), 40000) == 0 && !s.reduced, "FW-06: chest movement never reduces a MAYDAY");
}
static md_state_t at(md_state_t s, md_ev_kind_t k, uint32_t t, uint32_t arg, uint32_t *a) { uint32_t r = md_step(&s, E(k, arg), t); if (a) *a = r; return s; }
static md_state_t latched(md_cause_t c) { md_state_t s; md_init(&s); md_step(&s, E(MD_EV_BOOT, c), 0); return s; }
static void test_rules(void) {
  md_state_t s; uint32_t a;
  md_init(&s);  /* stillness: 15 s check-in (WARNING), 30 s latch */
  s = at(s, MD_EV_STILL, 1000, 0, 0); s = at(s, MD_EV_TICK, 15999, 0, &a); CHECK(md_level(&s) == 0 && !md_checkin(&s), "14.999 s of stillness: nothing yet");
  s = at(s, MD_EV_TICK, 16000, 0, &a); CHECK(md_checkin(&s) && md_level(&s) == 1 && !s.fall_started, "15 s of stillness: check-in, WARNING");
  s = at(s, MD_EV_TICK, 31000, 0, &a); CHECK(md_mandown(&s) && md_level(&s) == 2 && HAS(a, MD_ACT_LATCH_SET), "30 s of stillness: man-down latched");
  md_init(&s);  /* a sparse tick that jumps from 0 to 31 s still goes through the check-in */
  s = at(s, MD_EV_STILL, 0, 0, 0); s = at(s, MD_EV_TICK, 31000, 0, &a); CHECK(md_mandown(&s) && HAS(a, MD_ACT_CHECKIN_PROMPT), "tick jump over 30 s: prompt then latch");
  md_init(&s);  /* a clean CANCEL answers a check-in only with chest motion within 10 s */
  s = at(s, MD_EV_STILL, 0, 0, 0); s = at(s, MD_EV_TICK, 15000, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 15500, 0, 0);
  s = at(s, MD_EV_MOTION, 16000, 0, &a); CHECK(!md_checkin(&s) && !md_mandown(&s) && HAS(a, MD_ACT_CANCEL_ACK) && HAS(a, MD_ACT_CHECKIN_CLEARED), "CANCEL then motion: check-in accepted, cancel_ack");
  md_init(&s);
  s = at(s, MD_EV_STILL, 0, 0, 0); s = at(s, MD_EV_TICK, 15000, 0, 0); s = at(s, MD_EV_CANCEL_WRIST, 15500, 0, 0); s = at(s, MD_EV_MOTION, 25500, 0, &a);
  CHECK(md_checkin(&s) && !HAS(a, MD_ACT_CANCEL_ACK), "motion exactly 10 s after the press is too late (the press is rejected from 10 s)");
  md_init(&s);
  s = at(s, MD_EV_STILL, 0, 0, 0); s = at(s, MD_EV_TICK, 15000, 0, 0); s = at(s, MD_EV_CANCEL_WRIST, 15500, 0, 0); s = at(s, MD_EV_MOTION, 25499, 0, &a);
  CHECK(!md_checkin(&s) && HAS(a, MD_ACT_CANCEL_ACK), "motion 9.999 s after the press answers it; the wrist CANCEL answers a check-in too");
  md_init(&s);  /* stillness-started check-in: 3 s of bare motion answers it, without cancel_ack */
  s = at(s, MD_EV_STILL, 0, 0, 0); s = at(s, MD_EV_TICK, 15000, 0, 0); s = at(s, MD_EV_MOTION, 16000, 0, 0);
  s = at(s, MD_EV_TICK, 18999, 0, &a); CHECK(md_checkin(&s), "bare motion for 2.999 s: still pending");
  s = at(s, MD_EV_TICK, 19000, 0, &a); CHECK(!md_checkin(&s) && HAS(a, MD_ACT_CHECKIN_CLEARED) && !HAS(a, MD_ACT_CANCEL_ACK), "bare motion for 3 s clears a stillness prompt");
  md_init(&s);  /* fall suspicion: impact then stillness or horizontal within 3 s */
  s = at(s, MD_EV_IMPACT, 1000, 0, 0); s = at(s, MD_EV_HORIZONTAL, 4000, 0, 0); CHECK(md_checkin(&s) && s.fall_started, "impact then horizontal at 3.0 s: check-in");
  md_init(&s); s = at(s, MD_EV_IMPACT, 1000, 0, 0); s = at(s, MD_EV_STILL, 4001, 0, 0); CHECK(!md_checkin(&s), "stillness 3.001 s after the impact: no fall suspicion");
  md_init(&s); s = at(s, MD_EV_HORIZONTAL, 0, 0, 0); s = at(s, MD_EV_IMPACT, 500, 0, &a); CHECK(md_checkin(&s) && HAS(a, MD_ACT_CHECKIN_PROMPT), "impact while already horizontal: check-in");
  md_init(&s); s = at(s, MD_EV_IMPACT, 0, 0, 0); s = at(s, MD_EV_TICK, 9000, 0, 0); CHECK(!md_checkin(&s) && !md_mandown(&s), "impact alone starts nothing");
  s = latched(MD_CAUSE_MAN_DOWN); s = at(s, MD_EV_IMPACT, 0, 0, &a); CHECK(a == 0 && md_mandown(&s), "impact on a latch does nothing");
  /* MAYDAY window and sliding buffer */
  md_init(&s); s = at(s, MD_EV_CANCEL_JACKET, 0, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 1000, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 2000, 0, 0); CHECK(md_status4_mayday(&s), "three presses in exactly 2 s: MAYDAY");
  md_init(&s); s = at(s, MD_EV_CANCEL_JACKET, 0, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 1000, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 2001, 0, 0); CHECK(!md_mandown(&s), "three presses in 2.001 s: no MAYDAY");
  s = at(s, MD_EV_CANCEL_JACKET, 3000, 0, 0); CHECK(md_status4_mayday(&s), "the window slides: presses at 1.0, 2.001 and 3.0 s");
  md_init(&s); s = at(s, MD_EV_CANCEL_JACKET, 0, 0, 0); s = at(s, MD_EV_CANCEL_WRIST, 100, 0, 0); s = at(s, MD_EV_CANCEL_WRIST, 200, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 300, 0, 0); CHECK(!md_mandown(&s), "the wrist CANCEL never counts toward MAYDAY");
  s = latched(MD_CAUSE_MAYDAY); s = at(s, MD_EV_CANCEL_JACKET, 0, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 1, 0, 0); s = at(s, MD_EV_CANCEL_JACKET, 2, 0, &a); CHECK(a == 0, "MAYDAY on a MAYDAY sends no second frame");
  /* MAN-DOWN movement label */
  s = latched(MD_CAUSE_MAN_DOWN); s = at(s, MD_EV_MOTION, 1000, 0, 0); s = at(s, MD_EV_TICK, 5999, 0, &a); CHECK(!s.reduced && a == 0, "movement for 4.999 s: alarm unchanged");
  s = at(s, MD_EV_TICK, 6000, 0, &a); CHECK(s.reduced && HAS(a, MD_ACT_ALARM_REDUCED) && md_mandown(&s) && md_level(&s) == 2, "movement for 5 s: reduced pattern, latch and DANGER remain");
  s = at(s, MD_EV_STILL, 7000, 0, 0); s = at(s, MD_EV_TICK, 21999, 0, &a); CHECK(s.reduced, "stillness 14.999 s: still reduced");
  s = at(s, MD_EV_TICK, 22000, 0, &a); CHECK(!s.reduced && HAS(a, MD_ACT_FULL_ALARM), "stillness 15 s restores the full alarm");
  /* two-action latch clear */
  s = latched(MD_CAUSE_MAN_DOWN); s = at(s, MD_EV_JACKET_HOLD, 1000, 2999, &a); CHECK(a == 0 && !md_status3_clear_armed(&s), "a hold of 2.999 s does not arm the clear");
  s = at(s, MD_EV_CANCEL_WRIST, 1500, 0, &a); CHECK(md_mandown(&s), "the wrist CANCEL never clears a latch");
  s = at(s, MD_EV_JACKET_HOLD, 2000, 3000, &a); CHECK(md_status3_clear_armed(&s) && HAS(a, MD_ACT_CLEAR_ARMED), "a hold of 3 s arms the clear");
  { md_state_t t = at(s, MD_EV_CANCEL_JACKET, 7000, 0, &a); CHECK(!md_mandown(&t) && !t.clear_armed && HAS(a, MD_ACT_LATCH_CLEAR) && HAS(a, MD_ACT_CANCEL_ACK), "second press at 5.0 s clears the latch with cancel_ack"); }
  { md_state_t t = at(s, MD_EV_CANCEL_JACKET, 7001, 0, &a); CHECK(md_mandown(&t) && a == 0, "second press at 5.001 s does not clear"); }
  { md_state_t t = at(s, MD_EV_TICK, 7001, 0, 0); CHECK(!md_status3_clear_armed(&t), "the armed state expires after 5 s"); }
  s = latched(MD_CAUSE_MAN_DOWN); s = at(s, MD_EV_STILL, 0, 0, 0); s = at(s, MD_EV_JACKET_HOLD, 40000, 3000, 0); s = at(s, MD_EV_CANCEL_JACKET, 41000, 0, 0);
  s = at(s, MD_EV_TICK, 42000, 0, &a); CHECK(!md_mandown(&s) && !md_checkin(&s), "after a clear the stillness timer restarts, so the latch does not return at once");
  s = latched(MD_CAUSE_MAYDAY); s = at(s, MD_EV_JACKET_HOLD, 0, 3000, 0); s = at(s, MD_EV_CANCEL_JACKET, 1000, 0, 0); CHECK(!md_mandown(&s) && s.cause == MD_CAUSE_NONE, "a MAYDAY latch clears the same way");
  /* boot */
  md_init(&s); s = at(s, MD_EV_BOOT, 0, MD_CAUSE_MAYDAY, &a); CHECK(md_status4_mayday(&s) && md_level(&s) == 2 && HAS(a, MD_ACT_LATCH_RESTORED) && HAS(a, MD_ACT_FULL_ALARM), "boot with a stored MAYDAY comes back as MAYDAY");
  s = at(s, MD_EV_BOOT, 0, MD_CAUSE_MAN_DOWN, 0); CHECK(md_mandown(&s) && !md_status4_mayday(&s), "boot with a stored man-down comes back as man-down, bit 4 clear");
  s = at(s, MD_EV_BOOT, 0, MD_CAUSE_NONE, &a); CHECK(!md_mandown(&s) && a == 0, "boot with no latch is unlatched");
  /* wrap-safe clock */
  md_init(&s); s = at(s, MD_EV_STILL, 0xFFFFF000u, 0, 0); s = at(s, MD_EV_TICK, 0xFFFFF000u + 15000u, 0, 0); CHECK(md_checkin(&s), "15 s of stillness across the uint32 wrap");
  s = at(s, MD_EV_TICK, 0xFFFFF000u + 30000u, 0, 0); CHECK(md_mandown(&s), "30 s of stillness across the uint32 wrap");
}
int main(void) {
  test_scenarios(); test_rules();
  printf("test_rules_fw: man-down and MAYDAY, %d checks, %d known vector mismatches, %s\n", checks, known, fails ? "FAILED" : "all pass");
  return fails ? 1 : 0;
}
