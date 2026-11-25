/* Frame and beacon codec for the node and base firmware (design 14.4, Rev 3.45). Pure C: no ESP-IDF, no I/O, no clock.
   Layout comes from the generated abi.h; the key and sys_id are passed in. Byte order is little-endian.
   Check order for a frame: length, CRC-8, MAC, then node id (0 is REJECT_ROSTER). Fields of a frame that failed a check
   are decoded for logging only; they are not authenticated and must never drive a rule. */
#pragma once
#include <stddef.h>
#include <stdint.h>
typedef enum { FRAME_OK = 0, FRAME_BAD_LEN, FRAME_BAD_CRC, FRAME_BAD_MAC, FRAME_REJECT_ROSTER, FRAME_IGNORE_ABI } frame_result_t;

typedef struct {
  uint16_t seq, co_x10;
  int16_t temp_x100;                       /* signed: C x 100, may be negative (F-24) */
  uint8_t hum, hr, motion_x100, bat, status2, flags, id_mode;
  uint16_t uptime_s;
  uint8_t status3, status4, boot_ctr;
} frame_fields_t;

typedef struct { uint8_t sys_id, base_id, beacon_seq, abi_ver, heard_mask, ack1, ack2, ack3; } beacon_fields_t;

uint8_t frame_node_id(const frame_fields_t *f);      /* id_mode bits 0 to 2 */
uint8_t frame_scba_on(const frame_fields_t *f);      /* id_mode bit 3 */
uint8_t frame_link_ok(const frame_fields_t *f);      /* id_mode bit 6 */
uint8_t frame_evt_unsent(const frame_fields_t *f);   /* id_mode bit 7 */

/* Writes ABI_FRAME_BYTES bytes: fields, CRC-8 over bytes 0-17, then the first 4 bytes of CMAC(key, sys_id || bytes 0-17). */
void frame_pack(uint8_t out[], const frame_fields_t *f, const uint8_t key[16], uint8_t sys_id);
/* Decodes every payload field without verifying anything. len must be ABI_FRAME_BYTES, otherwise returns 0 and writes nothing. */
int frame_decode(const uint8_t *data, size_t len, frame_fields_t *out);
/* Verify and classify. out and node_id may be NULL. For FRAME_BAD_LEN nothing is written; otherwise the claimed fields are. */
frame_result_t frame_classify(const uint8_t *data, size_t len, const uint8_t key[16], uint8_t sys_id, frame_fields_t *out, uint8_t *node_id);

/* Beacon: CRC-8 over bytes 0-7, MAC = first 4 bytes of CMAC(key, bytes 0-7) (no sys_id prefix). FRAME_IGNORE_ABI when valid but abi_ver differs. */
void beacon_pack(uint8_t out[], const beacon_fields_t *b, const uint8_t key[16]);
frame_result_t beacon_classify(const uint8_t *data, size_t len, const uint8_t key[16], beacon_fields_t *out);
