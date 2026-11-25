#include <string.h>
#include "abi.h"
#include "cmac.h"
#include "crc8.h"
#include "frame.h"
#define MAC_BYTES 4
static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v & 0xFF); p[1] = (uint8_t)(v >> 8); }
static uint8_t bits(uint8_t v, unsigned mask, unsigned shift) { return (uint8_t)((v & mask) >> shift); }

uint8_t frame_node_id(const frame_fields_t *f) { return bits(f->id_mode, ABI_ID_MODE_NODE_ID_MASK, ABI_ID_MODE_NODE_ID_SHIFT); }
uint8_t frame_scba_on(const frame_fields_t *f) { return bits(f->id_mode, ABI_ID_MODE_SCBA_ON_MASK, ABI_ID_MODE_SCBA_ON_SHIFT); }
uint8_t frame_link_ok(const frame_fields_t *f) { return bits(f->id_mode, ABI_ID_MODE_LINK_OK_MASK, ABI_ID_MODE_LINK_OK_SHIFT); }
uint8_t frame_evt_unsent(const frame_fields_t *f) { return bits(f->id_mode, ABI_ID_MODE_EVT_UNSENT_MASK, ABI_ID_MODE_EVT_UNSENT_SHIFT); }

/* Equal-time comparison: a MAC check must not leak where the first differing byte is. */
static int same(const uint8_t *a, const uint8_t *b, size_t n) { uint8_t d = 0; for (size_t i = 0; i < n; i++) d |= (uint8_t)(a[i] ^ b[i]); return d == 0; }

static void mac4(const uint8_t key[16], const uint8_t *prefix, size_t plen, const uint8_t *body, size_t blen, uint8_t out[MAC_BYTES]) {
  uint8_t tag[16]; cmac_aes128(key, prefix, plen, body, blen, tag); memcpy(out, tag, MAC_BYTES);
}

void frame_pack(uint8_t out[], const frame_fields_t *f, const uint8_t key[16], uint8_t sys_id) {
  wr16(out + ABI_FRAME_SEQ_OFF, f->seq); wr16(out + ABI_FRAME_CO_X10_OFF, f->co_x10); wr16(out + ABI_FRAME_TEMP_X100_OFF, (uint16_t)f->temp_x100);
  out[ABI_FRAME_HUM_OFF] = f->hum; out[ABI_FRAME_HR_OFF] = f->hr; out[ABI_FRAME_MOTION_X100_OFF] = f->motion_x100; out[ABI_FRAME_BAT_OFF] = f->bat;
  out[ABI_FRAME_STATUS2_OFF] = f->status2; out[ABI_FRAME_FLAGS_OFF] = f->flags; out[ABI_FRAME_ID_MODE_OFF] = f->id_mode;
  wr16(out + ABI_FRAME_UPTIME_S_OFF, f->uptime_s);
  out[ABI_FRAME_STATUS3_OFF] = f->status3; out[ABI_FRAME_STATUS4_OFF] = f->status4; out[ABI_FRAME_BOOT_CTR_OFF] = f->boot_ctr;
  out[ABI_FRAME_CRC8_OFF] = crc8(out, ABI_FRAME_CRC8_OFF);
  mac4(key, &sys_id, 1, out, ABI_FRAME_CRC8_OFF, out + ABI_FRAME_MAC4_OFF);
}

int frame_decode(const uint8_t *d, size_t len, frame_fields_t *o) {
  if (len != ABI_FRAME_BYTES) return 0;
  o->seq = rd16(d + ABI_FRAME_SEQ_OFF); o->co_x10 = rd16(d + ABI_FRAME_CO_X10_OFF);
  o->temp_x100 = (int16_t)rd16(d + ABI_FRAME_TEMP_X100_OFF);   /* signed (design 14.4, F-24) */
  o->hum = d[ABI_FRAME_HUM_OFF]; o->hr = d[ABI_FRAME_HR_OFF]; o->motion_x100 = d[ABI_FRAME_MOTION_X100_OFF]; o->bat = d[ABI_FRAME_BAT_OFF];
  o->status2 = d[ABI_FRAME_STATUS2_OFF]; o->flags = d[ABI_FRAME_FLAGS_OFF]; o->id_mode = d[ABI_FRAME_ID_MODE_OFF];
  o->uptime_s = rd16(d + ABI_FRAME_UPTIME_S_OFF);
  o->status3 = d[ABI_FRAME_STATUS3_OFF]; o->status4 = d[ABI_FRAME_STATUS4_OFF]; o->boot_ctr = d[ABI_FRAME_BOOT_CTR_OFF];
  return 1;
}

frame_result_t frame_classify(const uint8_t *d, size_t len, const uint8_t key[16], uint8_t sys_id, frame_fields_t *out, uint8_t *node_id) {
  frame_fields_t f; uint8_t m[MAC_BYTES], node; frame_result_t r = FRAME_OK;
  if (!frame_decode(d, len, &f)) return FRAME_BAD_LEN;
  node = frame_node_id(&f);
  mac4(key, &sys_id, 1, d, ABI_FRAME_CRC8_OFF, m);
  if (crc8(d, ABI_FRAME_CRC8_OFF) != d[ABI_FRAME_CRC8_OFF]) r = FRAME_BAD_CRC;
  else if (!same(m, d + ABI_FRAME_MAC4_OFF, MAC_BYTES)) r = FRAME_BAD_MAC;
  else if (node == 0) r = FRAME_REJECT_ROSTER;
  if (out) *out = f;
  if (node_id) *node_id = node;
  return r;
}

void beacon_pack(uint8_t out[], const beacon_fields_t *b, const uint8_t key[16]) {
  out[ABI_BEACON_SYS_ID_OFF] = b->sys_id; out[ABI_BEACON_BASE_ID_OFF] = b->base_id; out[ABI_BEACON_BEACON_SEQ_OFF] = b->beacon_seq;
  out[ABI_BEACON_ABI_VER_OFF] = b->abi_ver; out[ABI_BEACON_HEARD_MASK_OFF] = b->heard_mask;
  out[ABI_BEACON_ACK1_OFF] = b->ack1; out[ABI_BEACON_ACK2_OFF] = b->ack2; out[ABI_BEACON_ACK3_OFF] = b->ack3;
  out[ABI_BEACON_CRC8_OFF] = crc8(out, ABI_BEACON_CRC8_OFF);
  mac4(key, NULL, 0, out, ABI_BEACON_CRC8_OFF, out + ABI_BEACON_MAC4_OFF);
}

frame_result_t beacon_classify(const uint8_t *d, size_t len, const uint8_t key[16], beacon_fields_t *out) {
  uint8_t m[MAC_BYTES]; frame_result_t r = FRAME_OK; beacon_fields_t b;
  if (len != ABI_BEACON_BYTES) return FRAME_BAD_LEN;
  b.sys_id = d[ABI_BEACON_SYS_ID_OFF]; b.base_id = d[ABI_BEACON_BASE_ID_OFF]; b.beacon_seq = d[ABI_BEACON_BEACON_SEQ_OFF];
  b.abi_ver = d[ABI_BEACON_ABI_VER_OFF]; b.heard_mask = d[ABI_BEACON_HEARD_MASK_OFF];
  b.ack1 = d[ABI_BEACON_ACK1_OFF]; b.ack2 = d[ABI_BEACON_ACK2_OFF]; b.ack3 = d[ABI_BEACON_ACK3_OFF];
  mac4(key, NULL, 0, d, ABI_BEACON_CRC8_OFF, m);
  if (crc8(d, ABI_BEACON_CRC8_OFF) != d[ABI_BEACON_CRC8_OFF]) r = FRAME_BAD_CRC;
  else if (!same(m, d + ABI_BEACON_MAC4_OFF, MAC_BYTES)) r = FRAME_BAD_MAC;
  else if (b.abi_ver != ABI_BEACON_ABI_VER) r = FRAME_IGNORE_ABI;
  if (out) *out = b;
  return r;
}
