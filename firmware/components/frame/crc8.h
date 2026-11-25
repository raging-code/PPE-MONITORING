/* CRC-8, polynomial ABI_CRC8_POLY (0x07), initial value ABI_CRC8_INIT (0), MSB first, no reflection, no final XOR. */
#pragma once
#include <stddef.h>
#include <stdint.h>
uint8_t crc8(const uint8_t *data, size_t len);
