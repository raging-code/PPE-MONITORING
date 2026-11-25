// patches/part15_man_down_mayday.mjs  (run from repo root: node patches/part14_frame_codec.mjs [--dry] [--force])
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
  put('firmware/components/rules_fw/man_down.h', String.raw`/* Man-down and MAYDAY state machine of the node (Technical Summary section 7, design 11.2). Pure C: no ESP-IDF, no I/O, no clock, no globals.
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
`);
  put('firmware/components/rules_fw/man_down.c', String.raw`#include "man_down.h"
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
    case MD_EV_BOOT:  /* restore the stored latch before anything else; the boot frame carries mandown=1, latch_restored and the cause */
      md_init(s);
      if (ev.arg == MD_CAUSE_NONE) return 0;
      s->phase = MD_LATCHED; s->cause = (md_cause_t)ev.arg;
      return MD_ACT_FULL_ALARM | MD_ACT_LATCH_RESTORED | MD_ACT_CRITICAL_FRAME;
    default: return 0;
  }
}
`);
  put('tools/gen_fw_vectors.py', String.raw`#!/usr/bin/env python3
"""tools/gen_fw_vectors.py: writes firmware/tests/fw_vectors.h from shared/vectors/fw_scenarios.json (P13), so the gcc runner replays the same events
with no JSON parser in C. Run: python tools/gen_fw_vectors.py (just gen does it). Only ids, machine names, event times and event names are emitted;
the expected values stay in firmware/tests/test_rules_fw.c next to the scenario id."""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def main():
    d = json.load(open(os.path.join(ROOT, 'shared', 'vectors', 'fw_scenarios.json'), encoding='utf8'))
    names = sorted({e['ev'] for s in d['scenarios'] for e in s['events']})
    o = ['/* GENERATED by tools/gen_fw_vectors.py from shared/vectors/fw_scenarios.json. Do not edit. */', '#pragma once', '#include <stddef.h>', '#include <stdint.h>',
         'typedef enum { ' + ', '.join(f'FWE_{n}' for n in names) + ' } fwe_t;', 'typedef struct { uint32_t t; fwe_t ev; } fw_ev_t;',
         'typedef struct { const char *id, *machine; size_t n; const fw_ev_t *ev; } fw_scn_t;']
    for s in d['scenarios']:
        v = s['id'].replace('-', '_')
        o.append(f'static const fw_ev_t EV_{v}[] = {{ ' + ', '.join('{%d, FWE_%s}' % (e['t'], e['ev']) for e in s['events']) + ' };')
    o.append('static const fw_scn_t FW_SCN[] = {')
    o += ['  {"%s", "%s", %d, EV_%s},' % (s['id'], s['machine'], len(s['events']), s['id'].replace('-', '_')) for s in d['scenarios']]
    o += ['};', f'#define N_FW_SCN {len(d["scenarios"])}u', '']
    open(os.path.join(ROOT, 'firmware', 'tests', 'fw_vectors.h'), 'w', newline='\n').write('\n'.join(o))
    print(f'wrote firmware/tests/fw_vectors.h: {len(d["scenarios"])} scenarios')
if __name__ == '__main__': main()
`);
  put('firmware/tests/test_rules_fw.c', String.raw`/* P15 gcc test runner: components/rules_fw man-down and MAYDAY machine. FW-01 to FW-06 are replayed from the generated fw_vectors.h (shared/vectors/fw_scenarios.json);
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
`);
  put('firmware/tests/fw_vectors.h', String.raw`/* GENERATED by tools/gen_fw_vectors.py from shared/vectors/fw_scenarios.json. Do not edit. */
#pragma once
#include <stddef.h>
#include <stdint.h>
typedef enum { FWE_CANCEL_JACKET, FWE_IMPACT, FWE_IMU_FAULT, FWE_MOTION, FWE_SCBA_EXPIRY, FWE_SCBA_ON, FWE_SCBA_PROMPT_ACTIVE, FWE_SCBA_PROMPT_DUE, FWE_STILL, FWE_TICK } fwe_t;
typedef struct { uint32_t t; fwe_t ev; } fw_ev_t;
typedef struct { const char *id, *machine; size_t n; const fw_ev_t *ev; } fw_scn_t;
static const fw_ev_t EV_FW_01[] = { {0, FWE_STILL}, {15000, FWE_TICK}, {15500, FWE_CANCEL_JACKET}, {25500, FWE_TICK}, {30000, FWE_TICK} };
static const fw_ev_t EV_FW_02[] = { {0, FWE_IMPACT}, {200, FWE_STILL}, {3200, FWE_MOTION}, {3500, FWE_STILL}, {18200, FWE_TICK} };
static const fw_ev_t EV_FW_03[] = { {0, FWE_CANCEL_JACKET}, {400, FWE_CANCEL_JACKET}, {900, FWE_CANCEL_JACKET} };
static const fw_ev_t EV_FW_04[] = { {0, FWE_SCBA_PROMPT_ACTIVE}, {0, FWE_CANCEL_JACKET}, {600, FWE_CANCEL_JACKET}, {1800, FWE_CANCEL_JACKET} };
static const fw_ev_t EV_FW_05[] = { {0, FWE_STILL}, {15000, FWE_TICK}, {15100, FWE_CANCEL_JACKET}, {15400, FWE_CANCEL_JACKET}, {16500, FWE_CANCEL_JACKET} };
static const fw_ev_t EV_FW_06[] = { {0, FWE_IMPACT}, {200, FWE_STILL}, {15200, FWE_TICK}, {20000, FWE_CANCEL_JACKET}, {20400, FWE_CANCEL_JACKET}, {20900, FWE_CANCEL_JACKET} };
static const fw_ev_t EV_FW_07[] = { {0, FWE_SCBA_ON}, {280000, FWE_TICK}, {300000, FWE_SCBA_PROMPT_DUE}, {300100, FWE_STILL}, {300200, FWE_IMPACT}, {310100, FWE_TICK}, {315200, FWE_TICK}, {320000, FWE_SCBA_EXPIRY} };
static const fw_ev_t EV_FW_08[] = { {0, FWE_SCBA_ON}, {300000, FWE_SCBA_PROMPT_DUE}, {300050, FWE_IMU_FAULT}, {305050, FWE_TICK}, {320050, FWE_SCBA_EXPIRY} };
static const fw_ev_t EV_FW_09[] = { {0, FWE_IMPACT}, {200, FWE_STILL}, {15200, FWE_TICK}, {20000, FWE_SCBA_ON}, {320000, FWE_SCBA_EXPIRY} };
static const fw_ev_t EV_FW_10[] = { {0, FWE_SCBA_ON}, {300000, FWE_SCBA_PROMPT_DUE}, {300100, FWE_STILL}, {300200, FWE_IMPACT}, {300300, FWE_CANCEL_JACKET}, {300900, FWE_MOTION}, {300950, FWE_TICK} };
static const fw_scn_t FW_SCN[] = {
  {"FW-01", "man_down", 5, EV_FW_01},
  {"FW-02", "man_down", 5, EV_FW_02},
  {"FW-03", "man_down", 3, EV_FW_03},
  {"FW-04", "man_down", 4, EV_FW_04},
  {"FW-05", "man_down", 5, EV_FW_05},
  {"FW-06", "man_down", 6, EV_FW_06},
  {"FW-07", "scba", 8, EV_FW_07},
  {"FW-08", "scba", 5, EV_FW_08},
  {"FW-09", "scba", 5, EV_FW_09},
  {"FW-10", "scba", 7, EV_FW_10},
};
#define N_FW_SCN 10u
`);
  putB64('docs/adr/0002.md', 'IyBBRFIgMDAwMjogZm91ciBmaXJtd2FyZSB2YWx1ZXMgdGhlIFRlY2huaWNhbCBTdW1tYXJ5IGdpdmVzIGFuZCBjb25zdGFudHMuanNvbiBkb2VzIG5vdCBob2xkCgpTdGF0dXM6IFByb3Bvc2VkIChkZWNpZGVkIGluIHRoZSBQMTUgc2Vzc2lvbjsgY29uZmlybSBhdCB0aGUgbmV4dCBkZXNpZ24gcmV2aWV3KS4KRGVzaWduOiBSZXYgMy40NSBpcyBmcm96ZW4gYW5kIGBzaGFyZWQvY29uc3RhbnRzLmpzb25gIGhhcyBubyBrZXkgZm9yIHRoZXNlIGZvdXIgdmFsdWVzLCB3aGljaCB0aGUgVGVjaG5pY2FsIFN1bW1hcnkgKHNlY3Rpb24gNykgc3RhdGVzIGluIHByb3NlLgoKRGVjaXNpb246IGZvdXIgYCNkZWZpbmVgcyBpbiBgZmlybXdhcmUvY29tcG9uZW50cy9ydWxlc19mdy9tYW5fZG93bi5oYCwgbm90IG5ldyBrZXlzLCBzbyB0aGUgZnJvemVuIGNvbnN0YW50cyBmaWxlIHN0YXlzIHVuY2hhbmdlZC4KCi0gYE1EX0lNUEFDVF9XSU5ET1dfTVMgPSAzMDAwYDogZmFsbCBzdXNwaWNpb24gbmVlZHMgc3RpbGxuZXNzIG9yIGhvcml6b250YWwgcG9zdHVyZSB3aXRoaW4gMyBzIG9mIHRoZSBpbXBhY3QuCi0gYE1EX0NBTkNFTF9NT1RJT05fTVMgPSAxMDAwMGA6IGEgQ0FOQ0VMIGFuc3dlcnMgYSBjaGVjay1pbiBvbmx5IGlmIGNoZXN0IFJNUyByaXNlcyBhYm92ZSBTVElMTF9HIHdpdGhpbiAxMCBzIG9mIHRoZSBwcmVzcy4KLSBgTURfQkFSRV9NT1RJT05fTVMgPSAzMDAwYDogcmF3IGNoZXN0IFJNUyBhYm92ZSBTVElMTF9HIGZvciAzIHMgYW5zd2VycyBhIHN0aWxsbmVzcy1zdGFydGVkIGNoZWNrLWluLgotIGBNRF9DTEVBUl9TRUNPTkRfTVMgPSA1MDAwYDogdGhlIHNlY29uZCBjbGVhbiBqYWNrZXQgcHJlc3Mgb2YgdGhlIGxhdGNoIGNsZWFyIG11c3QgY29tZSB3aXRoaW4gNSBzIG9mIHRoZSAzIHMgaG9sZC4KCklmIHRoZSBvd25lciBwcmVmZXJzIHJlYWwga2V5cywgYWRkIHRoZW0gdG8gYGNvbnN0YW50cy5qc29uYCwgcmVnZW5lcmF0ZSwgYW5kIGRlbGV0ZSB0aGUgZm91ciBkZWZpbmVzLgoKVmVjdG9yIGRpc2FncmVlbWVudHMgZm91bmQgaW4gUDE1ICh0aGUgdmVjdG9ycyBhbmQgdGhlIHJ1bGVzIHdlcmUgbm90IGVkaXRlZDsgYHRlc3RfcnVsZXNfZncuY2AgcGlucyBlYWNoIG9uZSB3aXRoIGBLTk9XTigpYCBzbyBpdCBmYWlscyB3aGVuIHRoZSBkaXNhZ3JlZW1lbnQgaXMgcmVzb2x2ZWQpOgoKLSBGVy0wMSBhdCB0PTMwMDAwOiB0aGUgdmVjdG9yIGV4cGVjdHMgYG1hbmRvd25gIDAgYWZ0ZXIgZXhhY3RseSAzMCBzIG9mIHN0aWxsbmVzcy4gVGhlIFRlY2huaWNhbCBTdW1tYXJ5IHJ1bGUgaXMgIlN0aWxsbmVzcyA+PSAzMCBzIiwgc28gdGhlIG5vZGUgbGF0Y2hlcyBhdCAzMDAwMC4gVGhlIHZlY3RvciBwcm9iYWJseSBtZWFucyAianVzdCBiZWZvcmUgMzAgcyIuIFByb3Bvc2VkIGZpeDogY2hhbmdlIHRoZSB2ZWN0b3IncyBjaGVjayB0aW1lIHRvIDI5OTAwIG9yIGl0cyBleHBlY3RhdGlvbiB0byBgbWFuZG93bmAgMS4KLSBGVy0wMiBhdCB0PTE4MjAwOiB0aGUgdmVjdG9yIGV4cGVjdHMgdGhlIGNoZWNrLWluIHN0aWxsIHBlbmRpbmcgYW5kIGBtYW5kb3duYCAwLiBUaGUgcnVsZSBpcyAiZmFsbC1zdGFydGVkIGNoZWNrLWluIHVuYW5zd2VyZWQgZm9yIDEwIHMgLT4gTUFOLURPV04iLCBhbmQgRlctMDYgYW5kIHRoZSBEMiByb3cgYWdyZWUgKGEgbGF0Y2ggYWZ0ZXIgdGhlIDEwIHMgdGltZW91dCksIHNvIHRoZSBub2RlIGxhdGNoZXMgYXQgMTAyMDAuIFByb3Bvc2VkIGZpeDogZXhwZWN0IGBtYW5kb3duYCAxIGF0IDE4MjAwLCBvciBlbmQgdGhlIHNjZW5hcmlvIGJlZm9yZSAxMDIwMC4K');
  replace('tools/run_gcc_tests.py', "for name, parts in TESTS.items():", "for name, (comp, parts) in TESTS.items():");
  replace('tools/run_gcc_tests.py', "'-I', 'firmware/components/frame', '-I', 'firmware/tests',\n               *[f'firmware/components/frame/{p}.c' for p in parts]", "'-I', f'firmware/components/{comp}', '-I', 'firmware/tests',\n               *[f'firmware/components/{comp}/{p}.c' for p in parts]");
  replace('tools/run_gcc_tests.py', "FRAME = ['aes128', 'cmac', 'crc8', 'frame']\nTESTS = {'test_frame': FRAME}", "TESTS = {'test_frame': ('frame', ['aes128', 'cmac', 'crc8', 'frame']), 'test_rules_fw': ('rules_fw', ['man_down'])}  # P16 adds its machines to rules_fw");
  replace('justfile', 'test-fw:\n    python tools/gen_frame_vectors.py\n    python tools/run_gcc_tests.py', 'test-fw:\n    python tools/gen_frame_vectors.py\n    python tools/gen_fw_vectors.py\n    python tools/run_gcc_tests.py');
  replace('justfile', 'python tools/gen_frame_vectors.py\n\n# P1: design document consistency', 'python tools/gen_frame_vectors.py\n    python tools/gen_fw_vectors.py\n\n# P1: design document consistency');
  append('docs/PROGRESS.md', '- Part 15 done: firmware/components/rules_fw/man_down (man-down and MAYDAY as md_step(state, event, now_ms) -> action bitmask, pure C: check-in by stillness or fall, 10 s CANCEL motion test with cancel_no_motion, latch at 30 s stillness or 10 s unanswered fall check-in, MAYDAY by three jacket presses in 2 s incl. retroactive and upgrade of a latched man-down, 5 s movement label, two-action clear, boot restore of the stored cause), tools/gen_fw_vectors.py (fw_vectors.h from fw_scenarios.json), firmware/tests/test_rules_fw.c (FW-01 to FW-06), docs/adr/0002.md (four values not in constants.json; FW-01 and FW-02 vector disagreements)');
}
