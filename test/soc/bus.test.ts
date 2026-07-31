import { describe, expect, it } from 'vitest';
import { Cpu } from '../../src/cpu/cpu.js';
import { RegisterFile } from '../../src/cpu/registers.js';
import { SystemBus } from '../../src/soc/bus.js';
import { MEMORY_MAP, type MemoryRegionName } from '../../src/soc/memmap.js';

const regionNames = Object.keys(MEMORY_MAP) as MemoryRegionName[];

describe('SystemBus', () => {
  it.each(regionNames)('round-trips a 32-bit value at the base of %s', (name) => {
    const bus = new SystemBus();
    const base = MEMORY_MAP[name].base;
    bus.write32(base, 0xdeadbeef);
    expect(bus.read32(base)).toBe(0xdeadbeef);
  });

  it.each(regionNames)('round-trips a 32-bit value near the end of %s', (name) => {
    const bus = new SystemBus();
    const { base, size } = MEMORY_MAP[name];
    const addr = base + size - 4;
    bus.write32(addr, 0x12345678);
    expect(bus.read32(addr)).toBe(0x12345678);
  });

  it('keeps regions isolated - a write to one does not leak into an adjacent one', () => {
    const bus = new SystemBus();
    bus.write32(MEMORY_MAP.iram.base, 0xffffffff);
    expect(bus.read32(MEMORY_MAP.dram.base)).toBe(0);
    expect(bus.read32(MEMORY_MAP.drom.base)).toBe(0);
  });

  it('reads unmapped addresses as 0 and ignores writes to them, without throwing', () => {
    const bus = new SystemBus();
    const unmapped = 0x12345678; // not inside any MEMORY_MAP region
    expect(regionNames.every((name) => {
      const { base, size } = MEMORY_MAP[name];
      return unmapped < base || unmapped >= base + size;
    })).toBe(true);

    expect(bus.readByte(unmapped)).toBe(0);
    expect(bus.read32(unmapped)).toBe(0);
    expect(() => bus.write32(unmapped, 0xffffffff)).not.toThrow();
    expect(bus.read32(unmapped)).toBe(0);
  });

  it('loadBytes preloads a region, readable via readByte and read32', () => {
    const bus = new SystemBus();
    bus.loadBytes('irom', 0x10, new Uint8Array([0x02, 0x20, 0xa0, 0x02])); // MOVI a2,2 then start of next insn
    expect(bus.readByte(MEMORY_MAP.irom.base + 0x10)).toBe(0x02);
    expect(bus.readByte(MEMORY_MAP.irom.base + 0x12)).toBe(0xa0);
  });

  it('runs a tiny program loaded into IRAM via the real CPU/Bus pairing', () => {
    // Unlike test/cpu/cpu.test.ts's flat TestBus, this exercises the CPU
    // against genuine SoC addresses (IRAM's real base/size from memmap.ts).
    const bus = new SystemBus();
    const base = MEMORY_MAP.iram.base;
    const MOVI = (dest: number, imm: number) => {
      const raw12 = imm & 0xfff;
      const s = (raw12 >> 8) & 0xf;
      const imm8 = raw12 & 0xff;
      return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
    };
    const ADD = (dest: number, s1: number, s2: number) => (0x8 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
    const writeInsn = (addr: number, word: number) => {
      // Exactly 3 bytes - instructions are packed 3 bytes apart, so a 4-byte
      // write32 here would clobber the next instruction's first byte.
      bus.writeByte(addr, word & 0xff);
      bus.writeByte(addr + 1, (word >>> 8) & 0xff);
      bus.writeByte(addr + 2, (word >>> 16) & 0xff);
    };

    writeInsn(base, MOVI(2, 5));
    writeInsn(base + 3, MOVI(3, 7));
    writeInsn(base + 6, ADD(4, 2, 3));

    const cpu = new Cpu(new RegisterFile(), bus, base);
    cpu.step();
    cpu.step();
    cpu.step();

    expect(cpu.regs.get(4)).toBe(12);
    expect(cpu.pc).toBe(base + 9);
  });
});
