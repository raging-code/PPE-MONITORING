/* IMU-degraded dead-man mode (Technical Summary section 7). Pure C. After a 5 s IMU-fault grace the node prompts at once and every 30 s; a clean CANCEL on either button answers
   and restarts the period; a prompt unanswered for PPE_IMU_DEGRADED_TIMEOUT_S latches DANGER (the caller sends MD_EV_DEGRADED_LATCH to md_step); valid IMU samples for 5 s resume
   normal mode. dg_step(state, event, now_ms) -> DG_ACT_* bitmask. LATCHED arg 1 = man-down or MAYDAY latched: no prompts while it is set. Constants: docs/adr/0003.md. */
#pragma once
#include <stdint.h>
#define DG_GRACE_MS  5000u   /* IMU fault to the first prompt */
#define DG_PERIOD_MS 30000u  /* prompt period; a clean CANCEL restarts it */
#define DG_RESUME_MS 5000u   /* valid WHO_AM_I and non-frozen samples for this long end degraded mode */
typedef enum { DG_EV_NONE = 0, DG_EV_IMU_FAULT, DG_EV_IMU_OK, DG_EV_CANCEL, DG_EV_TICK, DG_EV_LATCHED } dg_ev_kind_t;
typedef struct { dg_ev_kind_t kind; uint32_t arg; } dg_event_t;
enum { DG_ACT_PROMPT = 1u << 0, DG_ACT_CANCEL_ACK = 1u << 1, DG_ACT_LATCH = 1u << 2, DG_ACT_RESUMED = 1u << 3 };
typedef struct { uint8_t fault, degraded, prompt, ok, latched; uint32_t fault_ms, prompt_ms, next_ms, ok_ms; } dg_state_t;
void dg_init(dg_state_t *s);
uint32_t dg_step(dg_state_t *s, dg_event_t ev, uint32_t now_ms);
uint8_t dg_imu_fault(const dg_state_t *s);  /* status2 bit 5 */
uint8_t dg_degraded(const dg_state_t *s);   /* "MAN-DOWN DEGRADED" */
uint8_t dg_prompt(const dg_state_t *s);     /* a degraded prompt owns the buzzer/CANCEL slot */
