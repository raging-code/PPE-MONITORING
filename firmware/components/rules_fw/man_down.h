/* Man-down and MAYDAY state machine of the node (Technical Summary section 7, design 11.2). Pure C: no ESP-IDF, no I/O, no clock, no globals.
   Rule of 11.2: md_step(state, event, now_ms) updates the state and returns an action bitmask; hardware tasks only translate hardware into events.
   Events are edges from the sensor layer: STILL / MOTION = chest RMS below / at or above STILL_G, CANCEL_* = one clean 40 to 2000 ms press,
   JACKET_HOLD = a jacket CANCEL released after being held (arg = hold in ms), BOOT = reset (arg = stored latch cause). now_ms is a wrapping uint32.
   Out of scope here: the IMU-degraded dead-man mode, the SCBA machine and the NVS layer (P16); the caller passes the same CANCEL events to the SCBA machine. */
#pragma once
#include <stdint.h>
typedef enum { MD_NORMAL = 0, MD_CHECKIN, MD_LATCHED } md_phase_t;
typedef enum { MD_CAUSE_NONE = 0, MD_CAUSE_MAN_DOWN, MD_CAUSE_MAYDAY } md_cause_t;
typedef enum { MD_EV_NONE = 0, MD_EV_IMPACT, MD_EV_STILL, MD_EV_MOTION, MD_EV_HORIZONTAL, MD_EV_UPRIGHT, MD_EV_CANCEL_JACKET, MD_EV_CANCEL_WRIST,
               MD_EV_JACKET_HOLD, MD_EV_TICK, MD_EV_BOOT } md_ev_kind_t;
typedef struct { md_ev_kind_t kind; uint32_t arg; } md_event_t;

/* Values the Technical Summary gives but shared/constants.json does not hold (docs/adr/0002.md). Everything else comes from constants.h. */
#define MD_IMPACT_WINDOW_MS 3000u   /* fall suspicion: stillness or horizontal posture within 3 s of the impact */
#define MD_CANCEL_MOTION_MS 10000u  /* a CANCEL answers a check-in only if chest RMS rises above STILL_G within 10 s */
#define MD_BARE_MOTION_MS   3000u   /* stillness-started check-in: raw chest RMS above STILL_G for 3 s answers it */
#define MD_CLEAR_SECOND_MS  5000u   /* latch clear: second clean jacket press within 5 s of the 3 s hold */

enum { MD_ACT_CHECKIN_PROMPT = 1u << 0, MD_ACT_PROMPT_REISSUE = 1u << 1, MD_ACT_CHECKIN_CLEARED = 1u << 2, MD_ACT_CANCEL_ACK = 1u << 3,
       MD_ACT_LOG_CANCEL_NO_MOTION = 1u << 4, MD_ACT_LATCH_SET = 1u << 5, MD_ACT_LATCH_CLEAR = 1u << 6, MD_ACT_FULL_ALARM = 1u << 7,
       MD_ACT_ALARM_REDUCED = 1u << 8, MD_ACT_CRITICAL_FRAME = 1u << 9, MD_ACT_LATCH_RESTORED = 1u << 10, MD_ACT_CLEAR_ARMED = 1u << 11 };

typedef struct {
  md_phase_t phase; md_cause_t cause;
  uint8_t still, motion_seen, horizontal, fall_started, warn, reduced, clear_armed, impact_valid, press_pending, n_presses;
  uint32_t still_since, motion_since, impact_ms, checkin_ms, press_ms, armed_ms, presses[3];
} md_state_t;

void md_init(md_state_t *s);
uint32_t md_step(md_state_t *s, md_event_t ev, uint32_t now_ms);
uint8_t md_level(const md_state_t *s);                          /* 0 NORMAL, 1 WARNING, 2 DANGER (ABI node level) */
uint8_t md_mandown(const md_state_t *s);                        /* flags bit 2 */
uint8_t md_checkin(const md_state_t *s);                        /* flags bit 7 */
uint8_t md_status4_mayday(const md_state_t *s);                 /* status4 bit 4 */
uint8_t md_status3_clear_armed(const md_state_t *s);            /* status3 bit 1 */
uint32_t md_stillness_ms(const md_state_t *s, uint32_t now_ms); /* 0 when not still */
