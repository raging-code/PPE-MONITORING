#include "man_down.h"
#include <string.h>
#include "constants.h"
#define S_MS(x) ((uint32_t)(x) * 1000u)
static uint32_t since(uint32_t now, uint32_t t) { return now - t; }  /* wrap-safe */

void md_init(md_state_t *s) { memset(s, 0, sizeof *s); }
uint8_t md_level(const md_state_t *s) { return s->phase == MD_LATCHED ? 2 : (s->phase == MD_CHECKIN && s->warn) ? 1 : 0; }
uint8_t md_mandown(const md_state_t *s) { return s->phase == MD_LATCHED; }
uint8_t md_checkin(const md_state_t *s) { return s->phase == MD_CHECKIN; }
uint8_t md_status4_mayday(const md_state_t *s) { return s->phase == MD_LATCHED && s->cause == MD_CAUSE_MAYDAY; }
uint8_t md_status3_clear_armed(const md_state_t *s) { return s->clear_armed; }
uint32_t md_stillness_ms(const md_state_t *s, uint32_t now) { return s->still ? since(now, s->still_since) : 0; }

static uint32_t start_checkin(md_state_t *s, uint32_t now, uint8_t fall) {
  s->phase = MD_CHECKIN; s->fall_started = fall; s->warn = 0; s->checkin_ms = now; s->press_pending = 0; s->impact_valid = 0;
  return MD_ACT_CHECKIN_PROMPT;
}
/* Latch or upgrade. MAYDAY reuses the man-down latch; MAYDAY on a man-down latch upgrades the stored cause and sends a new critical frame. */
static uint32_t latch(md_state_t *s, md_cause_t cause) {
  if (s->phase == MD_LATCHED) {
    if (cause != MD_CAUSE_MAYDAY || s->cause == MD_CAUSE_MAYDAY) return 0;
    s->cause = cause; s->reduced = 0; return MD_ACT_LATCH_SET | MD_ACT_CRITICAL_FRAME;
  }
  s->phase = MD_LATCHED; s->cause = cause; s->fall_started = 0; s->warn = 0; s->reduced = 0; s->press_pending = 0; s->impact_valid = 0; s->clear_armed = 0;
  return MD_ACT_FULL_ALARM | MD_ACT_LATCH_SET | MD_ACT_CRITICAL_FRAME;
}
static uint32_t accept_press(md_state_t *s) {  /* clean CANCEL followed by chest motion: check-in answered */
  s->phase = MD_NORMAL; s->fall_started = 0; s->warn = 0; s->press_pending = 0;
  return MD_ACT_CHECKIN_CLEARED | MD_ACT_CANCEL_ACK;
}
static uint32_t fall_check(md_state_t *s, uint32_t now) {  /* IMPACT, then stillness or horizontal posture within 3 s */
  if (s->phase == MD_NORMAL && s->impact_valid && since(now, s->impact_ms) <= MD_IMPACT_WINDOW_MS) return start_checkin(s, now, 1);
  return 0;
}
static uint32_t press(md_state_t *s, md_ev_kind_t k, uint32_t now) {
  if (k == MD_EV_CANCEL_JACKET) {
    if (s->clear_armed && since(now, s->armed_ms) <= MD_CLEAR_SECOND_MS) {  /* second action of the two-action clear; not counted for MAYDAY */
      s->phase = MD_NORMAL; s->cause = MD_CAUSE_NONE; s->clear_armed = 0; s->n_presses = 0; s->reduced = 0;
      if (s->still) s->still_since = now;  /* the stillness timer restarts, or the latch would return at once */
      return MD_ACT_CANCEL_ACK | MD_ACT_LATCH_CLEAR;
    }
    s->clear_armed = 0;
    if (s->n_presses < PPE_MAYDAY_PRESSES) s->presses[s->n_presses++] = now;
    else { s->presses[0] = s->presses[1]; s->presses[1] = s->presses[2]; s->presses[2] = now; }
    if (s->n_presses == PPE_MAYDAY_PRESSES && since(s->presses[2], s->presses[0]) <= S_MS(PPE_MAYDAY_WINDOW_S)) {
      s->n_presses = 0;  /* a press that is pending its motion test, or was rejected, still counts */
      return latch(s, MD_CAUSE_MAYDAY);
    }
  }
  if (s->phase != MD_CHECKIN) return 0;  /* both buttons answer a check-in; only the jacket counts for MAYDAY and clears a latch */
  if (!s->still) return accept_press(s);
  if (!s->press_pending) { s->press_pending = 1; s->press_ms = now; }
  return 0;
}
static uint32_t tick(md_state_t *s, uint32_t now) {
  uint32_t a = 0;
  if (s->clear_armed && since(now, s->armed_ms) > MD_CLEAR_SECOND_MS) s->clear_armed = 0;
  if (s->impact_valid && since(now, s->impact_ms) > MD_IMPACT_WINDOW_MS) s->impact_valid = 0;
  if (s->phase == MD_NORMAL && s->still && since(now, s->still_since) >= S_MS(PPE_CHECKIN_STILL_S)) { a |= start_checkin(s, now, 0); s->checkin_ms = s->still_since; }
  if (s->phase == MD_CHECKIN) {
    if (s->still && since(now, s->still_since) >= S_MS(PPE_CHECKIN_STILL_S)) s->warn = 1;  /* a stillness prompt is WARNING; a fall-only prompt is a notice */
    if (s->press_pending && since(now, s->press_ms) >= MD_CANCEL_MOTION_MS) { s->press_pending = 0; a |= MD_ACT_LOG_CANCEL_NO_MOTION | MD_ACT_PROMPT_REISSUE; }
    if ((s->still && since(now, s->still_since) >= S_MS(PPE_MANDOWN_STILL_S)) || (s->fall_started && since(now, s->checkin_ms) >= S_MS(PPE_FALL_CHECKIN_TIMEOUT_S)))
      a |= latch(s, MD_CAUSE_MAN_DOWN);  /* a latch that fires first wins over a pending press */
    else if (!s->fall_started && !s->still && s->motion_seen && since(now, s->motion_since) >= MD_BARE_MOTION_MS) {
      s->phase = MD_NORMAL; s->warn = 0; s->press_pending = 0; a |= MD_ACT_CHECKIN_CLEARED;  /* bare motion answers a stillness-started prompt only */
    }
  } else if (s->phase == MD_LATCHED && s->cause == MD_CAUSE_MAN_DOWN) {  /* MAYDAY never reduces */
    if (!s->reduced && !s->still && s->motion_seen && since(now, s->motion_since) >= S_MS(PPE_MANDOWN_MOVE_LABEL_S)) { s->reduced = 1; a |= MD_ACT_ALARM_REDUCED; }
    else if (s->reduced && s->still && since(now, s->still_since) >= S_MS(PPE_MANDOWN_STILL_REVERT_S)) { s->reduced = 0; a |= MD_ACT_FULL_ALARM; }
  }
  return a;
}
uint32_t md_step(md_state_t *s, md_event_t ev, uint32_t now) {
  switch (ev.kind) {
    case MD_EV_IMPACT:
      if (s->phase != MD_NORMAL) return 0;
      if (s->still || s->horizontal) return start_checkin(s, now, 1);
      s->impact_valid = 1; s->impact_ms = now; return 0;
    case MD_EV_STILL: if (!s->still) { s->still = 1; s->still_since = now; } return fall_check(s, now);
    case MD_EV_HORIZONTAL: s->horizontal = 1; return fall_check(s, now);
    case MD_EV_UPRIGHT: s->horizontal = 0; return 0;
    case MD_EV_MOTION:
      if (s->still || !s->motion_seen) { s->motion_since = now; s->motion_seen = 1; }
      s->still = 0;
      return (s->phase == MD_CHECKIN && s->press_pending && since(now, s->press_ms) < MD_CANCEL_MOTION_MS) ? accept_press(s) : 0;
    case MD_EV_CANCEL_JACKET: case MD_EV_CANCEL_WRIST: return press(s, ev.kind, now);
    case MD_EV_JACKET_HOLD:
      if (s->phase != MD_LATCHED || s->clear_armed || ev.arg < S_MS(PPE_CLEAR_HOLD_S)) return 0;
      s->clear_armed = 1; s->armed_ms = now; return MD_ACT_CLEAR_ARMED;
    case MD_EV_TICK: return tick(s, now);
    case MD_EV_DEGRADED_LATCH: return latch(s, MD_CAUSE_MAN_DOWN);  /* an unanswered degraded prompt (degraded.c) */
    case MD_EV_BOOT:  /* restore the stored latch before anything else; the boot frame carries mandown=1, latch_restored and the cause */
      md_init(s);
      if (ev.arg == MD_CAUSE_NONE) return 0;
      s->phase = MD_LATCHED; s->cause = (md_cause_t)ev.arg;
      return MD_ACT_FULL_ALARM | MD_ACT_LATCH_RESTORED | MD_ACT_CRITICAL_FRAME;
    default: return 0;
  }
}
