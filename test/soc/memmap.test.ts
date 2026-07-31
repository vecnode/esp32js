import { describe, expect, it } from 'vitest';
import { MEMORY_MAP, PERIPHERAL_BASE, regionAt } from '../../src/soc/memmap.js';

// Every value here is transcribed directly from hw/xtensa/esp32_picsimlab.c
// (esp32_memmap[]) and include/hw/misc/esp32_reg.h (DR_REG_*_BASE) in the
// QEMU source at the root of this repo - this test is the accuracy check
// against that reference, not just internal self-consistency.

describe('MEMORY_MAP matches hw/xtensa/esp32_picsimlab.c:esp32_memmap[]', () => {
  it.each([
    ['drom', 0x3ff90000, 0x10000],
    ['irom', 0x40000000, 0x70000],
    ['dram', 0x3ffae000, 0x52000],
    ['iram', 0x40080000, 0x40000],
    ['icache0', 0x40070000, 0x8000],
    ['icache1', 0x40078000, 0x8000],
    ['rtcSlow', 0x50000000, 0x2000],
    ['rtcFastInstr', 0x400c0000, 0x2000],
    ['rtcFastData', 0x3ff80000, 0x2000],
  ] as const)('%s = { base: 0x%s, size: 0x%s }', (name, base, size) => {
    expect(MEMORY_MAP[name]).toEqual({ base, size });
  });

  it('does not carry the PICSimLab-only framebuffer region', () => {
    expect(Object.keys(MEMORY_MAP)).not.toContain('framebuf');
  });

  it('locates an address within its containing region', () => {
    expect(regionAt(0x3ffae100)).toBe('dram');
    expect(regionAt(0x40000010)).toBe('irom');
  });

  it('returns undefined for an unmapped address', () => {
    expect(regionAt(0x12345678)).toBeUndefined();
  });
});

describe('PERIPHERAL_BASE matches include/hw/misc/esp32_reg.h', () => {
  it.each([
    ['dport', 0x3ff00000],
    ['aes', 0x3ff01000],
    ['rsa', 0x3ff02000],
    ['sha', 0x3ff03000],
    ['uart0', 0x3ff40000],
    ['spi1', 0x3ff42000],
    ['spi0', 0x3ff43000],
    ['gpio', 0x3ff44000],
    ['rtcCntl', 0x3ff48000],
    ['sens', 0x3ff48800],
    ['ioMux', 0x3ff49000],
    ['i2s0', 0x3ff4f000],
    ['uart1', 0x3ff50000],
    ['i2c0', 0x3ff53000],
    ['rmt', 0x3ff56000],
    ['ledc', 0x3ff59000],
    ['efuse', 0x3ff5a000],
    ['timg0', 0x3ff5f000],
    ['timg1', 0x3ff60000],
    ['spi2', 0x3ff64000],
    ['spi3', 0x3ff65000],
    ['i2c1', 0x3ff67000],
    ['sdmmc', 0x3ff68000],
    ['uart2', 0x3ff6e000],
  ] as const)('%s = 0x%s', (name, base) => {
    expect(PERIPHERAL_BASE[name]).toBe(base);
  });
});
