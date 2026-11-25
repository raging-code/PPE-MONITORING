/* AES-128 block encryption (FIPS 197). Portable C, no ESP-IDF includes. Encrypt only: CMAC needs nothing else. */
#pragma once
#include <stdint.h>
typedef struct { uint8_t rk[176]; } aes128_ctx_t;
void aes128_init(aes128_ctx_t *c, const uint8_t key[16]);
void aes128_encrypt(const aes128_ctx_t *c, const uint8_t in[16], uint8_t out[16]);
