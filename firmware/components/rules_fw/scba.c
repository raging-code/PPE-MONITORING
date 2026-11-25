#include "scba.h"
#include <string.h>
#include "constants.h"
#define S_MS(x) ((uint32_t)(x) * 1000u)
static uint32_t since(uint32_t now, uint32_t t) { return now - t; }  /* wrap-safe */

void sb_init(sb_state_t *s) { memset(s, 0, sizeof *s); }
uint8_t sb_on(const sb_state_t *s) { return s->on; }
uint8_t sb_expired(const sb_state_t *s) { return s->expired; }
uint8_t sb_prompt_ui(const sb_state_t *s) { return s->ui; }
uint32_t sb_deferral_ms(const sb_state_t *s) { return s->defer_ms; }
uint32_t sb_prompt_elapsed_ms(const sb_state_t *s, uint32_t now) { return s->prompt_open ? since(now, s->prompt_ms) : 0; }

static uint32_t period_ms(const sb_state_t *s) { return S_MS(s->high_co ? PPE_SCBA_CONFIRM_HIGH_CO_S : PPE_SCBA_CONFIRM_S); }
static void close_deferral(sb_state_t *s, uint32_t now) { if (s->busy && s->prompt_open) s->defer_ms += since(now, s->busy_since); }
static uint32_t expire(sb_state_t *s) {  /* back to OFF: CO alarms re-arm; a critical frame carries status3 bit 3 */
  s->on = 0; s->expired = 1; s->prompt_open = 0; s->ui = 0;
  return SB_ACT_EXPIRED | SB_ACT_CRITICAL_FRAME;
}
/* The prompt UI is shown only while the prompt is open, the slot is free and the node is not latched. */
static uint32_t sync_ui(sb_state_t *s) {
  uint8_t want = s->prompt_open && !s->busy && !s->latched;
  if (want == s->ui) return 0;
  s->ui = want;
  if (!want) return SB_ACT_PROMPT_SUSPEND;
  uint32_t a = s->shown_ever ? SB_ACT_PROMPT_RESUME : SB_ACT_PROMPT_SHOW;
  s->shown_ever = 1; return a;
}
static uint32_t evaluate(sb_state_t *s, uint32_t now) {
  uint32_t a = 0;
  if (!s->on) return 0;
  if (!s->prompt_open && since(now, s->clock_ms) >= period_ms(s)) {
    if (s->latched) return expire(s);  /* the clock ran out while latched: no prompt, set scba_expired silently */
    s->prompt_open = 1; s->prompt_ms = now; s->busy_since = now;  /* a busy slot defers the prompt, never the clock */
  }
  if (s->prompt_open) {
    /* Latched: 20 s from the prompt. Unlatched: the response window grows by the time a check-in or degraded prompt held the slot (never expires while it holds it). */
    uint32_t win = S_MS(PPE_SCBA_RESPONSE_S) + (s->latched ? 0u : s->defer_ms + (s->busy ? since(now, s->busy_since) : 0u));
    if (since(now, s->prompt_ms) >= win) return expire(s);
  }
  return a | sync_ui(s);
}
uint32_t sb_step(sb_state_t *s, sb_event_t ev, uint32_t now) {
  uint32_t a;
  switch (ev.kind) {
    case SB_EV_ON:
      if (s->on) return 0;
      s->on = 1; s->closed = 1; s->expired = 0; s->prompt_open = 0; s->ui = 0; s->shown_ever = 0; s->defer_ms = 0; s->clock_ms = now;  /* OFF to ON also clears an expiry */
      return SB_ACT_STARTED;
    case SB_EV_OFF:  /* coupling or switch opens: OFF at once, CO alerts return; scba_expired is kept until an ON edge or a clean CANCEL */
      a = SB_ACT_OPENED; s->closed = 0; s->on = 0; s->prompt_open = 0; if (s->ui) a |= SB_ACT_PROMPT_CLEARED; s->ui = 0; return a;
    case SB_EV_CANCEL:
      if (s->latched || s->busy) return 0;  /* the latch-clear press and a check-in answer are not SCBA answers */
      if (s->prompt_open) { s->prompt_open = 0; s->ui = 0; s->clock_ms = now; s->defer_ms = 0; return SB_ACT_PROMPT_CLEARED; }  /* one clean CANCEL renews the clock */
      if (s->expired && s->closed) { s->expired = 0; s->on = 1; s->clock_ms = now; s->defer_ms = 0; return SB_ACT_RECOVERED | SB_ACT_STARTED; }  /* coupling still mated */
      return 0;
    case SB_EV_CO_HIGH: s->high_co = ev.arg != 0; return evaluate(s, now);  /* an overdue prompt opens at once */
    case SB_EV_SLOT:
      close_deferral(s, now);
      s->busy = (ev.arg & 1u) != 0; s->latched = (ev.arg & 2u) != 0;
      if (s->busy && !s->latched) s->busy_since = now;
      return evaluate(s, now);
    case SB_EV_TICK: return evaluate(s, now);
    case SB_EV_BOOT:  /* restore ON only if it was ON and both contacts are still closed; the clock restarts at zero; expiry is not stored */
      sb_init(s); s->closed = (ev.arg & 2u) != 0; s->on = s->closed && (ev.arg & 1u); s->clock_ms = now;
      return s->on ? SB_ACT_STARTED : 0;
    default: return 0;
  }
}
