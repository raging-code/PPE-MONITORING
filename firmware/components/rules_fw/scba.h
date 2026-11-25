/* SCBA confirmation machine of the node (Technical Summary section 7, "SCBA declared mode and regulator coupling"). Pure C: no ESP-IDF, no I/O, no globals.
   sb_step(state, event, now_ms) -> SB_ACT_* bitmask. Events: ON / OFF = the debounced switch-and-coupling contact closes / opens (arg unused);
   CANCEL = one clean CANCEL press (either button); TICK = 10 Hz; CO_HIGH arg 1 = ambient CO >= 200 ppm, saturated or unknown (120 s period), 0 = normal (300 s);
   SLOT arg bit0 = a check-in or degraded prompt owns the buzzer/CANCEL slot, bit1 = man-down or MAYDAY latched; BOOT arg bit0 = SCBA was ON in NVS, bit1 = contacts closed now.
   CALL ORDER (fsm_task): a CANCEL goes to sb_step BEFORE md_step and dg_step, so a press that answers a check-in is not also read as an SCBA answer;
   a TICK goes to md_step and dg_step first, then SLOT (if the slot changed), then sb_step TICK. now_ms is a wrapping uint32. */
#pragma once
#include <stdint.h>
typedef enum { SB_EV_NONE = 0, SB_EV_ON, SB_EV_OFF, SB_EV_CANCEL, SB_EV_TICK, SB_EV_CO_HIGH, SB_EV_SLOT, SB_EV_BOOT } sb_ev_kind_t;
typedef struct { sb_ev_kind_t kind; uint32_t arg; } sb_event_t;
enum { SB_ACT_STARTED = 1u << 0, SB_ACT_PROMPT_SHOW = 1u << 1, SB_ACT_PROMPT_SUSPEND = 1u << 2, SB_ACT_PROMPT_RESUME = 1u << 3, SB_ACT_PROMPT_CLEARED = 1u << 4,
       SB_ACT_EXPIRED = 1u << 5, SB_ACT_CRITICAL_FRAME = 1u << 6, SB_ACT_RECOVERED = 1u << 7, SB_ACT_OPENED = 1u << 8 };
typedef struct {
  uint8_t on, closed, expired, high_co, prompt_open, ui, shown_ever, busy, latched;
  uint32_t clock_ms, prompt_ms, busy_since, defer_ms;
} sb_state_t;
void sb_init(sb_state_t *s);
uint32_t sb_step(sb_state_t *s, sb_event_t ev, uint32_t now_ms);
uint8_t sb_on(const sb_state_t *s);                 /* id_mode bit 3 */
uint8_t sb_expired(const sb_state_t *s);            /* status3 bit 3 */
uint8_t sb_prompt_ui(const sb_state_t *s);          /* 1 while the prompt is shown (haptic code 4); 0 when none or suspended */
uint32_t sb_deferral_ms(const sb_state_t *s);       /* time the open prompt was suspended by a check-in or degraded prompt (unlatched) */
uint32_t sb_prompt_elapsed_ms(const sb_state_t *s, uint32_t now_ms); /* 0 when no prompt is open */
