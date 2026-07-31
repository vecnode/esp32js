import { describe, expect, it } from 'vitest';
import { Cpu, RESET_VECTOR, type Bus } from '../../src/cpu/cpu.js';
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
const AND = (dest: number, s1: number, s2: number) => (0x1 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
const OR = (dest: number, s1: number, s2: number) => (0x2 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
const XOR = (dest: number, s1: number, s2: number) => (0x3 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
const NEG = (dest: number, src: number) => (0x6 << 20) | (dest << 12) | (0 << 8) | (src << 4);
const ABS = (dest: number, src: number) => (0x6 << 20) | (dest << 12) | (1 << 8) | (src << 4);
const SSR = (src: number) => (0x4 << 20) | (0 << 12) | (src << 8);
const SSL = (src: number) => (0x4 << 20) | (1 << 12) | (src << 8);
const SSAI = (shift: number) => (0x4 << 20) | (4 << 12) | ((shift & 0xf) << 8) | (((shift >> 4) & 0x1) << 4);
const SLL = (dest: number, src: number) => (0xa << 20) | (0x1 << 16) | (dest << 12) | (src << 8);
const SRL = (dest: number, src: number) => (0x9 << 20) | (0x1 << 16) | (dest << 12) | (src << 4);
const SRA = (dest: number, src: number) => (0xb << 20) | (0x1 << 16) | (dest << 12) | (src << 4);
const SRC = (dest: number, s1: number, s2: number) => (0x8 << 20) | (0x1 << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const SLLI = (dest: number, src: number, shift: number) => {
  const salRaw = (0x20 - shift) & 0x1f;
  return (((salRaw >> 4) & 0x1) << 20) | (0x1 << 16) | (dest << 12) | (src << 8) | ((salRaw & 0xf) << 4);
};
const SRAI = (dest: number, src: number, shift: number) => (((shift >> 4) & 0x1) << 20) | (0x2 << 20) | (0x1 << 16) | (dest << 12) | ((shift & 0xf) << 8) | (src << 4);
const SRLI = (dest: number, src: number, shift: number) => (0x4 << 20) | (0x1 << 16) | (dest << 12) | ((shift & 0xf) << 8) | (src << 4);
const NSA = (dest: number, src: number) => (0x4 << 20) | (0xe << 12) | (src << 8) | (dest << 4);
const NSAU = (dest: number, src: number) => (0x4 << 20) | (0xf << 12) | (src << 8) | (dest << 4);
const MULL = (dest: number, s1: number, s2: number) => (0x8 << 20) | (0x2 << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const QUOU = (dest: number, s1: number, s2: number) => (0xc << 20) | (0x2 << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const QUOS = (dest: number, s1: number, s2: number) => (0xd << 20) | (0x2 << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const REMU = (dest: number, s1: number, s2: number) => (0xe << 20) | (0x2 << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const REMS = (dest: number, s1: number, s2: number) => (0xf << 20) | (0x2 << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const ADDI = (dest: number, src: number, imm: number) => ((imm & 0xff) << 16) | (0xc << 12) | (src << 8) | (dest << 4) | 0x2;
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
const RSIL = (dest: number, level: number) => (0x6 << 12) | ((level & 0xf) << 8) | (dest << 4);
const RFI = (level: number) => (0x3 << 12) | ((level & 0xf) << 8) | (1 << 4);
const RFE = 0x003000; // op0=0,op1=0,op2=0,r=3,s=0,t=0
const RSR = (sr: number, reg: number) => (0x3 << 16) | (((sr >> 4) & 0xf) << 12) | ((sr & 0xf) << 8) | (reg << 4);
const WSR = (sr: number, reg: number) => (0x1 << 20) | (0x3 << 16) | (((sr >> 4) & 0xf) << 12) | ((sr & 0xf) << 8) | (reg << 4);
const SR_PS = 230;
const SR_INTENABLE = 228;
const branch = (r: number, a: number, b: number, offset: number) => ((offset & 0xff) << 16) | (r << 12) | (a << 8) | (b << 4) | 0x7;
const BEQ = (a: number, b: number, offset: number) => branch(0x1, a, b, offset);
const BLT = (a: number, b: number, offset: number) => branch(0x2, a, b, offset);

// FPU (single-precision) encoders - op0=0, op1=0xa/0xb (see decode.ts).
const ADD_S = (dest: number, s1: number, s2: number) => (0xa << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const SUB_S = (dest: number, s1: number, s2: number) => (0x1a << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const MUL_S = (dest: number, s1: number, s2: number) => (0x2a << 16) | (dest << 12) | (s1 << 8) | (s2 << 4);
const MOV_S = (dest: number, src: number) => (0xfa << 16) | (dest << 12) | (src << 8);
const ABS_S = (dest: number, src: number) => (0xfa << 16) | (dest << 12) | (src << 8) | (1 << 4);
const NEG_S = (dest: number, src: number) => (0xfa << 16) | (dest << 12) | (src << 8) | (6 << 4);
const WFR = (frDest: number, arSrc: number) => (0xfa << 16) | (frDest << 12) | (arSrc << 8) | (5 << 4);
const RFR = (arDest: number, frSrc: number) => (0xfa << 16) | (arDest << 12) | (frSrc << 8) | (4 << 4);
const FLOAT_S = (frDest: number, arSrc: number, scale: number) => (0xca << 16) | (frDest << 12) | (arSrc << 8) | ((scale & 0xf) << 4);
const UFLOAT_S = (frDest: number, arSrc: number, scale: number) => (0xda << 16) | (frDest << 12) | (arSrc << 8) | ((scale & 0xf) << 4);
const TRUNC_S = (arDest: number, frSrc: number, scale: number) => (0x9a << 16) | (arDest << 12) | (frSrc << 8) | ((scale & 0xf) << 4);
const UTRUNC_S = (arDest: number, frSrc: number, scale: number) => (0xea << 16) | (arDest << 12) | (frSrc << 8) | ((scale & 0xf) << 4);
const OEQ_S = (brDest: number, s1: number, s2: number) => (0x2b << 16) | (brDest << 12) | (s1 << 8) | (s2 << 4);
const OLT_S = (brDest: number, s1: number, s2: number) => (0x4b << 16) | (brDest << 12) | (s1 << 8) | (s2 << 4);
const OLE_S = (brDest: number, s1: number, s2: number) => (0x6b << 16) | (brDest << 12) | (s1 << 8) | (s2 << 4);
const UN_S = (brDest: number, s1: number, s2: number) => (0x1b << 16) | (brDest << 12) | (s1 << 8) | (s2 << 4);
const BT = (br: number, offset: number) => (((offset & 0xff) << 16) | (1 << 12) | (br << 8) | (7 << 4) | 0x6) >>> 0;
const BF = (br: number, offset: number) => (((offset & 0xff) << 16) | (0 << 12) | (br << 8) | (7 << 4) | 0x6) >>> 0;

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
  it('defaults pc to the real hardware reset vector (XCHAL_RESET_VECTOR_VADDR) when omitted', () => {
    const cpu = new Cpu(new RegisterFile(), new TestBus());
    expect(cpu.pc).toBe(RESET_VECTOR);
    expect(RESET_VECTOR).toBe(0x40000400);
  });

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

  describe('logical and shift instructions', () => {
    it.each([
      ['AND', AND, (a: number, b: number) => a & b],
      ['OR', OR, (a: number, b: number) => a | b],
      ['XOR', XOR, (a: number, b: number) => a ^ b],
    ] as const)('runs %s', (_name, encode, op) => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 0b1100));
      bus.writeInsn(3, MOVI(2, 0b1010));
      bus.writeInsn(6, encode(3, 1, 2));

      cpu.step();
      cpu.step();
      cpu.step();
      expect(cpu.regs.get(3)).toBe(op(0b1100, 0b1010) >>> 0);
    });

    it('NEG negates and wraps to an unsigned 32-bit result', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 5));
      bus.writeInsn(3, NEG(2, 1));

      cpu.step();
      cpu.step();
      expect(cpu.regs.get(2)).toBe((-5) >>> 0);
    });

    it('ABS takes the absolute value of a signed register', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, -7));
      bus.writeInsn(3, ABS(2, 1));

      cpu.step();
      cpu.step();
      expect(cpu.regs.get(2)).toBe(7);
    });

    it('SSR + SRL: right-shifts using the register-supplied amount', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 4)); // shift amount
      bus.writeInsn(3, SSR(1));
      bus.writeInsn(6, MOVI(2, 0x100));
      bus.writeInsn(9, SRL(3, 2));

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe(0x100 >>> 4);
    });

    it('SSR + SRA: preserves sign when shifting right', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 2));
      bus.writeInsn(3, SSR(1));
      bus.writeInsn(6, MOVI(2, -16));
      bus.writeInsn(9, SRA(3, 2));

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe((-16 >> 2) >>> 0);
    });

    it('SSL + SLL: left-shifts using SAR\'s 32-complement encoding', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 3)); // intended left-shift amount
      bus.writeInsn(3, SSL(1)); // SAR = 32 - 3 = 29
      bus.writeInsn(6, MOVI(2, 5));
      bus.writeInsn(9, SLL(3, 2)); // shiftAmt = (32-29)&0x3f = 3

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe(5 << 3);
    });

    it('SSL by 0 is a no-op shift for SLL (round-trips through the 32-complement encoding)', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 0)); // intended left-shift amount: 0
      bus.writeInsn(3, SSL(1)); // SAR = 32 - 0 = 32
      bus.writeInsn(6, MOVI(2, 0x123)); // within MOVI's +/-2048..2047 range
      bus.writeInsn(9, SLL(3, 2)); // shiftAmt = (32-32)&0x3f = 0

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe(0x123);
    });

    it('SLL shifts out entirely (result 0) when the effective amount is 32', () => {
      const { cpu, bus } = makeCpu();
      // Craft SAR=0 directly (as if SSR had run with a register holding 0),
      // so SLL's (32-SAR)&0x3f formula evaluates to exactly 32.
      bus.writeInsn(0, MOVI(1, 0));
      bus.writeInsn(3, SSR(1)); // SAR = 0
      bus.writeInsn(6, MOVI(2, 0x123));
      bus.writeInsn(9, SLL(3, 2)); // shiftAmt = (32-0)&0x3f = 32

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe(0);
    });

    it('SRC funnel-shifts a {src1:src2} pair right by SAR', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 4));
      bus.writeInsn(3, SSR(1)); // SAR = 4
      bus.writeInsn(6, MOVI(2, 0x1)); // high word
      bus.writeInsn(9, MOVI(3, 0x0)); // low word
      bus.writeInsn(12, SRC(4, 2, 3)); // (0x1_00000000 >> 4) & 0xffffffff

      for (let i = 0; i < 5; i++) cpu.step();
      expect(cpu.regs.get(4)).toBe(0x10000000);
    });

    it('SLLI/SRAI/SRLI shift by an immediate with no SAR involved', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 3));
      bus.writeInsn(3, SLLI(2, 1, 4));
      bus.writeInsn(6, MOVI(1, -16));
      bus.writeInsn(9, SRAI(3, 1, 2));
      bus.writeInsn(12, MOVI(1, 0x100));
      bus.writeInsn(15, SRLI(4, 1, 4));

      for (let i = 0; i < 6; i++) cpu.step();
      expect(cpu.regs.get(2)).toBe(3 << 4);
      expect(cpu.regs.get(3)).toBe((-16 >> 2) >>> 0);
      expect(cpu.regs.get(4)).toBe(0x100 >>> 4);
    });

    it('SSAI sets SAR directly from an immediate (no register read)', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, SSAI(4));
      bus.writeInsn(3, MOVI(1, 0x100));
      bus.writeInsn(6, SRL(2, 1));

      cpu.step();
      cpu.step();
      cpu.step();
      expect(cpu.regs.get(2)).toBe(0x100 >>> 4);
    });
  });

  describe('ADDI, NSA/NSAU, MULL, and the div32 family', () => {
    it('runs 24-bit ADDI (dest = src + signed imm8)', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 10));
      bus.writeInsn(3, ADDI(2, 1, -3));

      cpu.step();
      cpu.step();
      expect(cpu.regs.get(2)).toBe(7);
    });

    it('NSA counts redundant leading sign bits (clrsb)', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 0)); // 0: 31 redundant sign bits
      bus.writeInsn(3, NSA(2, 1));
      bus.writeInsn(6, MOVI(1, -1)); // all-ones: 31 redundant sign bits
      bus.writeInsn(9, NSA(3, 1));
      bus.writeInsn(12, MOVI(1, 4)); // 0b100: sign bit 0, 28 redundant zero bits above it
      bus.writeInsn(15, NSA(4, 1));

      for (let i = 0; i < 6; i++) cpu.step();
      expect(cpu.regs.get(2)).toBe(31);
      expect(cpu.regs.get(3)).toBe(31);
      expect(cpu.regs.get(4)).toBe(28);
    });

    it('NSAU counts leading zero bits, 32 for a zero input', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 0));
      bus.writeInsn(3, NSAU(2, 1));
      bus.writeInsn(6, MOVI(1, 1));
      bus.writeInsn(9, NSAU(3, 1));

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(2)).toBe(32);
      expect(cpu.regs.get(3)).toBe(31);
    });

    it('MULL multiplies and wraps to the low 32 bits', () => {
      const { cpu, bus } = makeCpu();
      // 0x7fff is outside MOVI's +/-2048..2047 range, so set both operands
      // directly rather than via MOVI (which would silently sign-truncate).
      cpu.regs.set(1, 0x7fff);
      cpu.regs.set(2, 0x7fff);
      bus.writeInsn(0, MULL(3, 1, 2));

      cpu.step();
      expect(cpu.regs.get(3)).toBe((0x7fff * 0x7fff) >>> 0);
    });

    it('QUOU/REMU perform unsigned division and remainder', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, -1)); // 0xffffffff as an unsigned dividend
      bus.writeInsn(3, MOVI(2, 10));
      bus.writeInsn(6, QUOU(3, 1, 2));
      bus.writeInsn(9, REMU(4, 1, 2));

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe(Math.floor(0xffffffff / 10));
      expect(cpu.regs.get(4)).toBe(0xffffffff % 10);
    });

    it('QUOS/REMS perform signed division and remainder, truncating toward zero', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, -7));
      bus.writeInsn(3, MOVI(2, 2));
      bus.writeInsn(6, QUOS(3, 1, 2));
      bus.writeInsn(9, REMS(4, 1, 2));

      for (let i = 0; i < 4; i++) cpu.step();
      expect(cpu.regs.get(3)).toBe((-3) >>> 0); // -7/2 truncates to -3, not floor's -4
      expect(cpu.regs.get(4)).toBe((-1) >>> 0); // -7 % 2 == -1 in C/Xtensa semantics
    });

    it('QUOS handles INT_MIN / -1 without overflow (returns INT_MIN)', () => {
      const { cpu, bus } = makeCpu();
      cpu.regs.set(1, 0x80000000); // INT_MIN, out of MOVI's 12-bit range
      bus.writeInsn(0, MOVI(2, -1));
      bus.writeInsn(3, QUOS(3, 1, 2));

      cpu.step();
      cpu.step();
      expect(cpu.regs.get(3)).toBe(0x80000000);
    });

    it('REMS handles INT_MIN % -1 without overflow (returns 0)', () => {
      const { cpu, bus } = makeCpu();
      cpu.regs.set(1, 0x80000000);
      bus.writeInsn(0, MOVI(2, -1));
      bus.writeInsn(3, REMS(3, 1, 2));

      cpu.step();
      cpu.step();
      expect(cpu.regs.get(3)).toBe(0);
    });

    it.each([
      ['QUOU', QUOU],
      ['QUOS', QUOS],
      ['REMU', REMU],
      ['REMS', REMS],
    ] as const)('%s raises a divide-by-zero exception instead of dividing', (_name, encode) => {
      const { cpu, bus } = makeCpu();
      cpu.vecbase = 0x400;
      bus.writeInsn(0, MOVI(1, 10));
      bus.writeInsn(3, MOVI(2, 0));
      bus.writeInsn(6, encode(3, 1, 2));

      cpu.step();
      cpu.step();
      cpu.step();
      expect(cpu.lastException).toEqual({ kind: 'divide-by-zero' });
      expect(cpu.pc).toBe(cpu.vecbase + 0x300);
      expect(cpu.regs.get(3)).toBe(0); // untouched - the divide never ran
    });
  });

  describe('interrupt delivery', () => {
    it('delivers a level-1 interrupt through the shared exception path, preempting the pending instruction', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 5)); // should NOT execute this step
      cpu.intenable = 1 << 0; // CPU line 0 is level 1 (XCHAL_INT0_LEVEL)
      cpu.setInterruptLine(0, true);

      cpu.step();

      expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 1 });
      expect(cpu.pc).toBe(cpu.vecbase + 0x300);
      expect(cpu.epc1).toBe(0);
      expect(cpu.excm).toBe(true);
      expect(cpu.regs.get(1)).toBe(0); // MOVI never ran
    });

    it('a line with INTENABLE=0 never interrupts', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 5));
      cpu.setInterruptLine(0, true); // intenable stays 0

      cpu.step();
      expect(cpu.lastException).toBeNull();
      expect(cpu.regs.get(1)).toBe(5);
    });

    it('PS.EXCM raises the effective level to EXCM_LEVEL(3), blocking level<=3 interrupts', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 5));
      cpu.excm = true; // as if already inside an exception/interrupt handler
      cpu.intenable = 1 << 19; // line 19 is level 2 (XCHAL_INT19_LEVEL)
      cpu.setInterruptLine(19, true);

      cpu.step();
      expect(cpu.lastException).toBeNull();
      expect(cpu.regs.get(1)).toBe(5);
    });

    it('delivers and returns from a level-2 interrupt via RFI', () => {
      const { cpu, bus } = makeCpu();
      cpu.vecbase = 0x400; // keep vectors within TestBus's small backing array
      bus.writeInsn(0, MOVI(1, 5)); // preempted by the interrupt
      bus.writeInsn(cpu.vecbase + 0x180, RFI(2)); // XCHAL_INTLEVEL2_VECOFS

      cpu.intenable = 1 << 19;
      cpu.setInterruptLine(19, true);

      cpu.step(); // interrupt taken
      expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 2 });
      expect(cpu.pc).toBe(cpu.vecbase + 0x180);
      expect(cpu.intlevel).toBe(2);
      expect(cpu.excm).toBe(true);

      cpu.setInterruptLine(19, false); // the "ISR" services and clears its peripheral's condition

      cpu.step(); // RFI 2
      expect(cpu.pc).toBe(0);
      expect(cpu.intlevel).toBe(0);
      expect(cpu.excm).toBe(false);
      expect(cpu.lastException).toBeNull();

      cpu.step(); // MOVI now runs for real, back at the original pc
      expect(cpu.regs.get(1)).toBe(5);
    });

    it('a higher-level interrupt preempts a lower one already in progress', () => {
      const { cpu, bus } = makeCpu();
      cpu.vecbase = 0x400;
      bus.writeInsn(cpu.vecbase + 0x180, MOVI(2, 1)); // level-2 handler body (never reached)
      bus.writeInsn(cpu.vecbase + 0x200, MOVI(3, 1)); // level-4 handler (XCHAL_INT24_LEVEL)

      cpu.intenable = (1 << 19) | (1 << 24);
      cpu.setInterruptLine(19, true);
      cpu.step(); // level 2 taken
      expect(cpu.intlevel).toBe(2);

      cpu.setInterruptLine(24, true);
      cpu.step(); // level 4 preempts (4 > cintlevel, which is 3 here: EXCM_LEVEL dominates intlevel=2)
      expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 4 });
      expect(cpu.pc).toBe(cpu.vecbase + 0x200);
      expect(cpu.intlevel).toBe(4);
      expect(cpu.regs.get(2)).toBe(0); // the level-2 handler's body never ran
    });

    it('RSIL raises PS.INTLEVEL and returns the old packed PS value', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, RSIL(2, 3));
      cpu.step();
      expect(cpu.intlevel).toBe(3);
      expect(cpu.regs.get(2) & 0xf).toBe(0); // old INTLEVEL, before this RSIL, was 0
    });

    it('WSR.PS/RSIL round-trip a full packed PS value (critical-section raise/restore)', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, RSIL(2, 5)); // save old PS in a2, raise to level 5
      bus.writeInsn(3, WSR(SR_PS, 2)); // restore it

      cpu.step();
      expect(cpu.intlevel).toBe(5);
      cpu.step();
      expect(cpu.intlevel).toBe(0);
    });

    it('WSR.INTENABLE/RSR.INTENABLE round-trip the interrupt-enable mask', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 0x123));
      bus.writeInsn(3, WSR(SR_INTENABLE, 1));
      bus.writeInsn(6, RSR(SR_INTENABLE, 2));

      cpu.step();
      cpu.step();
      expect(cpu.intenable).toBe(0x123);
      cpu.step();
      expect(cpu.regs.get(2)).toBe(0x123);
    });

    it('RSR/WSR on an unbacked special register is illegal', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, RSR(1, 2)); // SR=1 is neither PS(230) nor INTENABLE(228)
      cpu.step();
      expect(cpu.lastException).toEqual({ kind: 'illegal' });
    });

    it('RFE returns from a level-1 illegal-instruction exception (clears EXCM, jumps to EPC1)', () => {
      const { cpu, bus } = makeCpu();
      cpu.vecbase = 0x400;
      bus.writeInsn(0, 0xdead0f); // illegal
      bus.writeInsn(cpu.vecbase + 0x300, RFE);

      cpu.step(); // illegal instruction -> vectors
      expect(cpu.lastException).toEqual({ kind: 'illegal' });
      expect(cpu.pc).toBe(cpu.vecbase + 0x300);
      expect(cpu.excm).toBe(true);

      // The handler "fixes" the fault before returning, e.g. by patching in
      // a real instruction - otherwise RFE would just re-trap on retry.
      bus.writeInsn(0, MOVI(1, 42));

      cpu.step(); // RFE
      expect(cpu.pc).toBe(0); // back to EPC1
      expect(cpu.excm).toBe(false);

      cpu.step(); // the patched-in instruction now runs for real
      expect(cpu.regs.get(1)).toBe(42);
    });

    it('RFE returns from a level-1 interrupt the same way', () => {
      const { cpu, bus } = makeCpu();
      cpu.vecbase = 0x400;
      bus.writeInsn(cpu.vecbase + 0x300, RFE);
      cpu.intenable = 1 << 0; // line 0 is level 1
      cpu.setInterruptLine(0, true);

      cpu.step(); // interrupt taken
      expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 1 });
      expect(cpu.pc).toBe(cpu.vecbase + 0x300);

      cpu.setInterruptLine(0, false); // "ISR" clears the condition
      cpu.step(); // RFE
      expect(cpu.pc).toBe(0); // back to the original, preempted pc
      expect(cpu.excm).toBe(false);
    });

    it('an NMI (line 14) is unmaskable - taken even with INTENABLE=0 and PS.EXCM set', () => {
      const { cpu, bus } = makeCpu();
      cpu.vecbase = 0x400;
      bus.writeInsn(0, MOVI(1, 5)); // preempted
      bus.writeInsn(cpu.vecbase + 0x2c0, RFI(7));
      cpu.excm = true; // would block every other interrupt level

      cpu.setInterruptLine(14, true); // intenable left at 0 - doesn't matter for NMI

      cpu.step();
      expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 7 });
      expect(cpu.pc).toBe(cpu.vecbase + 0x2c0);
      expect(cpu.intlevel).toBe(7);
      expect(cpu.regs.get(1)).toBe(0); // MOVI never ran

      cpu.setInterruptLine(14, false);
      cpu.step(); // RFI 7
      expect(cpu.pc).toBe(0);
      expect(cpu.excm).toBe(true); // restored to what it was before the NMI (true)
    });
  });

  describe('FPU (single-precision) instructions', () => {
    it('runs ADD.S/SUB.S/MUL.S on the FR register file', () => {
      const { cpu, bus } = makeCpu();
      cpu.fpu.setFr(1, 2.5);
      cpu.fpu.setFr(2, 4);
      bus.writeInsn(0, ADD_S(3, 1, 2));
      bus.writeInsn(3, SUB_S(4, 1, 2));
      bus.writeInsn(6, MUL_S(5, 1, 2));

      cpu.step();
      expect(cpu.fpu.getFr(3)).toBe(6.5);
      cpu.step();
      expect(cpu.fpu.getFr(4)).toBe(-1.5);
      cpu.step();
      expect(cpu.fpu.getFr(5)).toBe(10);
    });

    it('runs MOV.S/NEG.S/ABS.S', () => {
      const { cpu, bus } = makeCpu();
      cpu.fpu.setFr(1, -3.5);
      bus.writeInsn(0, MOV_S(2, 1));
      bus.writeInsn(3, NEG_S(3, 1));
      bus.writeInsn(6, ABS_S(4, 1));

      cpu.step();
      expect(cpu.fpu.getFr(2)).toBe(-3.5);
      cpu.step();
      expect(cpu.fpu.getFr(3)).toBe(3.5);
      cpu.step();
      expect(cpu.fpu.getFr(4)).toBe(3.5);
    });

    it('WFR/RFR move a raw 32-bit pattern between AR and FR with no conversion', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 0x2a));
      bus.writeInsn(3, WFR(2, 1)); // fr2 <- raw bits of a1
      bus.writeInsn(6, RFR(3, 2)); // a3 <- raw bits of fr2

      cpu.step();
      cpu.step();
      expect(cpu.fpu.readFrBits(2)).toBe(0x2a);
      cpu.step();
      expect(cpu.regs.get(3)).toBe(0x2a);
    });

    it('FLOAT.S/UFLOAT.S convert an AR integer to FR, scaled by 2^-scale', () => {
      const { cpu, bus } = makeCpu();
      bus.writeInsn(0, MOVI(1, 5));
      bus.writeInsn(3, FLOAT_S(0, 1, 0)); // 5 * 2^0 = 5
      bus.writeInsn(6, FLOAT_S(1, 1, 1)); // 5 * 2^-1 = 2.5

      cpu.step();
      cpu.step();
      expect(cpu.fpu.getFr(0)).toBe(5);
      cpu.step();
      expect(cpu.fpu.getFr(1)).toBe(2.5);

      const { cpu: cpu2, bus: bus2 } = makeCpu();
      cpu2.regs.set(1, 0xfffffffb); // -5 as a raw bit pattern, out of MOVI's 12-bit range
      bus2.writeInsn(0, UFLOAT_S(0, 1, 0)); // treated as the unsigned value 4294967291
      cpu2.step();
      expect(cpu2.fpu.getFr(0)).toBe(Math.fround(0xfffffffb));
    });

    it('TRUNC.S/UTRUNC.S convert an FR value to AR, scaled by 2^scale and truncated toward zero', () => {
      const { cpu, bus } = makeCpu();
      cpu.fpu.setFr(1, 3.75);
      cpu.fpu.setFr(2, -3.75);
      bus.writeInsn(0, TRUNC_S(2, 1, 0)); // trunc(3.75) = 3
      bus.writeInsn(3, TRUNC_S(3, 2, 0)); // trunc(-3.75) = -3
      bus.writeInsn(6, UTRUNC_S(4, 1, 1)); // trunc(3.75 * 2) = 7

      cpu.step();
      expect(cpu.regs.get(2) | 0).toBe(3);
      cpu.step();
      expect(cpu.regs.get(3) | 0).toBe(-3);
      cpu.step();
      expect(cpu.regs.get(4)).toBe(7);
    });

    it('OEQ.S/OLT.S/OLE.S set a BR bit; BT/BF branch on it', () => {
      const { cpu, bus } = makeCpu();
      cpu.fpu.setFr(1, 1);
      cpu.fpu.setFr(2, 2);
      bus.writeInsn(0, OLT_S(3, 1, 2)); // 1 < 2 -> br3 = true
      bus.writeInsn(3, OEQ_S(4, 1, 2)); // 1 == 2 -> br4 = false
      bus.writeInsn(6, OLE_S(5, 1, 1)); // 1 <= 1 -> br5 = true

      cpu.step();
      expect(cpu.fpu.getBr(3)).toBe(true);
      cpu.step();
      expect(cpu.fpu.getBr(4)).toBe(false);
      cpu.step();
      expect(cpu.fpu.getBr(5)).toBe(true);

      bus.writeInsn(9, BT(3, 20)); // br3 is true -> branch taken
      bus.writeInsn(12, BF(4, 20)); // br4 is false -> branch taken
      cpu.step();
      expect(cpu.pc).toBe(9 + 4 + 20);
      cpu.pc = 12;
      cpu.step();
      expect(cpu.pc).toBe(12 + 4 + 20);
    });

    it('UN.S sets its BR bit when either operand is NaN', () => {
      const { cpu, bus } = makeCpu();
      cpu.fpu.setFr(1, NaN);
      cpu.fpu.setFr(2, 1);
      bus.writeInsn(0, UN_S(7, 1, 2));
      cpu.step();
      expect(cpu.fpu.getBr(7)).toBe(true);
    });
  });
});
