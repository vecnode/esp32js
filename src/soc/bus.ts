/**
 * A real, byte-backed memory bus over the SoC address map in `memmap.ts`.
 *
 * This is the first thing in the project backed by actual bytes rather than
 * a test double: `cpu/cpu.ts`'s `Bus` interface can now be satisfied by
 * addresses that genuinely correspond to DROM/IROM/DRAM/IRAM/etc., not just
 * a flat scratch array. `test/cpu/cpu.test.ts`'s `TestBus` remains useful
 * for CPU-only unit tests that don't care about the real address map; this
 * class is for anything that does (loading a firmware image, boot, and
 * eventually peripheral MMIO dispatch).
 *
 * Deliberately out of scope here (see ARCHITECTURE.md's Phase 3 status):
 *   - Peripheral register blocks (`PERIPHERAL_BASE`) aren't backed at all -
 *     accessing them behaves like any other unmapped address. Wiring them
 *     up is peripherals work (Phase 4), not memory-bus work.
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
import { MEMORY_MAP, type MemoryRegionName, regionAt } from './memmap.js';

export class SystemBus implements Bus {
  private readonly regions: Record<MemoryRegionName, Uint8Array>;

  constructor() {
    const regions = {} as Record<MemoryRegionName, Uint8Array>;
    for (const name of Object.keys(MEMORY_MAP) as MemoryRegionName[]) {
      regions[name] = new Uint8Array(MEMORY_MAP[name].size);
    }
    this.regions = regions;
  }

  /** Copy `data` into `region` starting at `offset` - for preloading a firmware image or test fixture. */
  loadBytes(region: MemoryRegionName, offset: number, data: Uint8Array): void {
    this.regions[region].set(data, offset);
  }

  readByte(addr: number): number {
    const name = regionAt(addr);
    if (name === undefined) return 0;
    return this.regions[name][(addr - MEMORY_MAP[name].base) >>> 0] ?? 0;
  }

  read32(addr: number): number {
    const b0 = this.readByte(addr);
    const b1 = this.readByte((addr + 1) >>> 0);
    const b2 = this.readByte((addr + 2) >>> 0);
    const b3 = this.readByte((addr + 3) >>> 0);
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  write32(addr: number, value: number): void {
    this.writeByte(addr, value & 0xff);
    this.writeByte((addr + 1) >>> 0, (value >>> 8) & 0xff);
    this.writeByte((addr + 2) >>> 0, (value >>> 16) & 0xff);
    this.writeByte((addr + 3) >>> 0, (value >>> 24) & 0xff);
  }

  writeByte(addr: number, value: number): void {
    const name = regionAt(addr);
    if (name === undefined) return;
    this.regions[name][(addr - MEMORY_MAP[name].base) >>> 0] = value;
  }
}
