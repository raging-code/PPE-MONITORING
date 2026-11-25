/* AES-128-CMAC (RFC 4493). Portable C, no ESP-IDF includes. */
#pragma once
#include <stddef.h>
#include <stdint.h>
/* Full 16-byte tag over prefix || msg. prefix may be NULL with prefix_len 0 (frames use sys_id as a 1-byte prefix, beacons none). */
void cmac_aes128(const uint8_t key[16], const uint8_t *prefix, size_t prefix_len, const uint8_t *msg, size_t msg_len, uint8_t tag[16]);
