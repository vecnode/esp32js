import { describe, expect, it } from 'vitest';
import { decode } from '../../src/cpu/decode.js';

// Instruction words below are hand-assembled from the same field formulas
// decode.ts implements (see its header comment for the source), not just
// round-tripped through decode() - each is built independently so the test
// actually checks the encoding, not decode's self-consistency.

function rrr(op2: number, op1: number, r: number, s: number, t: number): number {
  return ((op2 & 0xf) << 20) | ((op1 & 0xf) << 16) | ((r & 0xf) << 12) | ((s & 0xf) << 8) | ((t & 0xf) << 4);
}

describe('decode', () => {
  it('decodes ADD ar,as,at (RRR, op2=0x8)', () => {
    // ADD a3, a1, a2 -> dest=r=3, src1=s=1, src2=t=2
    const word = rrr(0x8, 0x0, 3, 1, 2);
    expect(decode(word)).toEqual({ op: 'ADD', dest: 3, src1: 1, src2: 2 });
  });

  it('decodes SUB ar,as,at (RRR, op2=0xC)', () => {
    const word = rrr(0xc, 0x0, 5, 4, 6);
    expect(decode(word)).toEqual({ op: 'SUB', dest: 5, src1: 4, src2: 6 });
  });

  it('decodes RET (op0=0,op1=0,op2=0,r=0,t=8)', () => {
    const word = 0x000080;
    expect(decode(word)).toEqual({ op: 'RET' });
  });

  it('decodes MOVI at, imm12 with a positive immediate', () => {
    // imm12b raw = (s<<8)|imm8; s = high nibble, imm8 = low byte
    const t = 4;
    const imm = 0x123; // 291, fits positive in 12 bits
    const s = (imm >> 8) & 0xf;
    const imm8 = imm & 0xff;
    const word = (imm8 << 16) | (0xa << 12) | (s << 8) | (t << 4) | 0x2;
    expect(decode(word)).toEqual({ op: 'MOVI', dest: t, imm: 0x123 });
  });

  it('decodes MOVI with a negative (sign-extended) immediate', () => {
    const t = 2;
    const rawImm = 0xffe; // -2 in 12-bit two's complement
    const s = (rawImm >> 8) & 0xf;
    const imm8 = rawImm & 0xff;
    const word = (imm8 << 16) | (0xa << 12) | (s << 8) | (t << 4) | 0x2;
    expect(decode(word)).toEqual({ op: 'MOVI', dest: t, imm: -2 });
  });

  it('decodes L32I at, as, imm (r=0x2, offset scaled by 4)', () => {
    const t = 3;
    const s = 1;
    const imm8 = 5; // -> byte offset 20
    const word = (imm8 << 16) | (0x2 << 12) | (s << 8) | (t << 4) | 0x2;
    expect(decode(word)).toEqual({ op: 'L32I', dest: 3, base: 1, offset: 20 });
  });

  it('decodes S32I at, as, imm (r=0x6, offset scaled by 4)', () => {
    const t = 7;
    const s = 2;
    const imm8 = 3; // -> byte offset 12
    const word = (imm8 << 16) | (0x6 << 12) | (s << 8) | (t << 4) | 0x2;
    expect(decode(word)).toEqual({ op: 'S32I', src: 7, base: 2, offset: 12 });
  });

  it('decodes L32R at, imm16 as a negative word-aligned displacement', () => {
    const t = 6;
    const imm16 = 0; // most-negative case: (0xffff0000 << 2) truncated to 32 bits
    const word = (imm16 << 8) | (t << 4) | 0x1;
    const result = decode(word);
    expect(result.op).toBe('L32R');
    if (result.op === 'L32R') {
      expect(result.dest).toBe(6);
      expect(result.offset).toBe(((0xffff0000 | imm16) << 2) | 0);
      expect(result.offset).toBeLessThan(0);
    }
  });

  it('decodes J with a positive 18-bit offset', () => {
    const off18 = 100;
    const word = (off18 << 6) | 0x6;
    expect(decode(word)).toEqual({ op: 'J', offset: 100 });
  });

  it('decodes J with a negative 18-bit offset', () => {
    const off18 = 0x3ffff; // -1
    const word = (off18 << 6) | 0x6;
    expect(decode(word)).toEqual({ op: 'J', offset: -1 });
  });

  it('decodes CALL0 with n=0 and scales the offset by 4', () => {
    const off18 = 10;
    const word = (off18 << 6) | 0x5;
    expect(decode(word)).toEqual({ op: 'CALL0', offset: 40 });
  });

  it.each([1, 2, 3] as const)('decodes CALLN with n=%i as callinc=%i, scaling the offset by 4', (n) => {
    const off18 = 10;
    const word = (off18 << 6) | (n << 4) | 0x5;
    expect(decode(word)).toEqual({ op: 'CALLN', callinc: n, offset: 40 });
  });

  it('decodes ENTRY (op0=6,n=3,m=0) with s and a x8-scaled immediate', () => {
    const s = 1; // real ABI always uses a1 (stack pointer)
    const imm12 = 6; // -> stack adjust of 48 bytes
    const word = (imm12 << 12) | (s << 8) | (0x3 << 4) | 0x6;
    expect(decode(word)).toEqual({ op: 'ENTRY', s: 1, imm: 48 });
  });

  it('does not misdecode ENTRY as J - n must be 0 for J', () => {
    // Same op0 (0x6) as J, but n=3,m=0: must NOT be treated as a J offset.
    const s = 1;
    const imm12 = 6;
    const word = (imm12 << 12) | (s << 8) | (0x3 << 4) | 0x6;
    expect(decode(word).op).toBe('ENTRY');
  });

  it('decodes RETW (op0=0,op1=0,op2=0,r=0,t=9)', () => {
    const word = 0x000090;
    expect(decode(word)).toEqual({ op: 'RETW' });
  });

  it('decodes RFWO (op0=0,op1=0,op2=0,r=3,s=4,t=0)', () => {
    expect(decode(0x003400)).toEqual({ op: 'RFWO' });
  });

  it('decodes RFWU (op0=0,op1=0,op2=0,r=3,s=5,t=0)', () => {
    expect(decode(0x003500)).toEqual({ op: 'RFWU' });
  });

  it('decodes L32E at, as, immrx4 (op0=0,op1=9,op2=0) as a negative x4 offset', () => {
    const t = 3;
    const s = 1;
    const r = 4; // raw immrx4 -> -(16-4)*4 = -48
    const word = (r << 12) | (s << 8) | (t << 4) | (0x9 << 16);
    expect(decode(word)).toEqual({ op: 'L32E', dest: 3, base: 1, offset: -48 });
  });

  it('decodes S32E at, as, immrx4 (op0=0,op1=9,op2=4) as a negative x4 offset', () => {
    const t = 5;
    const s = 2;
    const r = 15; // raw immrx4 -> -(16-15)*4 = -4, the smallest magnitude
    const word = (r << 12) | (s << 8) | (t << 4) | (0x9 << 16) | (0x4 << 20);
    expect(decode(word)).toEqual({ op: 'S32E', src: 5, base: 2, offset: -4 });
  });

  it('does not decode unimplemented op0=6 members (e.g. BEQZ-shaped, n=1) as J', () => {
    const word = (100 << 6) | (0x1 << 4) | 0x6; // n=1 -> BEQZ family, out of scope
    expect(decode(word).op).toBe('ILLEGAL');
  });

  it.each([
    ['BEQ', 0x1],
    ['BNE', 0x9],
    ['BLT', 0x2],
    ['BGE', 0xa],
  ] as const)('decodes %s (r=0x%s)', (name, r) => {
    const s = 2;
    const t = 3;
    const imm8 = 0x10; // positive displacement
    const word = (imm8 << 16) | (r << 12) | (s << 8) | (t << 4) | 0x7;
    expect(decode(word)).toEqual({ op: name, a: 2, b: 3, offset: 0x10 });
  });

  it('sign-extends a negative branch displacement', () => {
    const imm8 = 0xf0; // -16
    const word = (imm8 << 16) | (0x1 << 12) | (0 << 8) | (0 << 4) | 0x7;
    expect(decode(word)).toEqual({ op: 'BEQ', a: 0, b: 0, offset: -16 });
  });

  it('decodes an unrecognized opcode as ILLEGAL', () => {
    const word = 0xdead0f; // op0=0xf, not in the covered set
    const result = decode(word);
    expect(result.op).toBe('ILLEGAL');
  });
});
