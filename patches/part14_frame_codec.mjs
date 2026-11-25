// patches/part14_frame_codec.mjs  (run from repo root: node patches/part14_frame_codec.mjs [--dry] [--force])
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
  put('firmware/components/frame/aes128.h', String.raw`/* AES-128 block encryption (FIPS 197). Portable C, no ESP-IDF includes. Encrypt only: CMAC needs nothing else. */
#pragma once
#include <stdint.h>
typedef struct { uint8_t rk[176]; } aes128_ctx_t;
void aes128_init(aes128_ctx_t *c, const uint8_t key[16]);
void aes128_encrypt(const aes128_ctx_t *c, const uint8_t in[16], uint8_t out[16]);
`);
  put('firmware/components/frame/aes128.c', String.raw`/* AES-128 encryption, FIPS 197. Table S-box, byte-wise MixColumns: small and slow, which is fine at one frame per 2 s. */
#include "aes128.h"
static const uint8_t SBOX[256] = {
  
0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
};
static uint8_t xt(uint8_t x) { return (uint8_t)((x << 1) ^ ((x & 0x80) ? 0x1B : 0)); }
void aes128_init(aes128_ctx_t *c, const uint8_t key[16]) {
  uint8_t rcon = 1;
  for (int i = 0; i < 16; i++) c->rk[i] = key[i];
  for (int i = 16; i < 176; i += 4) {
    uint8_t t[4] = { c->rk[i - 4], c->rk[i - 3], c->rk[i - 2], c->rk[i - 1] };
    if (i % 16 == 0) {
      uint8_t t0 = t[0];
      t[0] = (uint8_t)(SBOX[t[1]] ^ rcon); t[1] = SBOX[t[2]]; t[2] = SBOX[t[3]]; t[3] = SBOX[t0];
      rcon = xt(rcon);
    }
    for (int j = 0; j < 4; j++) c->rk[i + j] = (uint8_t)(c->rk[i - 16 + j] ^ t[j]);
  }
}
static void add_key(uint8_t s[16], const uint8_t *k) { for (int i = 0; i < 16; i++) s[i] ^= k[i]; }
void aes128_encrypt(const aes128_ctx_t *c, const uint8_t in[16], uint8_t out[16]) {
  uint8_t s[16], t[16];
  for (int i = 0; i < 16; i++) s[i] = in[i];
  add_key(s, c->rk);
  for (int round = 1; round <= 10; round++) {
    for (int i = 0; i < 16; i++) t[i] = SBOX[s[i]];
    /* ShiftRows: state is column-major, byte index = 4 * column + row */
    for (int col = 0; col < 4; col++) for (int row = 0; row < 4; row++) s[4 * col + row] = t[4 * ((col + row) & 3) + row];
    if (round < 10) {
      for (int col = 0; col < 4; col++) {
        uint8_t *p = s + 4 * col, a0 = p[0], a1 = p[1], a2 = p[2], a3 = p[3], all = (uint8_t)(a0 ^ a1 ^ a2 ^ a3);
        p[0] = (uint8_t)(a0 ^ all ^ xt((uint8_t)(a0 ^ a1)));
        p[1] = (uint8_t)(a1 ^ all ^ xt((uint8_t)(a1 ^ a2)));
        p[2] = (uint8_t)(a2 ^ all ^ xt((uint8_t)(a2 ^ a3)));
        p[3] = (uint8_t)(a3 ^ all ^ xt((uint8_t)(a3 ^ a0)));
      }
    }
    add_key(s, c->rk + 16 * round);
  }
  for (int i = 0; i < 16; i++) out[i] = s[i];
}
`);
  put('firmware/components/frame/cmac.h', String.raw`/* AES-128-CMAC (RFC 4493). Portable C, no ESP-IDF includes. */
#pragma once
#include <stddef.h>
#include <stdint.h>
/* Full 16-byte tag over prefix || msg. prefix may be NULL with prefix_len 0 (frames use sys_id as a 1-byte prefix, beacons none). */
void cmac_aes128(const uint8_t key[16], const uint8_t *prefix, size_t prefix_len, const uint8_t *msg, size_t msg_len, uint8_t tag[16]);
`);
  put('firmware/components/frame/cmac.c', String.raw`/* AES-128-CMAC, RFC 4493. The message is prefix || msg, read through a small accessor so no joined copy is needed. */
#include <string.h>
#include "aes128.h"
#include "cmac.h"
static void dbl(const uint8_t in[16], uint8_t out[16]) {
  uint8_t carry = (uint8_t)(in[0] >> 7);
  for (int i = 0; i < 15; i++) out[i] = (uint8_t)((in[i] << 1) | (in[i + 1] >> 7));
  out[15] = (uint8_t)((in[15] << 1) ^ (carry ? 0x87 : 0));
}
static uint8_t at(const uint8_t *prefix, size_t plen, const uint8_t *msg, size_t i) { return i < plen ? prefix[i] : msg[i - plen]; }
void cmac_aes128(const uint8_t key[16], const uint8_t *prefix, size_t prefix_len, const uint8_t *msg, size_t msg_len, uint8_t tag[16]) {
  aes128_ctx_t c; uint8_t l[16] = {0}, k1[16], k2[16], x[16] = {0}, y[16], last[16];
  size_t n = prefix_len + msg_len, blocks = (n + 15) / 16;
  aes128_init(&c, key);
  aes128_encrypt(&c, l, l); dbl(l, k1); dbl(k1, k2);
  int complete = (n != 0) && (n % 16 == 0);
  if (blocks == 0) blocks = 1;
  for (size_t b = 0; b + 1 < blocks; b++) {
    for (int i = 0; i < 16; i++) y[i] = (uint8_t)(x[i] ^ at(prefix, prefix_len, msg, b * 16 + (size_t)i));
    aes128_encrypt(&c, y, x);
  }
  size_t off = (blocks - 1) * 16, rem = n - off;
  memset(last, 0, 16);
  for (size_t i = 0; i < rem; i++) last[i] = at(prefix, prefix_len, msg, off + i);
  if (complete) for (int i = 0; i < 16; i++) last[i] ^= k1[i];
  else { last[rem] = 0x80; for (int i = 0; i < 16; i++) last[i] ^= k2[i]; }
  for (int i = 0; i < 16; i++) y[i] = (uint8_t)(x[i] ^ last[i]);
  aes128_encrypt(&c, y, tag);
}
`);
  put('firmware/components/frame/crc8.h', String.raw`/* CRC-8, polynomial ABI_CRC8_POLY (0x07), initial value ABI_CRC8_INIT (0), MSB first, no reflection, no final XOR. */
#pragma once
#include <stddef.h>
#include <stdint.h>
uint8_t crc8(const uint8_t *data, size_t len);
`);
  put('firmware/components/frame/crc8.c', String.raw`#include "abi.h"
#include "crc8.h"
uint8_t crc8(const uint8_t *data, size_t len) {
  uint8_t c = ABI_CRC8_INIT;
  for (size_t i = 0; i < len; i++) {
    c ^= data[i];
    for (int b = 0; b < 8; b++) c = (uint8_t)((c & 0x80) ? ((c << 1) ^ ABI_CRC8_POLY) : (c << 1));
  }
  return c;
}
`);
  put('firmware/components/frame/frame.h', String.raw`/* Frame and beacon codec for the node and base firmware (design 14.4, Rev 3.45). Pure C: no ESP-IDF, no I/O, no clock.
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
`);
  put('firmware/components/frame/frame.c', String.raw`#include <string.h>
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
`);
  put('tools/gen_frame_vectors.py', String.raw`#!/usr/bin/env python3
"""tools/gen_frame_vectors.py: writes firmware/tests/frame_vectors.h from shared/vectors/frames.json (design 12.1, 14.4).
The C test runner includes that header, so it needs no JSON parser. Run: python tools/gen_frame_vectors.py. Never edit the output by hand."""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, OUT = 'shared/vectors/frames.json', 'firmware/tests/frame_vectors.h'
FIELDS = ('seq', 'co_x10', 'temp_x100', 'hum', 'hr', 'motion_x100', 'bat', 'status2', 'flags', 'id_mode', 'uptime_s', 'status3', 'status4', 'boot_ctr')
def arr(h): return '{' + ', '.join('0x%02x' % b for b in bytes.fromhex(h)) + '}' if h else '{0}'
def render(d):
    o = ['/* GENERATED by tools/gen_frame_vectors.py from shared/vectors/frames.json. Do not edit. */', '#pragma once', '#include "frame.h"',
         'typedef struct { const char *id; uint8_t bytes[32]; size_t len; frame_result_t result; int node_id; int has_decoded; frame_fields_t dec; } frame_vec_t;',
         'typedef struct { const char *id; uint8_t bytes[32]; size_t len; frame_result_t result; int abi_ver; } beacon_vec_t;',
         f'#define VEC_SYS_ID {d["sys_id"]}', 'static const uint8_t VEC_KEY[16] = ' + arr(d['key_hex']) + ';', 'static const frame_vec_t FRAME_VECS[] = {']
    for f in d['frames']:
        e = f['expect']; dec = e['decoded']
        fl = ', '.join(f'.{k} = {dec[k]}' for k in FIELDS) if dec else '0'
        o.append(f'  {{ "{f["id"]}", {arr(f["hex"])}, {len(f["hex"]) // 2}, FRAME_{e["result"]}, {-1 if e["node_id"] is None else e["node_id"]}, {1 if dec else 0}, {{ {fl} }} }},')
    o += ['};', 'static const beacon_vec_t BEACON_VECS[] = {']
    for b in d['beacons']:
        e = b['expect']; o.append(f'  {{ "{b["id"]}", {arr(b["hex"])}, {len(b["hex"]) // 2}, FRAME_{e["result"]}, {e["abi_ver"]} }},')
    o += ['};', '#define N_FRAME_VECS (sizeof FRAME_VECS / sizeof FRAME_VECS[0])', '#define N_BEACON_VECS (sizeof BEACON_VECS / sizeof BEACON_VECS[0])', '']
    return '\n'.join(o)
if __name__ == '__main__':
    with open(os.path.join(ROOT, SRC), encoding='utf8') as f: d = json.load(f)
    with open(os.path.join(ROOT, OUT), 'w', encoding='utf8', newline='\n') as f: f.write(render(d))
    print(f'wrote {OUT}: {len(d["frames"])} frames, {len(d["beacons"])} beacons')
`);
  put('tools/run_gcc_tests.py', String.raw`#!/usr/bin/env python3
"""tools/run_gcc_tests.py: builds and runs the firmware unit tests with gcc (no ESP-IDF). Run: python tools/run_gcc_tests.py (exit 1 on a build or test failure).
Needs gcc on PATH. Run python tools/gen_frame_vectors.py first (just gen does it)."""
import os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME = ['aes128', 'cmac', 'crc8', 'frame']
TESTS = {'test_frame': FRAME}
def main():
    out = os.path.join(ROOT, 'firmware', 'tests', 'build'); os.makedirs(out, exist_ok=True)
    for name, parts in TESTS.items():
        exe = os.path.join(out, name + ('.exe' if os.name == 'nt' else ''))
        cmd = ['gcc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', 'firmware/components/abi', '-I', 'firmware/components/frame', '-I', 'firmware/tests',
               *[f'firmware/components/frame/{p}.c' for p in parts], f'firmware/tests/{name}.c', '-o', exe]
        if subprocess.run(cmd, cwd=ROOT).returncode: return 1
        if subprocess.run([exe], cwd=ROOT).returncode: return 1
    return 0
if __name__ == '__main__': sys.exit(main())
`);
  put('firmware/tests/test_frame.c', String.raw`/* P14 gcc test runner: firmware/components/frame against shared/vectors/frames.json (through the generated frame_vectors.h)
   plus published AES and CMAC test vectors, so the cipher is checked against the standard and not only against our own files. */
#include <stdio.h>
#include <string.h>
#include "abi.h"
#include "aes128.h"
#include "cmac.h"
#include "crc8.h"
#include "frame.h"
#include "frame_vectors.h"
static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FAIL: "); printf(__VA_ARGS__); printf("\n"); } } while (0)
static const char *NAMES[] = { "OK", "BAD_LEN", "BAD_CRC", "BAD_MAC", "REJECT_ROSTER", "IGNORE_ABI" };

static void test_standards(void) {
  /* FIPS 197 appendix C.1 and RFC 4493 section 4 (key 2b7e1516 28aed2a6 abf71588 09cf4f3c) */
  static const uint8_t k0[16] = {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15}, p0[16] = {0,0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff};
  static const uint8_t c0[16] = {0x69,0xc4,0xe0,0xd8,0x6a,0x7b,0x04,0x30,0xd8,0xcd,0xb7,0x80,0x70,0xb4,0xc5,0x5a};
  static const uint8_t k[16] = {0x2b,0x7e,0x15,0x16,0x28,0xae,0xd2,0xa6,0xab,0xf7,0x15,0x88,0x09,0xcf,0x4f,0x3c};
  static const uint8_t m[64] = {0x6b,0xc1,0xbe,0xe2,0x2e,0x40,0x9f,0x96,0xe9,0x3d,0x7e,0x11,0x73,0x93,0x17,0x2a,0xae,0x2d,0x8a,0x57,0x1e,0x03,0xac,0x9c,0x9e,0xb7,0x6f,0xac,0x45,0xaf,0x8e,0x51,
    0x30,0xc8,0x1c,0x46,0xa3,0x5c,0xe4,0x11,0xe5,0xfb,0xc1,0x19,0x1a,0x0a,0x52,0xef,0xf6,0x9f,0x24,0x45,0xdf,0x4f,0x9b,0x17,0xad,0x2b,0x41,0x7b,0xe6,0x6c,0x37,0x10};
  static const struct { size_t n; uint8_t t[16]; } T[] = {
    {0,  {0xbb,0x1d,0x69,0x29,0xe9,0x59,0x37,0x28,0x7f,0xa3,0x7d,0x12,0x9b,0x75,0x67,0x46}},
    {16, {0x07,0x0a,0x16,0xb4,0x6b,0x4d,0x41,0x44,0xf7,0x9b,0xdd,0x9d,0xd0,0x4a,0x28,0x7c}},
    {40, {0xdf,0xa6,0x67,0x47,0xde,0x9a,0xe6,0x30,0x30,0xca,0x32,0x61,0x14,0x97,0xc8,0x27}},
    {64, {0x51,0xf0,0xbe,0xbf,0x7e,0x3b,0x9d,0x92,0xfc,0x49,0x74,0x17,0x79,0x36,0x3c,0xfe}} };
  aes128_ctx_t c; uint8_t out[16];
  aes128_init(&c, k0); aes128_encrypt(&c, p0, out); CHECK(!memcmp(out, c0, 16), "AES-128 FIPS 197 C.1");
  for (size_t i = 0; i < sizeof T / sizeof T[0]; i++) { cmac_aes128(k, NULL, 0, m, T[i].n, out); CHECK(!memcmp(out, T[i].t, 16), "CMAC RFC 4493, %zu bytes", T[i].n); }
  cmac_aes128(k, m, 5, m + 5, 35, out); CHECK(!memcmp(out, T[2].t, 16), "CMAC prefix split gives the same tag as one buffer");
  CHECK(crc8((const uint8_t *)"123456789", 9) == 0xF4, "CRC-8 poly 0x07 check value of \"123456789\"");
}
/* Field by field: a struct memcmp would also compare padding bytes. */
static int same_fields(const frame_fields_t *a, const frame_fields_t *b) {
  return a->seq == b->seq && a->co_x10 == b->co_x10 && a->temp_x100 == b->temp_x100 && a->hum == b->hum && a->hr == b->hr && a->motion_x100 == b->motion_x100 &&
         a->bat == b->bat && a->status2 == b->status2 && a->flags == b->flags && a->id_mode == b->id_mode && a->uptime_s == b->uptime_s &&
         a->status3 == b->status3 && a->status4 == b->status4 && a->boot_ctr == b->boot_ctr;
}
static void test_frames(void) {
  for (size_t i = 0; i < N_FRAME_VECS; i++) {
    const frame_vec_t *v = &FRAME_VECS[i]; frame_fields_t f; uint8_t node = 99;
    memset(&f, 0, sizeof f);
    frame_result_t r = frame_classify(v->bytes, v->len, VEC_KEY, VEC_SYS_ID, &f, &node);
    CHECK(r == v->result, "%s: result %s, expected %s", v->id, NAMES[r], NAMES[v->result]);
    if (v->result == FRAME_BAD_LEN) continue;
    CHECK(node == v->node_id, "%s: node %d, expected %d", v->id, node, v->node_id);
    CHECK(v->has_decoded && same_fields(&f, &v->dec), "%s: decoded fields differ (temp %d, expected %d)", v->id, f.temp_x100, v->dec.temp_x100);
    CHECK(frame_scba_on(&f) == ((v->dec.id_mode >> 3) & 1) && frame_link_ok(&f) == ((v->dec.id_mode >> 6) & 1) && frame_evt_unsent(&f) == ((v->dec.id_mode >> 7) & 1), "%s: id_mode bits", v->id);
    if (i < 15) {  /* F-01 to F-15: the packer must rebuild the frame byte for byte */
      uint8_t b[ABI_FRAME_BYTES]; frame_pack(b, &v->dec, VEC_KEY, VEC_SYS_ID);
      CHECK(!memcmp(b, v->bytes, ABI_FRAME_BYTES), "%s: packer output differs from the vector", v->id);
    }
  }
  CHECK(FRAME_VECS[23].dec.temp_x100 == -500, "F-24 decodes as -500 (int16_t)");
}
static void test_lengths(void) {
  const uint8_t *good = FRAME_VECS[0].bytes; static const size_t bad[] = {0, 1, 17, 18, 19, 20, 22, 24, 32}; frame_fields_t f;
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    CHECK(frame_classify(good, bad[i], VEC_KEY, VEC_SYS_ID, NULL, NULL) == FRAME_BAD_LEN, "frame of %zu bytes is BAD_LEN", bad[i]);
    CHECK(!frame_decode(good, bad[i], &f), "frame_decode refuses %zu bytes", bad[i]);
  }
  const uint8_t *bc = BEACON_VECS[0].bytes; static const size_t bb[] = {0, 8, 12, 14, 23};
  for (size_t i = 0; i < sizeof bb / sizeof bb[0]; i++) CHECK(beacon_classify(bc, bb[i], VEC_KEY, NULL) == FRAME_BAD_LEN, "beacon of %zu bytes is BAD_LEN", bb[i]);
}
static void test_beacons(void) {
  for (size_t i = 0; i < N_BEACON_VECS; i++) {
    const beacon_vec_t *v = &BEACON_VECS[i]; beacon_fields_t b; frame_result_t r = beacon_classify(v->bytes, v->len, VEC_KEY, &b);
    CHECK(r == v->result, "%s: result %s, expected %s", v->id, NAMES[r], NAMES[v->result]);
    CHECK(b.abi_ver == v->abi_ver, "%s: abi_ver %d, expected %d", v->id, b.abi_ver, v->abi_ver);
  }
  uint8_t out[ABI_BEACON_BYTES]; beacon_fields_t b;
  beacon_classify(BEACON_VECS[0].bytes, ABI_BEACON_BYTES, VEC_KEY, &b); beacon_pack(out, &b, VEC_KEY);
  CHECK(!memcmp(out, BEACON_VECS[0].bytes, ABI_BEACON_BYTES), "B-01: beacon_pack rebuilds the vector");
}
int main(void) {
  test_standards(); test_frames(); test_lengths(); test_beacons();
  printf("test_frame: %zu frames, %zu beacons, %d checks, %s\n", (size_t)N_FRAME_VECS, (size_t)N_BEACON_VECS, checks, fails ? "FAILED" : "all pass");
  return fails ? 1 : 0;
}
`);
  put('firmware/tests/frame_vectors.h', String.raw`/* GENERATED by tools/gen_frame_vectors.py from shared/vectors/frames.json. Do not edit. */
#pragma once
#include "frame.h"
typedef struct { const char *id; uint8_t bytes[32]; size_t len; frame_result_t result; int node_id; int has_decoded; frame_fields_t dec; } frame_vec_t;
typedef struct { const char *id; uint8_t bytes[32]; size_t len; frame_result_t result; int abi_ver; } beacon_vec_t;
#define VEC_SYS_ID 90
static const uint8_t VEC_KEY[16] = {0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f};
static const frame_vec_t FRAME_VECS[] = {
  { "F-01", {0x64, 0x00, 0x08, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x72, 0xb6, 0xc8, 0x08, 0xe7}, 23, FRAME_OK, 1, 1, { .seq = 100, .co_x10 = 520, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 1, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-02", {0x65, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x01, 0x50, 0x00, 0x06, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x5e, 0xc5, 0xc3, 0xeb, 0x55}, 23, FRAME_OK, 1, 1, { .seq = 101, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 1, .bat = 80, .status2 = 0, .flags = 6, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-03", {0x66, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x06, 0x41, 0x64, 0x00, 0x00, 0x10, 0x07, 0x1f, 0x1c, 0x22, 0x28, 0x46}, 23, FRAME_OK, 1, 1, { .seq = 102, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 6, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 16, .boot_ctr = 7 } },
  { "F-04", {0x67, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x81, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xfb, 0xfe, 0xbc, 0xcd, 0x84}, 23, FRAME_OK, 1, 1, { .seq = 103, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 129, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-05", {0x68, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x0a, 0x04, 0x00, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xcf, 0xe5, 0x7c, 0xb8, 0xfa}, 23, FRAME_OK, 1, 1, { .seq = 104, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 10, .status2 = 4, .flags = 0, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-06", {0x69, 0x00, 0x08, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x10, 0x08, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xa5, 0x77, 0x42, 0xc0, 0x8f}, 23, FRAME_OK, 1, 1, { .seq = 105, .co_x10 = 520, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 16, .flags = 8, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-07", {0x6a, 0x00, 0xc4, 0x09, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x02, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x4b, 0x61, 0xeb, 0x55, 0x98}, 23, FRAME_OK, 1, 1, { .seq = 106, .co_x10 = 2500, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 2, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-08", {0xff, 0xff, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x00, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xdd, 0xf0, 0xe0, 0x05, 0x31}, 23, FRAME_OK, 1, 1, { .seq = 65535, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 0, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-09", {0x00, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x00, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x95, 0x3a, 0xb9, 0xcc, 0xb5}, 23, FRAME_OK, 1, 1, { .seq = 0, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 0, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-10", {0x00, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x08, 0x00, 0x41, 0x64, 0x00, 0x00, 0x00, 0x08, 0x20, 0xf3, 0x9b, 0x31, 0x9e}, 23, FRAME_OK, 1, 1, { .seq = 0, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 8, .flags = 0, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 8 } },
  { "F-11", {0x6e, 0x00, 0x90, 0x01, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x9e, 0xab, 0x94, 0x77, 0x89}, 23, FRAME_OK, 1, 1, { .seq = 110, .co_x10 = 400, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 1, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-12", {0x78, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x10, 0x0a, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xe5, 0xda, 0xfe, 0x5d, 0xdf}, 23, FRAME_OK, 1, 1, { .seq = 120, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 16, .flags = 10, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-13", {0x82, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x40, 0x09, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x43, 0xa8, 0x95, 0xd4, 0x68}, 23, FRAME_OK, 1, 1, { .seq = 130, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 64, .flags = 9, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-14", {0x8c, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x02, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xb8, 0x1e, 0xf7, 0x93, 0x47}, 23, FRAME_OK, 1, 1, { .seq = 140, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 2, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-15", {0x96, 0x00, 0xc8, 0x00, 0xe0, 0x15, 0x32, 0x00, 0x00, 0x50, 0x00, 0x00, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xcf, 0x6b, 0x0f, 0x9c, 0x83}, 23, FRAME_OK, 1, 1, { .seq = 150, .co_x10 = 200, .temp_x100 = 5600, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 0, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-16", {0xc8, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x06, 0x42, 0x64, 0x00, 0x00, 0x00, 0x07, 0xa8, 0x13, 0x18, 0x68, 0x1c}, 23, FRAME_BAD_MAC, 2, 1, { .seq = 200, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 6, .id_mode = 66, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-17", {0x64, 0x00, 0x09, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x72, 0xb6, 0xc8, 0x08, 0xe7}, 23, FRAME_BAD_CRC, 1, 1, { .seq = 100, .co_x10 = 521, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 1, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-18", {0x64, 0x00, 0x08, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x72, 0x90, 0x94, 0x8d, 0x68}, 23, FRAME_BAD_MAC, 1, 1, { .seq = 100, .co_x10 = 520, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 1, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-19", {0x64, 0x00, 0x08, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x72, 0xb6, 0x82, 0x5c, 0x05}, 23, FRAME_BAD_MAC, 1, 1, { .seq = 100, .co_x10 = 520, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 1, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-20", {0x64, 0x00, 0x00, 0x00, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x00, 0x40, 0x64, 0x00, 0x00, 0x00, 0x07, 0xf9, 0x2e, 0x40, 0x1e, 0xe7}, 23, FRAME_REJECT_ROSTER, 0, 1, { .seq = 100, .co_x10 = 0, .temp_x100 = 2500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 0, .id_mode = 64, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-21", {0x64, 0x00, 0x08, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x72, 0xb6, 0xc8, 0x08}, 22, FRAME_BAD_LEN, -1, 0, { 0 } },
  { "F-22", {0x64, 0x00, 0x08, 0x02, 0xc4, 0x09, 0x32, 0x00, 0x00, 0x50, 0x00, 0x01, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x72, 0xb6, 0xc8, 0x08, 0xe7, 0x00}, 24, FRAME_BAD_LEN, -1, 0, { 0 } },
  { "F-23", {0xa0, 0x00, 0xc4, 0x09, 0xe0, 0x15, 0x32, 0x00, 0x00, 0x50, 0x00, 0x02, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0x61, 0x4a, 0x58, 0x2d, 0x7e}, 23, FRAME_OK, 1, 1, { .seq = 160, .co_x10 = 2500, .temp_x100 = 5600, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 2, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
  { "F-24", {0xaa, 0x00, 0x00, 0x00, 0x0c, 0xfe, 0x32, 0x00, 0x00, 0x50, 0x00, 0x00, 0x41, 0x64, 0x00, 0x00, 0x00, 0x07, 0xc3, 0x76, 0x79, 0x68, 0xdb}, 23, FRAME_OK, 1, 1, { .seq = 170, .co_x10 = 0, .temp_x100 = -500, .hum = 50, .hr = 0, .motion_x100 = 0, .bat = 80, .status2 = 0, .flags = 0, .id_mode = 65, .uptime_s = 100, .status3 = 0, .status4 = 0, .boot_ctr = 7 } },
};
static const beacon_vec_t BEACON_VECS[] = {
  { "B-01", {0x5a, 0x01, 0x0a, 0x03, 0x02, 0x64, 0x00, 0x00, 0x73, 0xa2, 0x8d, 0xfc, 0x75}, 13, FRAME_OK, 3 },
  { "B-02", {0x5a, 0x01, 0x0b, 0x03, 0x02, 0x64, 0x00, 0x00, 0x73, 0xa2, 0x8d, 0xfc, 0x75}, 13, FRAME_BAD_CRC, 3 },
  { "B-03", {0x5a, 0x01, 0x0a, 0x03, 0x02, 0x64, 0x00, 0x00, 0x73, 0x9a, 0xf0, 0x6e, 0x2e}, 13, FRAME_BAD_MAC, 3 },
  { "B-04", {0x5a, 0x01, 0x0a, 0x02, 0x02, 0x64, 0x00, 0x00, 0x11, 0x56, 0xab, 0x85, 0x0b}, 13, FRAME_IGNORE_ABI, 2 },
};
#define N_FRAME_VECS (sizeof FRAME_VECS / sizeof FRAME_VECS[0])
#define N_BEACON_VECS (sizeof BEACON_VECS / sizeof BEACON_VECS[0])
`);
  replace('justfile', '# P2 and P3 add the generators here\ngen:\n    python tools/gen_abi.py\n    python tools/gen_constants.py\n', '# P14: firmware unit tests built with gcc (needs gcc on PATH; CI runs this too)\ntest-fw:\n    python tools/gen_frame_vectors.py\n    python tools/run_gcc_tests.py\n\n# P2, P3 and P14 add the generators here\ngen:\n    python tools/gen_abi.py\n    python tools/gen_constants.py\n    python tools/gen_frame_vectors.py\n');
  append('docs/PROGRESS.md', '- Part 14 done: firmware/components/frame (aes128, cmac RFC 4493, crc8, frame: pack, decode with int16_t temp, classify, beacon pack and classify; pure C, layout from abi.h, no ESP-IDF includes), tools/gen_frame_vectors.py (frames.json to firmware/tests/frame_vectors.h), tools/run_gcc_tests.py, firmware/tests/test_frame.c (F-01 to F-24, B-01 to B-04, packer rebuilds F-01 to F-15, length rejections, FIPS 197 and RFC 4493 vectors); run with just test-fw; the ESP-IDF CMakeLists is P17');
}
