/* Persisted node state: man-down latch cause, SCBA mode, boot_ctr (Technical Summary section 7 "Persist man-down latch...", design 11.2).
   Pure C: no ESP-IDF, no I/O, no clock, no globals. Flash is reached only through nvsl_backend_t (ESP-IDF NVS at P17, a mock in test_nvs.c).
   THREE ROUTES:
   nvsl_boot()    once per boot, before the 10 Hz loop starts (blocking is allowed): reads the three records, commits boot_ctr+1, returns what the machines need.
   nvsl_observe() from fsm_task every 100 ms with latch_cause = md_mandown(&md) ? md.cause : 0 and scba_on = sb_on(&sb). RAM only: it never calls the backend,
                  so flash can not delay the alarm or the loop.
   nvsl_service() from a LOW-priority task on core 0 (about 1 Hz): writes what changed (set, commit, read back, compare). A failure logs nvs_fault and the next call
                  retries, so the caller's period is the log rate. Nothing is written while the values are unchanged (design 11.2 note 3: no periodic writes).
   Records are 3 bytes {NVSL_MAGIC, v, ~v}. A latch record that is present but unreadable or invalid fails safe as latched (MAN_DOWN); a missing key is unlatched.
   SCBA ON is restored after brown-out, watchdog and software reset, not after power-on; an unreadable SCBA record means OFF. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "frame.h"
#define NVSL_MAGIC 0xA7u
#define NVSL_BOOT_TRIES 3u        /* synchronous attempts to commit boot_ctr at boot (ADR 0004) */
#define NVSL_REBOOT_HINT_MS 30000u /* status2 bit 3, "first 30 s" (ADR 0004) */
#define NVSL_RESTORED_MS 60000u    /* status3 bit 4, "set for 60 s after an unclean reset" (ADR 0004) */
enum { NVSL_IO_OK = 0, NVSL_IO_NOT_FOUND = 1, NVSL_IO_ERR = 2 };
typedef enum { NVSL_FAULT_NONE = 0, NVSL_FAULT_LATCH_CORRUPT, NVSL_FAULT_LATCH_READ, NVSL_FAULT_SCBA_BAD, NVSL_FAULT_BOOT_CTR_BAD,
               NVSL_FAULT_WRITE, NVSL_FAULT_COMMIT, NVSL_FAULT_READBACK } nvsl_fault_t;
typedef struct {
  void *ctx;
  int (*get)(void *ctx, const char *key, uint8_t *buf, size_t cap, size_t *len);  /* NVSL_IO_* */
  int (*set)(void *ctx, const char *key, const uint8_t *buf, size_t len);         /* 0 = staged */
  int (*commit)(void *ctx);                                                       /* 0 = durable */
  uint32_t (*random)(void *ctx);
  void (*log)(void *ctx, const char *event, int fault);                           /* event is "nvs_fault"; a firmware log, not a host event */
} nvsl_backend_t;
typedef struct { uint8_t latch_cause, scba_on, boot_ctr, reset_cause, latch_restored; } nvsl_boot_t;  /* latch_cause: MD_EV_BOOT arg; scba_on: SB_EV_BOOT arg bit 0 */
typedef struct { nvsl_backend_t be; uint8_t latch_want, latch_stored, scba_want, scba_stored, boot_ctr, reset_cause, restored_latch; uint32_t boot_ms, faults; } nvsl_t;

void nvsl_init(nvsl_t *n, const nvsl_backend_t *be);
nvsl_boot_t nvsl_boot(nvsl_t *n, uint8_t reset_cause, uint32_t now_ms);  /* reset_cause is an ABI_RESET_CAUSE_* value */
void nvsl_observe(nvsl_t *n, uint8_t latch_cause, uint8_t scba_on);
uint32_t nvsl_service(nvsl_t *n);                                        /* returns the number of records made durable by this call */
uint32_t nvsl_faults(const nvsl_t *n);
uint8_t nvsl_boot_ctr(const nvsl_t *n);
uint8_t nvsl_status2_reboot(const nvsl_t *n, uint32_t now_ms);           /* status2 bit 3 mask, or 0 */
uint8_t nvsl_status3_restored(const nvsl_t *n, uint32_t now_ms);         /* status3 bit 4 and the cause in bits 5 to 6, or 0; not for a power-on reset */
uint8_t nvsl_status4_latch_restored(const nvsl_t *n);                    /* status4 bit 1 mask: from a restored latch until it is cleared */
void nvsl_apply_boot_fields(const nvsl_t *n, uint32_t now_ms, frame_fields_t *f);  /* the first frame after a boot: seq 0, boot_ctr, the status bits above ORed in */
