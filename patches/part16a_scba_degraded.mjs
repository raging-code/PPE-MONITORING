// patches/part16a_scba_degraded.mjs  (run from repo root: node patches/part14_frame_codec.mjs [--dry] [--force])
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
  put('firmware/components/rules_fw/scba.h', String.raw`/* SCBA confirmation machine of the node (Technical Summary section 7, "SCBA declared mode and regulator coupling"). Pure C: no ESP-IDF, no I/O, no globals.
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
`);
  put('firmware/components/rules_fw/scba.c', String.raw`#include "scba.h"
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
`);
  put('firmware/components/rules_fw/degraded.h', String.raw`/* IMU-degraded dead-man mode (Technical Summary section 7). Pure C. After a 5 s IMU-fault grace the node prompts at once and every 30 s; a clean CANCEL on either button answers
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
`);
  put('firmware/components/rules_fw/degraded.c', String.raw`#include "degraded.h"
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
`);
  put('firmware/tests/test_scba.c', String.raw`/* P16a gcc test runner: SCBA machine (scba.c) and IMU-degraded mode (degraded.c) with the man-down machine as the slot owner.
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
`);
  putB64('docs/adr/0003.md', 'IyBBRFIgMDAwMzogU0NCQSBtYWNoaW5lIGFuZCBJTVUtZGVncmFkZWQgbW9kZSwgdmFsdWVzIGFuZCByZWFkaW5ncyB0aGUgY29uc3RhbnRzIGZpbGUgZG9lcyBub3QgaG9sZAoKU3RhdHVzOiBQcm9wb3NlZCAoZGVjaWRlZCBpbiB0aGUgUDE2YSBzZXNzaW9uOyBjb25maXJtIGF0IHRoZSBuZXh0IGRlc2lnbiByZXZpZXcpLgpEZXNpZ246IFJldiAzLjQ1IGlzIGZyb3plbiBhbmQgYHNoYXJlZC9jb25zdGFudHMuanNvbmAgaGFzIG5vIGtleSBmb3IgdGhlc2UgdmFsdWVzOyB0aGUgVGVjaG5pY2FsIFN1bW1hcnkgKHNlY3Rpb24gNykgZ2l2ZXMgdGhlbSBpbiBwcm9zZS4KClZhbHVlcywgYXMgYCNkZWZpbmVgcyBpbiBgZmlybXdhcmUvY29tcG9uZW50cy9ydWxlc19mdy9kZWdyYWRlZC5oYCAoc2FtZSBhcHByb2FjaCBhcyBBRFIgMDAwMik6IGBER19HUkFDRV9NU2AgNTAwMCAoSU1VIGZhdWx0IHRvIHRoZSBmaXJzdCBwcm9tcHQpLCBgREdfUEVSSU9EX01TYCAzMDAwMCAocHJvbXB0IHBlcmlvZCwgcmVzdGFydGVkIGJ5IGEgY2xlYW4gQ0FOQ0VMKSwgYERHX1JFU1VNRV9NU2AgNTAwMCAodmFsaWQgSU1VIHNhbXBsZXMgYmVmb3JlIG5vcm1hbCBtb2RlIHJldHVybnMpLiBUaGUgMTUgcyB1bmFuc3dlcmVkLXByb21wdCBsYXRjaCBpcyB0aGUgZXhpc3RpbmcgYFBQRV9JTVVfREVHUkFERURfVElNRU9VVF9TYDsgdGhlIFNDQkEgMzAwLCAxMjAgYW5kIDIwIHMgYXJlIHRoZSBleGlzdGluZyBgUFBFX1NDQkFfKmAuCgpSZWFkaW5ncyBvZiB0aGUgU0NCQSB0ZXh0IHRoYXQgdGhlIHNjZW5hcmlvcyBhbmQgdGVzdHMgcGluICh0aGUgcnVsZXMgYXJlIGluIGBzY2JhLmNgKToKLSBUaGUgcHJvbXB0IG9wZW5zIHdoZW4gdGhlIGNvbmZpcm1hdGlvbiBjbG9jayBydW5zIG91dCBldmVuIGlmIGEgY2hlY2staW4gb3IgZGVncmFkZWQgcHJvbXB0IGhvbGRzIHRoZSBzbG90OyB0aGUgY2xvY2sgaXMgbmV2ZXIgZGVmZXJyZWQsIG9ubHkgdGhlIHByb21wdCBVSS4KLSBVbmxhdGNoZWQsIHRoZSAyMCBzIHJlc3BvbnNlIHdpbmRvdyBncm93cyBieSB0aGUgdGltZSB0aGUgc2xvdCB3YXMgaGVsZCAoc28gYSBzaG9ydCBjaGVjay1pbiBvbmx5IGRlZmVyczsgdGhlIGRlc2lnbidzICJhYm91dCAxNSBzIiBjZWlsaW5nIGlzIHRoZSBjaGVjay1pbiBhbmQgZGVncmFkZWQgbGF0Y2ggdGltZW91dHMsIG5vdCBhIHNlcGFyYXRlIGNvbnN0YW50KS4gTGF0Y2hlZCwgdGhlIHdpbmRvdyBpcyBhIHBsYWluIDIwIHMgZnJvbSB0aGUgcHJvbXB0IChGVy0wNywgRlctMDgpLgotIElmIHRoZSBjbG9jayBydW5zIG91dCB3aGlsZSBhIG1hbi1kb3duIG9yIE1BWURBWSBpcyBsYXRjaGVkIHRoZXJlIGlzIG5vIHByb21wdCBhbmQgbm8gcmVzcG9uc2Ugd2luZG93OiBgc2NiYV9leHBpcmVkYCBpcyBzZXQgYXQgb25jZSwgc2lsZW50bHkgKEZXLTA5LCBleHBpcnkgYXQgMzAwIHMgYWZ0ZXIgU0NCQSBPTikuCi0gQSBDQU5DRUwgaXMgYW4gU0NCQSBhbnN3ZXIgb25seSB3aGVuIHRoZSBzbG90IGlzIGZyZWUgYW5kIHRoZSBub2RlIGlzIG5vdCBsYXRjaGVkLCBzbyB0aGUgbGF0Y2gtY2xlYXIgcHJlc3MgYW5kIGEgY2hlY2staW4gYW5zd2VyIG5ldmVyIHJlc3RvcmUgb3IgcmVuZXcgU0NCQS4KLSBFeHBpcmVkIHdpdGggdGhlIGNvdXBsaW5nIG1hdGVkOiBvbmUgY2xlYW4gQ0FOQ0VMIHJlc3RvcmVzIE9OLiBDb3VwbGluZyBvcGVuOiBvbmx5IGFuIE9GRiB0byBPTiBjeWNsZSAoYW4gT04gZWRnZSkgY2xlYXJzIGl0LgoKVmVjdG9yIGNoZWNrOiBGVy0wNyB0byBGVy0xMCBtYXRjaCB0aGUgcnVsZXMgYXMgcmVhZCBhYm92ZTsgbm8gdmVjdG9yIG9yIHJ1bGUgd2FzIGVkaXRlZC4gVGhlIEZXLTA3IGFuZCBGVy0wOCAiZGVmZXJyYWwgPD0gMTUgcyIgY2hlY2tzIG1lYXN1cmUgZXhhY3RseSAxNTAwMCBtcyBiZWNhdXNlIHRoZSBzY2VuYXJpb3MgdGljayBhdCAzMTUyMDAgYW5kIDMyMDA1MDsgYSAxMCBIeiBsb29wIGxhdGNoZXMgdGhlIGZhbGwgY2hlY2staW4gZWFybGllci4K');
  replace('firmware/components/rules_fw/man_down.h', String.raw`MD_EV_TICK, MD_EV_BOOT } md_ev_kind_t;`, String.raw`MD_EV_TICK, MD_EV_BOOT, MD_EV_DEGRADED_LATCH } md_ev_kind_t;`);
  replace('firmware/components/rules_fw/man_down.h', String.raw`Out of scope here: the IMU-degraded dead-man mode, the SCBA machine and the NVS layer (P16); the caller passes the same CANCEL events to the SCBA machine.`, String.raw`Out of scope here: the NVS layer (P16b). The SCBA machine (scba.c) and the IMU-degraded mode (degraded.c) are separate; the caller passes each CANCEL to scba.c first (see scba.h) and sends MD_EV_DEGRADED_LATCH when degraded.c asks for a latch.`);
  replace('firmware/components/rules_fw/man_down.c', String.raw`return tick(s, now);
    case MD_EV_BOOT:`, String.raw`return tick(s, now);
    case MD_EV_DEGRADED_LATCH: return latch(s, MD_CAUSE_MAN_DOWN);  /* an unanswered degraded prompt (degraded.c) */
    case MD_EV_BOOT:`);
  replace('tools/run_gcc_tests.py', String.raw`'test_rules_fw': ('rules_fw', ['man_down'])}  # P16 adds its machines to rules_fw`, String.raw`'test_rules_fw': ('rules_fw', ['man_down']), 'test_scba': ('rules_fw', ['man_down', 'scba', 'degraded'])}  # P16b adds nvs_latch`);
  append('docs/PROGRESS.md', '- Part 16a done: firmware/components/rules_fw/scba (SCBA confirmation machine: 300 s, 120 s at high CO and 20 s timers from constants, prompt UI suspended while a check-in or degraded prompt holds the slot with the clock running, silent scba_expired while latched, expiry back to OFF, recovery by one clean CANCEL or an OFF to ON cycle, restore on reset) and rules_fw/degraded (IMU-degraded dead-man mode: 5 s grace, 30 s prompts, 15 s latch via MD_EV_DEGRADED_LATCH, 5 s resume), firmware/tests/test_scba.c (FW-07 to FW-10, FW-04 with the real SCBA machine, wrap, cycle and high-CO tests), docs/adr/0003.md; nvs_latch and the reset tests are P16b');
}
