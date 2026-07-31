/**
 * ESP32 SoC address map.
 *
 * Ported from hw/xtensa/esp32_picsimlab.c:73-84 (esp32_memmap[]) and
 * include/hw/misc/esp32_reg.h (DR_REG_*_BASE) in this repo's QEMU source,
 * which are used here only as a reference for real silicon addresses.
 *
 * Deliberately excludes ESP32_MEMREGION_FRAMEBUF (0x20000000): that's a
 * PICSimLab-only virtual RGB display wired onto the SoC as a fake
 * peripheral, not present on any real ESP32 board.
 */

export interface MemRegion {
  readonly base: number;
  readonly size: number;
}

export const MEMORY_MAP = {
  drom: { base: 0x3ff90000, size: 0x10000 },
  irom: { base: 0x40000000, size: 0x70000 },
  dram: { base: 0x3ffae000, size: 0x52000 },
  iram: { base: 0x40080000, size: 0x40000 },
  icache0: { base: 0x40070000, size: 0x8000 },
  icache1: { base: 0x40078000, size: 0x8000 },
  rtcSlow: { base: 0x50000000, size: 0x2000 },
  rtcFastInstr: { base: 0x400c0000, size: 0x2000 },
  rtcFastData: { base: 0x3ff80000, size: 0x2000 },
} as const satisfies Record<string, MemRegion>;

/** Peripheral register block base addresses, from DR_REG_*_BASE. */
export const PERIPHERAL_BASE = {
  dport: 0x3ff00000,
  aes: 0x3ff01000,
  rsa: 0x3ff02000,
  sha: 0x3ff03000,
  uart0: 0x3ff40000,
  spi1: 0x3ff42000,
  spi0: 0x3ff43000,
  gpio: 0x3ff44000,
  rtcCntl: 0x3ff48000,
  sens: 0x3ff48800,
  ioMux: 0x3ff49000,
  i2s0: 0x3ff4f000,
  uart1: 0x3ff50000,
  i2c0: 0x3ff53000,
  rmt: 0x3ff56000,
  ledc: 0x3ff59000,
  efuse: 0x3ff5a000,
  timg0: 0x3ff5f000,
  timg1: 0x3ff60000,
  spi2: 0x3ff64000,
  spi3: 0x3ff65000,
  i2c1: 0x3ff67000,
  sdmmc: 0x3ff68000,
  uart2: 0x3ff6e000,
} as const satisfies Record<string, number>;

export type MemoryRegionName = keyof typeof MEMORY_MAP;
export type PeripheralName = keyof typeof PERIPHERAL_BASE;

/** Returns the memory region containing `address`, or undefined if unmapped. */
export function regionAt(address: number): MemoryRegionName | undefined {
  for (const name of Object.keys(MEMORY_MAP) as MemoryRegionName[]) {
    const region = MEMORY_MAP[name];
    if (address >= region.base && address < region.base + region.size) {
      return name;
    }
  }
  return undefined;
}
