#include "abi.h"
#include "crc8.h"
uint8_t crc8(const uint8_t *data, size_t len) {
  uint8_t c = ABI_CRC8_INIT;
  for (size_t i = 0; i < len; i++) {
    c ^= data[i];
    for (int b = 0; b < 8; b++) c = (uint8_t)((c & 0x80) ? ((c << 1) ^ ABI_CRC8_POLY) : (c << 1));
  }
  return c;
}
