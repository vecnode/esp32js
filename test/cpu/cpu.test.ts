import { describe, expect, it } from 'vitest';
import { Cpu, type Bus } from '../../src/cpu/cpu.js';
import { RegisterFile } from '../../src/cpu/registers.js';

/** Flat byte-addressable RAM for CPU-level tests - not a real memory map. */
class TestBus implements Bus {
  private readonly mem = new Uint8Array(0x1000);

  readByte(addr: number): number {
    return this.mem[addr]!;
  }

  read32(addr: number): number {
    return (this.mem[addr]! | (this.mem[addr + 1]! << 8) | (this.mem[addr + 2]! << 16) | (this.mem[addr + 3]! << 24)) >>> 0;
  }

  write32(addr: number, value: number): void {
    this.mem[addr] = value & 0xff;
    this.mem[addr + 1] = (value >>> 8) & 0xff;
    this.mem[addr + 2] = (value >>> 16) & 0xff;
    this.mem[addr + 3] = (value >>> 24) & 0xff;
  }

  writeInsn(addr: number, word: number): void {
    this.mem[addr] = word & 0xff;
    this.mem[addr + 1] = (word >>> 8) & 0xff;
    this.mem[addr + 2] = (word >>> 16) & 0xff;
  }

  /** For density (16-bit) instructions, packed 2 bytes apart - writeInsn's 3-byte write would clobber the next one. */
  writeInsn16(addr: number, word: number): void {
    this.mem[addr] = word & 0xff;
    this.mem[addr + 1] = (word >>> 8) & 0xff;
  }
}

const ADD = (dest: number, s1: number, s2: number) => (0x8 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
const SUB = (dest: number, s1: number, s2: number) => (0xc << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
const RET = 0x000080;
const MOVI = (dest: number, imm: number) => {
  const raw12 = imm & 0xfff;
  const s = (raw12 >> 8) & 0xf;
  const imm8 = raw12 & 0xff;
  return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
};
const L32I = (dest: number, base: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x2 << 12) | (base << 8) | (dest << 4) | 0x2;
const S32I = (src: number, base: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x6 << 12) | (base << 8) | (src << 4) | 0x2;
const L32R = (dest: number, negOffset: number) => {
  const imm16 = (negOffset >> 2) & 0xffff;
  return (imm16 << 8) | (dest << 4) | 0x1;
};
const L32E = (dest: number, base: number, negByteOffset: number) => (((negByteOffset >> 2) & 0xf) << 12) | (base << 8) | (dest << 4) | (0x9 << 16);
const S32E = (src: number, base: number, negByteOffset: number) => (((negByteOffset >> 2) & 0xf) << 12) | (base << 8) | (src << 4) | (0x9 << 16) | (0x4 << 20);
const J = (offset: number) => (((offset & 0x3ffff) << 6) | 0x6) >>> 0;
const CALL0 = (offset: number) => ((((offset / 4) & 0x3ffff) << 6) | 0x5) >>> 0;
const CALLN = (n: 1 | 2 | 3, offset: number) => ((((offset / 4) & 0x3ffff) << 6) | (n << 4) | 0x5) >>> 0;
const ENTRY = (s: number, byteImm: number) => (((byteImm >> 3) & 0xfff) << 12) | (s << 8) | (0x3 << 4) | 0x6;
const RETW = 0x000090;
const RFWO = 0x003400;
const RFWU = 0x003500;
const branch = (r: number, a: number, b: number, offset: number) => ((offset & 0xff) << 16) | (r << 12) | (a << 8) | (b << 4) | 0x7;
const BEQ = (a: number, b: number, offset: number) => branch(0x1, a, b, offset);
const BLT = (a: number, b: number, offset: number) => branch(0x2, a, b, offset);

// Density (16-bit) encoders.
const ADD_N = (dest: number, s1: number, s2: number) => (dest << 12) | (s1 << 8) | (s2 << 4) | 0xa;
const ADDI_N = (dest: number, src: number, rawT: number) => (dest << 12) | (src << 8) | (rawT << 4) | 0xb;
const MOVI_N = (dest: number, raw7: number) => (((raw7 & 0xf) << 12) | (dest << 8) | (((raw7 >> 4) & 0x7) << 4) | 0xc) >>> 0;
const BEQZ_N = (a: number, raw6: number) => (((raw6 & 0xf) << 12) | (a << 8) | (((raw6 >> 4) & 0x3) << 4) | (1 << 7) | 0xc) >>> 0;
const BNEZ_N = (a: number, raw6: number) => (BEQZ_N(a, raw6) | (1 << 6)) >>> 0;
const MOV_N = (dest: number, src: number) => (src << 8) | (dest << 4) | 0xd;
const RET_N = (0xf << 12) | (0 << 4) | 0xd;
const NOP_N = (0xf << 12) | (0 << 8) | (3 << 4) | 0xd;
const L32I_N = (dest: number, base: number, byteOffset: number) => (((byteOffset >> 2) << 12) | (base << 8) | (dest << 4) | 0x8) >>> 0;

function makeCpu(): { cpu: Cpu; bus: TestBus } {
  const bus = new TestBus();
  const cpu = new Cpu(new RegisterFile(), bus, 0);
  return { cpu, bus };
}

describe('Cpu fetch/execute', () => {
  it('runs MOVI + ADD and advances pc by 3 bytes per instruction', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(2, 5));
    bus.writeInsn(3, MOVI(3, 7));
    bus.writeInsn(6, ADD(4, 2, 3));

    cpu.step();
    expect(cpu.regs.get(2)).toBe(5);
    expect(cpu.pc).toBe(3);
    expect(cpu.lastException).toBeNull();

    cpu.step();
    expect(cpu.regs.get(3)).toBe(7);
    expect(cpu.pc).toBe(6);

    cpu.step();
    expect(cpu.regs.get(4)).toBe(12);
    expect(cpu.pc).toBe(9);
  });

  it('runs SUB and wraps to an unsigned 32-bit result', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(2, 1));
    bus.writeInsn(3, MOVI(3, 2));
    bus.writeInsn(6, SUB(4, 2, 3)); // 1 - 2 -> wraps

    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.regs.get(4)).toBe(0xffffffff);
  });

  it('round-trips a value through S32I/L32I', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(2, 0x200)); // base address
    bus.writeInsn(3, MOVI(3, 0x2a)); // value = 42
    bus.writeInsn(6, S32I(3, 2, 8)); // mem[0x208] = 42
    bus.writeInsn(9, L32I(4, 2, 8)); // a4 = mem[0x208]

    for (let i = 0; i < 4; i++) cpu.step();
    expect(cpu.regs.get(4)).toBe(42);
  });

  it('round-trips a value through S32E/L32E (negative-only offsets)', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(2, 0x200));
    bus.writeInsn(3, MOVI(3, 0x2a));
    bus.writeInsn(6, S32E(3, 2, -16)); // mem[0x200-16] = 42
    bus.writeInsn(9, L32E(4, 2, -16));

    for (let i = 0; i < 4; i++) cpu.step();
    expect(cpu.regs.get(4)).toBe(42);
  });

  it('loads a literal via L32R using the (pc+3)&~3 base', () => {
    // L32R can only reference literals *before* it (offset is always
    // negative), matching real ESP-IDF codegen where the literal pool
    // precedes the function. Literal at 0x10, L32R instruction at 0x100.
    const { cpu, bus } = makeCpu();
    const pcAddr = 0x100;
    const literalAddr = 0x10;
    bus.write32(literalAddr, 0xcafebabe);
    const base = (pcAddr + 3) & ~0x3;
    const offset = literalAddr - base;
    expect(offset).toBeLessThan(0);
    bus.writeInsn(pcAddr, L32R(5, offset));
    cpu.pc = pcAddr;

    cpu.step();
    expect(cpu.regs.get(5)).toBe(0xcafebabe);
  });

  it('takes an unconditional J and updates pc to pc+4+offset', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, J(20));
    cpu.step();
    expect(cpu.pc).toBe(0 + 4 + 20);
  });

  it('BEQ branches when equal and falls through when not', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(1, 9));
    bus.writeInsn(3, MOVI(2, 9));
    bus.writeInsn(6, BEQ(1, 2, 40));

    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.pc).toBe(6 + 4 + 40);
  });

  it('BLT falls through (does not branch) when the condition is false', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(1, 9));
    bus.writeInsn(3, MOVI(2, 3));
    bus.writeInsn(6, BLT(1, 2, 40)); // 9 < 3 is false

    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.pc).toBe(9); // straight-line fallthrough, 3-byte instruction
  });

  it('BLT compares registers as signed 32-bit values', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, MOVI(1, -1)); // a1 = 0xffffffff, but signed -1
    bus.writeInsn(3, MOVI(2, 1));
    bus.writeInsn(6, BLT(1, 2, 40)); // -1 < 1 is true

    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.pc).toBe(6 + 4 + 40);
  });

  it('CALL0 sets a0 to pc+3 and jumps; RET returns to that address', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, CALL0(12)); // pc=0 -> a0=3, target=(0&~3)+4+12=16
    bus.writeInsn(16, RET);

    cpu.step(); // CALL0
    expect(cpu.regs.get(0)).toBe(3);
    expect(cpu.pc).toBe(16);

    cpu.step(); // RET
    expect(cpu.pc).toBe(3);
  });

  it('runs a full CALL4/ENTRY/RETW windowed call and preserves the caller frame', () => {
    const { cpu, bus } = makeCpu();
    // Caller: set up a stack pointer, then CALL4 into a function at pc=100.
    bus.writeInsn(0, MOVI(1, 0x300)); // a1 (caller's sp) = 0x300
    bus.writeInsn(3, CALLN(1, 96)); // target = (3&~3)+4+96 = 100

    // Callee: ENTRY reserves a 16-byte frame, then does something in its
    // own window before returning.
    bus.writeInsn(100, ENTRY(1, 16)); // new a1 = old a1 - 16 = 0x2f0
    bus.writeInsn(103, MOVI(2, 99)); // writes the *new* window's a2
    bus.writeInsn(106, RETW);

    cpu.step(); // MOVI a1
    expect(cpu.regs.get(1)).toBe(0x300);

    cpu.step(); // CALL4
    expect(cpu.pc).toBe(100);
    expect(cpu.regs.get(4)).toBe(((1 << 30) | 6) >>> 0); // callinc=1, return addr = pc(3)+3

    cpu.step(); // ENTRY
    expect(cpu.lastException).toBeNull(); // no overflow at this shallow depth
    expect(cpu.regs.getWindowBase()).toBe(1);
    expect(cpu.regs.get(1)).toBe(0x2f0); // new window's a1

    cpu.step(); // MOVI a2, 99 (new window)
    expect(cpu.regs.get(2)).toBe(99);

    cpu.step(); // RETW
    expect(cpu.pc).toBe(6); // back to the CALL4 instruction's pc+3
    expect(cpu.regs.getWindowBase()).toBe(0);
    expect(cpu.regs.get(1)).toBe(0x300); // caller's a1 untouched by the callee
  });

  it('vectors ENTRY without a preceding CALLN to the kernel exception vector', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, ENTRY(1, 16));
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'illegal' });
    expect(cpu.pc).toBe(cpu.vecbase + 0x300);
    expect(cpu.epc1).toBe(0);
    expect(cpu.excm).toBe(true);
  });

  it('vectors RETW with a0=0 (n=0, no windowed call ever made) to the kernel exception vector', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, RETW);
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'illegal' });
    expect(cpu.pc).toBe(cpu.vecbase + 0x300);
  });

  it('escalates a second illegal instruction under PS.EXCM to a double exception', () => {
    const { cpu, bus } = makeCpu();
    cpu.vecbase = 0x400; // keep vectors within TestBus's small backing array
    bus.writeInsn(0, 0xdead0f); // illegal
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'illegal' });
    expect(cpu.pc).toBe(cpu.vecbase + 0x300);
    bus.writeInsn(cpu.vecbase + 0x300, 0xdead0f);
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'double' });
    expect(cpu.pc).toBe(cpu.vecbase + 0x3c0);
  });

  it('detects window overflow on ENTRY, vectors by size, and completes on retry after RFWO', () => {
    const { cpu, bus } = makeCpu();
    cpu.vecbase = 0x400; // keep vectors within TestBus's small backing array
    // Window 1 is already live (simulating an earlier, unrelated call chain
    // several frames deep that we didn't bother constructing by hand), with
    // no other frame nearby - the sparse case, which conservatively resolves
    // to the largest (12-register) overflow handler since there's no closer
    // boundary to determine a smaller size from (over-spilling is safe,
    // under-spilling corrupts data).
    cpu.regs.setWindowStart(0b0010);
    bus.writeInsn(0, CALLN(1, 96)); // callinc=1 (CALL4), target = 100
    bus.writeInsn(100, ENTRY(1, 16));

    cpu.step(); // CALL4
    expect(cpu.pc).toBe(100);

    cpu.step(); // ENTRY: window 1 collides -> overflow, size 12
    expect(cpu.lastException).toEqual({ kind: 'window-overflow', size: 12 });
    expect(cpu.pc).toBe(cpu.vecbase + 0x100);
    expect(cpu.regs.getWindowBase()).toBe(1); // rotated onto the colliding frame
    expect(cpu.owb).toBe(0);
    expect(cpu.epc1).toBe(100); // ENTRY's own address, so it gets retried

    // A minimal synthetic handler: this repo doesn't claim to replicate the
    // real ROM's spill routine (that's an ABI/firmware convention, not
    // something defined in this QEMU fork's source) - RFWO alone is enough
    // to prove the hardware-level retry mechanism itself.
    bus.writeInsn(cpu.vecbase + 0x100, RFWO);
    cpu.step(); // RFWO
    expect(cpu.lastException).toBeNull();
    expect(cpu.pc).toBe(100); // back to EPC1, retrying ENTRY
    expect(cpu.regs.getWindowBase()).toBe(0); // restored to OWB
    expect(cpu.excm).toBe(false);

    cpu.step(); // ENTRY retried: window 1's live bit was cleared by RFWO -> no overflow now
    expect(cpu.lastException).toBeNull();
    expect(cpu.pc).toBe(103);
    expect(cpu.regs.getWindowBase()).toBe(1);
  });

  it('detects window underflow on RETW, vectors by size, and completes on retry after RFWU', () => {
    const { cpu, bus } = makeCpu();
    cpu.vecbase = 0x400; // keep vectors within TestBus's small backing array
    // Craft a0 as if a CALL4 (callinc=1) had happened, returning to address
    // 12, with the target frame not resident (WINDOWSTART's default state
    // only marks window 0 live).
    cpu.regs.set(0, ((1 << 30) | 12) >>> 0);
    bus.writeInsn(0, RETW);
    bus.writeInsn(12, MOVI(3, 77)); // proves the return actually completes

    cpu.step(); // RETW: frame not resident -> underflow, size 4 (n=1)
    expect(cpu.lastException).toEqual({ kind: 'window-underflow', size: 4 });
    expect(cpu.pc).toBe(cpu.vecbase + 0x040);
    expect(cpu.regs.getWindowBase()).toBe(15); // rotated back before dispatching
    expect(cpu.owb).toBe(0);
    expect(cpu.epc1).toBe(0); // RETW's own address, so it gets retried

    bus.writeInsn(cpu.vecbase + 0x040, RFWU);
    cpu.step(); // RFWU
    expect(cpu.lastException).toBeNull();
    expect(cpu.pc).toBe(0); // back to EPC1, retrying RETW
    expect(cpu.regs.getWindowBase()).toBe(0); // restored to OWB
    expect(cpu.excm).toBe(false);

    cpu.step(); // RETW retried: frame now marked live by RFWU -> returns for real
    expect(cpu.lastException).toBeNull();
    expect(cpu.pc).toBe(12);
    expect(cpu.regs.getWindowBase()).toBe(15);

    cpu.step(); // proves execution actually continues at the return address
    expect(cpu.regs.get(3)).toBe(77);
  });

  it('reports an unrecognized opcode as illegal without crashing', () => {
    const { cpu, bus } = makeCpu();
    bus.writeInsn(0, 0xdead0f);
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'illegal' });
  });

  describe('density (16-bit) instructions', () => {
    it('advances pc by 2 (not 3) for a density instruction, and mixes with 24-bit ones', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, MOVI_N(2, 5)); // a2 = 5, 2 bytes
      bus.writeInsn16(2, ADD_N(4, 2, 2)); // a4 = a2 + a2, 2 bytes
      bus.writeInsn(4, ADD(5, 4, 4)); // a5 = a4 + a4, back to a 3-byte instruction

      cpu.step();
      expect(cpu.pc).toBe(2);
      expect(cpu.regs.get(2)).toBe(5);

      cpu.step();
      expect(cpu.pc).toBe(4);
      expect(cpu.regs.get(4)).toBe(10);

      cpu.step();
      expect(cpu.pc).toBe(7);
      expect(cpu.regs.get(5)).toBe(20);
    });

    it('decodes and runs MOVI.N with the asymmetric negative range', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, MOVI_N(3, 0x60)); // raw7=0x60 -> -32
      cpu.step();
      expect(cpu.regs.get(3)).toBe((-32) >>> 0);
    });

    it('runs ADDI.N, including the raw-0 -> -1 special case', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, MOVI_N(1, 10));
      bus.writeInsn16(2, ADDI_N(2, 1, 3)); // a2 = a1 + 3
      bus.writeInsn16(4, ADDI_N(3, 1, 0)); // a3 = a1 + (-1)

      cpu.step();
      cpu.step();
      cpu.step();
      expect(cpu.regs.get(2)).toBe(13);
      expect(cpu.regs.get(3)).toBe(9);
    });

    it('runs MOV.N as a plain register copy', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, MOVI_N(5, 21));
      bus.writeInsn16(2, MOV_N(6, 5));

      cpu.step();
      cpu.step();
      expect(cpu.regs.get(6)).toBe(21);
    });

    it('runs NOP.N: no register change, pc advances by 2', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, NOP_N);
      cpu.step();
      expect(cpu.pc).toBe(2);
      expect(cpu.lastException).toBeNull();
    });

    it('BEQZ.N branches to pc+4+offset when the register is zero', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, BEQZ_N(2, 20)); // a2 defaults to 0

      cpu.step();
      expect(cpu.pc).toBe(0 + 4 + 20);
    });

    it('BEQZ.N falls through when the register is not zero', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, MOVI_N(2, 1));
      bus.writeInsn16(2, BEQZ_N(2, 20));

      cpu.step();
      cpu.step();
      expect(cpu.pc).toBe(4); // straight-line fallthrough, 2-byte instruction
    });

    it('BNEZ.N branches when the register is not zero', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn16(0, MOVI_N(2, 1));
      bus.writeInsn16(2, BNEZ_N(2, 20));

      cpu.step();
      cpu.step();
      expect(cpu.pc).toBe(2 + 4 + 20);
    });

    it('round-trips a value through S32I.N/L32I.N', () => {
      const { cpu, bus } = makeCpu();
      const S32I_N = (src: number, base: number, byteOffset: number) => (((byteOffset >> 2) << 12) | (base << 8) | (src << 4) | 0x9) >>> 0;
      bus.writeInsn16(0, MOVI_N(2, 0x40)); // base = 64
      bus.writeInsn16(2, MOVI_N(3, 42));
      bus.writeInsn16(4, S32I_N(3, 2, 8));
      bus.writeInsn16(6, L32I_N(4, 2, 8));

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(4)).toBe(42);
    });

    it('reuses RET for RET.N (op0=13,r=15,t=0)', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, CALL0(12)); // a0 = 3, pc -> 16
      bus.writeInsn16(16, RET_N);

      cpu.step(); // CALL0
      cpu.step(); // RET.N
      expect(cpu.pc).toBe(3);
    });
  });
});
