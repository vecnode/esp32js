/**
 * A real, byte-backed memory bus over the SoC address map in `memmap.ts`,
 * with UART0 and GPIO wired up as live peripherals.
 *
 * This is the first thing in the project backed by actual bytes rather than
 * a test double: `cpu/cpu.ts`'s `Bus` interface can now be satisfied by
 * addresses that genuinely correspond to DROM/IROM/DRAM/IRAM/etc., not just
 * a flat scratch array. `test/cpu/cpu.test.ts`'s `TestBus` remains useful
 * for CPU-only unit tests that don't care about the real address map; this
 * class is for anything that does (loading a firmware image, boot, and now
 * observing UART TX output or GPIO state).
 *
 * Peripheral dispatch (`peripherals/uart.ts`'s `Uart0`, `peripherals/
 * gpio.ts`'s `Gpio`) is checked before the plain-memory-region path in
 * `read32`/`write32`, which call a peripheral's `readWord`/`writeWord`
 * directly - important for registers with real side effects (UART_FIFO's
 * `onTx`, GPIO_OUT's read-back-what-you-drove loopback) that must fire
 * exactly once per 32-bit write, not once per byte. `readByte`/`writeByte`
 * also route to peripherals for consistency, but do so via a
 * read-word-patch-byte-write-word sequence, so a byte-at-a-time write would
 * (harmlessly, since real firmware never does this) re-trigger those side
 * effects up to three extra times with stale intermediate values - worth
 * being explicit about rather than silently correct only by accident.
 *
 * Deliberately out of scope here (see ARCHITECTURE.md's Phase 3/4 status):
 *   - Every other peripheral block in `PERIPHERAL_BASE` besides UART0/GPIO
 *     isn't backed at all - accessing them behaves like any other unmapped
 *     address.
 *   - No read-only enforcement on DROM/IROM (real flash-backed regions) -
 *     nothing stops a write from landing in "ROM" here.
 *   - Unmapped access doesn't raise LOAD_STORE_ERROR_CAUSE - it silently
 *     reads as 0 / writes as a no-op instead. Real hardware would fault,
 *     but `cpu/cpu.ts`'s `Bus` interface has no channel for a bus fault to
 *     signal back to the CPU yet (it would need an EXCVADDR-carrying path
 *     analogous to `HELPER(exception_cause_vaddr)` in `exc_helper.c`) -
 *     that's exception-machinery work, not memory-bus work, so it's flagged
 *     here rather than half-built.
 */

import type { Bus } from '../cpu/cpu.js';
import { Gpio, GPIO_WINDOW_SIZE } from '../peripherals/gpio.js';
import { Uart0, UART_WINDOW_SIZE } from '../peripherals/uart.js';
import { MEMORY_MAP, type MemoryRegionName, PERIPHERAL_BASE, regionAt } from './memmap.js';

interface PeripheralDevice {
  readWord(offset: number): number;
  writeWord(offset: number, value: number): void;
}

interface PeripheralSlot {
  base: number;
  size: number;
  device: PeripheralDevice;
}

export class SystemBus implements Bus {
  private readonly regions: Record<MemoryRegionName, Uint8Array>;
  private readonly peripherals: readonly PeripheralSlot[];
  readonly uart0 = new Uart0();
  readonly gpio = new Gpio();

  constructor() {
    const regions = {} as Record<MemoryRegionName, Uint8Array>;
    for (const name of Object.keys(MEMORY_MAP) as MemoryRegionName[]) {
      regions[name] = new Uint8Array(MEMORY_MAP[name].size);
    }
    this.regions = regions;
    this.peripherals = [
      { base: PERIPHERAL_BASE.uart0, size: UART_WINDOW_SIZE, device: this.uart0 },
      { base: PERIPHERAL_BASE.gpio, size: GPIO_WINDOW_SIZE, device: this.gpio },
    ];
  }

  /** Copy `data` into `region` starting at `offset` - for preloading a firmware image or test fixture. */
  loadBytes(region: MemoryRegionName, offset: number, data: Uint8Array): void {
    this.regions[region].set(data, offset);
  }

  private findPeripheral(addr: number): { device: PeripheralDevice; offset: number } | undefined {
    for (const slot of this.peripherals) {
      const offset = addr - slot.base;
      if (offset >= 0 && offset < slot.size) return { device: slot.device, offset };
    }
    return undefined;
  }

  readByte(addr: number): number {
    const hit = this.findPeripheral(addr);
    if (hit !== undefined) {
      const wordOffset = hit.offset & ~0x3;
      const byteIndex = hit.offset & 0x3;
      return (hit.device.readWord(wordOffset) >>> (byteIndex * 8)) & 0xff;
    }
    const name = regionAt(addr);
    if (name === undefined) return 0;
    return this.regions[name][(addr - MEMORY_MAP[name].base) >>> 0] ?? 0;
  }

  read32(addr: number): number {
    const hit = this.findPeripheral(addr);
    if (hit !== undefined) {
      return hit.device.readWord(hit.offset & ~0x3) >>> 0;
    }
    const b0 = this.readByte(addr);
    const b1 = this.readByte((addr + 1) >>> 0);
    const b2 = this.readByte((addr + 2) >>> 0);
    const b3 = this.readByte((addr + 3) >>> 0);
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  write32(addr: number, value: number): void {
    const hit = this.findPeripheral(addr);
    if (hit !== undefined) {
      hit.device.writeWord(hit.offset & ~0x3, value >>> 0);
      return;
    }
    this.writeByte(addr, value & 0xff);
    this.writeByte((addr + 1) >>> 0, (value >>> 8) & 0xff);
    this.writeByte((addr + 2) >>> 0, (value >>> 16) & 0xff);
    this.writeByte((addr + 3) >>> 0, (value >>> 24) & 0xff);
  }

  writeByte(addr: number, value: number): void {
    const hit = this.findPeripheral(addr);
    if (hit !== undefined) {
      const wordOffset = hit.offset & ~0x3;
      const byteIndex = hit.offset & 0x3;
      const shift = byteIndex * 8;
      const current = hit.device.readWord(wordOffset);
      const patched = (current & ~(0xff << shift)) | ((value & 0xff) << shift);
      hit.device.writeWord(wordOffset, patched >>> 0);
      return;
    }
    const name = regionAt(addr);
    if (name === undefined) return;
    this.regions[name][(addr - MEMORY_MAP[name].base) >>> 0] = value;
  }
}
