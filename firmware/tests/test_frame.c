/* Requirements: REQ-FW-001 */
/* P14 gcc test runner: firmware/components/frame against shared/vectors/frames.json (through the generated frame_vectors.h)
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
