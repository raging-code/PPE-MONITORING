/* AES-128-CMAC, RFC 4493. The message is prefix || msg, read through a small accessor so no joined copy is needed. */
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
