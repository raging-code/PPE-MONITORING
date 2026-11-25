#include "degraded.h"
#include <string.h>
#include "constants.h"
static uint32_t since(uint32_t now, uint32_t t) { return now - t; }  /* wrap-safe */
void dg_init(dg_state_t *s) { memset(s, 0, sizeof *s); }
uint8_t dg_imu_fault(const dg_state_t *s) { return s->fault; }
uint8_t dg_degraded(const dg_state_t *s) { return s->degraded; }
uint8_t dg_prompt(const dg_state_t *s) { return s->prompt; }

uint32_t dg_step(dg_state_t *s, dg_event_t ev, uint32_t now) {
  uint32_t a = 0;
  switch (ev.kind) {
    case DG_EV_IMU_FAULT: if (!s->fault) { s->fault = 1; s->fault_ms = now; } s->ok = 0; return 0;
    case DG_EV_IMU_OK: if (s->fault && !s->ok) { s->ok = 1; s->ok_ms = now; } return 0;
    case DG_EV_LATCHED: s->latched = ev.arg != 0; if (s->latched) s->prompt = 0; return 0;
    case DG_EV_CANCEL:  /* either button answers; any clean CANCEL, no motion test */
      if (!s->prompt) return 0;
      s->prompt = 0; s->next_ms = now + DG_PERIOD_MS; return DG_ACT_CANCEL_ACK;
    case DG_EV_TICK:
      if (!s->fault) return 0;
      if (s->ok && since(now, s->ok_ms) >= DG_RESUME_MS) { s->fault = s->degraded = s->prompt = s->ok = 0; return DG_ACT_RESUMED; }
      if (!s->degraded && since(now, s->fault_ms) >= DG_GRACE_MS) { s->degraded = 1; s->next_ms = now; }
      if (!s->degraded || s->latched) return 0;
      if (s->prompt && since(now, s->prompt_ms) >= (uint32_t)PPE_IMU_DEGRADED_TIMEOUT_S * 1000u) { s->prompt = 0; s->next_ms = now + DG_PERIOD_MS; a |= DG_ACT_LATCH; }
      else if (!s->prompt && (int32_t)(now - s->next_ms) >= 0) { s->prompt = 1; s->prompt_ms = now; a |= DG_ACT_PROMPT; }
      return a;
    default: return 0;
  }
}
