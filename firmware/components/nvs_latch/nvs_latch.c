#include "nvs_latch.h"
#include <string.h>
#include "abi.h"
#define LATCH_NONE 0u
#define LATCH_MAN_DOWN 1u
#define LATCH_MAYDAY 2u
#define LATCH_UNKNOWN 0xFFu  /* stored record is missing or bad: the next observed value is written */
static uint32_t since(uint32_t now, uint32_t t) { return now - t; }  /* wrap-safe */
static int fault(nvsl_t *n, nvsl_fault_t f) { n->faults++; if (n->be.log) n->be.log(n->be.ctx, "nvs_fault", (int)f); return -1; }
static void rec_enc(uint8_t r[3], uint8_t v) { r[0] = NVSL_MAGIC; r[1] = v; r[2] = (uint8_t)~v; }
static int rec_dec(const uint8_t *r, size_t len, uint8_t *v) { if (len != 3 || r[0] != NVSL_MAGIC || r[2] != (uint8_t)~r[1]) return -1; *v = r[1]; return 0; }
/* io: NVSL_IO_OK with *v set, NVSL_IO_NOT_FOUND, NVSL_IO_ERR (unreadable) or 3 (present but invalid) */
static int read_rec(nvsl_t *n, const char *key, uint8_t *v) {
  uint8_t b[8]; size_t len = 0; int io = n->be.get(n->be.ctx, key, b, sizeof b, &len);
  if (io != NVSL_IO_OK) return io;
  return rec_dec(b, len, v) ? 3 : NVSL_IO_OK;
}
static int write_rec(nvsl_t *n, const char *key, uint8_t v) {  /* set, commit, read back, compare */
  uint8_t r[3], g[8]; size_t len = 0; rec_enc(r, v);
  if (n->be.set(n->be.ctx, key, r, sizeof r)) return fault(n, NVSL_FAULT_WRITE);
  if (n->be.commit(n->be.ctx)) return fault(n, NVSL_FAULT_COMMIT);
  if (n->be.get(n->be.ctx, key, g, sizeof g, &len) != NVSL_IO_OK || len != sizeof r || memcmp(g, r, sizeof r)) return fault(n, NVSL_FAULT_READBACK);
  return 0;
}
void nvsl_init(nvsl_t *n, const nvsl_backend_t *be) { memset(n, 0, sizeof *n); n->be = *be; n->latch_stored = LATCH_NONE; }
nvsl_boot_t nvsl_boot(nvsl_t *n, uint8_t reset_cause, uint32_t now_ms) {
  nvsl_boot_t b; uint8_t v = 0, prev = 0; int io;
  memset(&b, 0, sizeof b); n->reset_cause = reset_cause; n->boot_ms = now_ms; b.reset_cause = reset_cause;
  io = read_rec(n, "latch", &v);  /* a present-but-bad or unreadable latch fails safe as latched; a missing key is unlatched */
  if (io == NVSL_IO_OK && v <= LATCH_MAYDAY) { b.latch_cause = v; n->latch_stored = v; }
  else if (io == NVSL_IO_NOT_FOUND) { b.latch_cause = LATCH_NONE; n->latch_stored = LATCH_NONE; }
  else { fault(n, io == NVSL_IO_ERR ? NVSL_FAULT_LATCH_READ : NVSL_FAULT_LATCH_CORRUPT); b.latch_cause = LATCH_MAN_DOWN; n->latch_stored = LATCH_UNKNOWN; }
  n->latch_want = b.latch_cause; b.latch_restored = b.latch_cause != LATCH_NONE; n->restored_latch = b.latch_restored;
  io = read_rec(n, "scba", &v);
  if (io == NVSL_IO_OK && v <= 1u) { n->scba_stored = v; b.scba_on = (uint8_t)(v && reset_cause != ABI_RESET_CAUSE_POWER_ON); }
  else if (io == NVSL_IO_NOT_FOUND) n->scba_stored = 0;
  else { fault(n, NVSL_FAULT_SCBA_BAD); n->scba_stored = LATCH_UNKNOWN; }
  n->scba_want = b.scba_on;
  io = read_rec(n, "boot_ctr", &prev);  /* absent = new flash = 0; unreadable = a random value, logged, and the host re-baseline rule takes over */
  if (io == NVSL_IO_NOT_FOUND) n->boot_ctr = 1;
  else if (io == NVSL_IO_OK) n->boot_ctr = (uint8_t)(prev + 1u);
  else { fault(n, NVSL_FAULT_BOOT_CTR_BAD); n->boot_ctr = (uint8_t)n->be.random(n->be.ctx); }
  for (unsigned i = 0; i < NVSL_BOOT_TRIES; i++) if (!write_rec(n, "boot_ctr", n->boot_ctr)) break;  /* a failure still uses the value in RAM */
  b.boot_ctr = n->boot_ctr;
  return b;
}
void nvsl_observe(nvsl_t *n, uint8_t latch_cause, uint8_t scba_on) {
  n->latch_want = latch_cause; n->scba_want = scba_on ? 1u : 0u;
  if (latch_cause == LATCH_NONE) n->restored_latch = 0;  /* status4 bit 1 stays until the latch is cleared */
}
uint32_t nvsl_service(nvsl_t *n) {
  uint32_t w = 0; uint8_t v = n->latch_want;  /* copies: fsm_task may change the wanted values while a slow write is running; the next call writes them */
  if (v != n->latch_stored && !write_rec(n, "latch", v)) { n->latch_stored = v; w++; }
  v = n->scba_want;
  if (v != n->scba_stored && !write_rec(n, "scba", v)) { n->scba_stored = v; w++; }
  return w;
}
uint32_t nvsl_faults(const nvsl_t *n) { return n->faults; }
uint8_t nvsl_boot_ctr(const nvsl_t *n) { return n->boot_ctr; }
uint8_t nvsl_status2_reboot(const nvsl_t *n, uint32_t now) { return since(now, n->boot_ms) < NVSL_REBOOT_HINT_MS ? ABI_STATUS2_REBOOT_HINT_MASK : 0; }
uint8_t nvsl_status3_restored(const nvsl_t *n, uint32_t now) {
  if (n->reset_cause == ABI_RESET_CAUSE_POWER_ON || since(now, n->boot_ms) >= NVSL_RESTORED_MS) return 0;
  return (uint8_t)(ABI_STATUS3_RESTORED_MASK | ((n->reset_cause << ABI_STATUS3_RESET_CAUSE_SHIFT) & ABI_STATUS3_RESET_CAUSE_MASK));
}
uint8_t nvsl_status4_latch_restored(const nvsl_t *n) { return n->restored_latch ? ABI_STATUS4_LATCH_RESTORED_MASK : 0; }
void nvsl_apply_boot_fields(const nvsl_t *n, uint32_t now, frame_fields_t *f) {
  f->seq = 0; f->boot_ctr = n->boot_ctr; f->status2 |= nvsl_status2_reboot(n, now); f->status3 |= nvsl_status3_restored(n, now); f->status4 |= nvsl_status4_latch_restored(n);
}
