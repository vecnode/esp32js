import { describe, expect, it } from 'vitest';
import { decode, instructionLength } from '../../src/cpu/decode.js';

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

  describe('instructionLength', () => {
    it('is 3 for a 24-bit opcode (e.g. ADD, op0=0)', () => {
      expect(instructionLength(rrr(0x8, 0x0, 1, 2, 3))).toBe(3);
    });

    it.each([0x8, 0x9, 0xa, 0xb, 0xc, 0xd])('is 2 for a density opcode (op0=0x%s)', (op0) => {
      expect(instructionLength(op0)).toBe(2);
    });

    it.each([0xe, 0xf])('is 3 for an unassigned-but-24-bit op0 (0x%s)', (op0) => {
      expect(instructionLength(op0)).toBe(3);
    });
  });

  describe('density (16-bit) instructions', () => {
    it('decodes L32I.N (op0=8) reusing the L32I tag, offset = r * 4', () => {
      const t = 3;
      const s = 1;
      const r = 5; // -> byte offset 20
      const word = (r << 12) | (s << 8) | (t << 4) | 0x8;
      expect(decode(word)).toEqual({ op: 'L32I', dest: 3, base: 1, offset: 20 });
    });

    it('decodes S32I.N (op0=9) reusing the S32I tag', () => {
      const t = 7;
      const s = 2;
      const r = 3; // -> byte offset 12
      const word = (r << 12) | (s << 8) | (t << 4) | 0x9;
      expect(decode(word)).toEqual({ op: 'S32I', src: 7, base: 2, offset: 12 });
    });

    it('decodes ADD.N (op0=10) reusing the ADD tag', () => {
      const r = 4; // dest
      const s = 1; // src1
      const t = 2; // src2
      const word = (r << 12) | (s << 8) | (t << 4) | 0xa;
      expect(decode(word)).toEqual({ op: 'ADD', dest: 4, src1: 1, src2: 2 });
    });

    it('decodes ADDI.N with a literal 1-15 immediate', () => {
      const r = 5; // dest
      const s = 6; // src
      const t = 9; // ai4const raw -> literal 9
      const word = (r << 12) | (s << 8) | (t << 4) | 0xb;
      expect(decode(word)).toEqual({ op: 'ADDI', dest: 5, src: 6, imm: 9 });
    });

    it('decodes ADDI.N with a raw-0 immediate as -1 (the ai4const special case)', () => {
      const word = (5 << 12) | (6 << 8) | (0 << 4) | 0xb;
      expect(decode(word)).toEqual({ op: 'ADDI', dest: 5, src: 6, imm: -1 });
    });

    it('decodes MOVI.N (op0=12,i=0) with dest=s (not t) and a positive immediate', () => {
      // imm7 = 0x2b (43, in the plain-positive 0-95 range); hi=bits[6:4]=0x2, lo=r=0xb
      const dest = 4; // s field
      const hi = 0x2;
      const lo = 0xb;
      const word = (lo << 12) | (dest << 8) | (hi << 4) | 0xc; // i=bit7=0 since hi<0x8
      expect(decode(word)).toEqual({ op: 'MOVI', dest: 4, imm: 0x2b });
    });

    it('decodes MOVI.N with the asymmetric negative range (raw7 in [0x60,0x7f] -> -32..-1)', () => {
      // raw7=0x60 (hi=0x6,lo=0x0) -> both top bits of the 7-bit field set -> sign-extends to -32
      const dest = 2;
      const hi = 0x6;
      const lo = 0x0;
      const word = (lo << 12) | (dest << 8) | (hi << 4) | 0xc;
      expect(decode(word)).toEqual({ op: 'MOVI', dest: 2, imm: -32 });
    });

    it('decodes BEQZ.N (op0=12,i=1,z=0) with a0-relative comparison against zero', () => {
      // imm6 = 0x15 (21); hi=bits[5:4]=0x1, lo=r=0x5; i=1,z=0 -> word bit7=1,bit6=0
      const a = 3; // s field
      const hi = 0x1;
      const lo = 0x5;
      const word = (lo << 12) | (a << 8) | (hi << 4) | (1 << 7) | 0xc;
      expect(decode(word)).toEqual({ op: 'BEQZ', a: 3, offset: 0x15 });
    });

    it('decodes BNEZ.N (op0=12,i=1,z=1)', () => {
      const a = 5;
      const hi = 0x0;
      const lo = 0x8;
      const word = (lo << 12) | (a << 8) | (hi << 4) | (1 << 7) | (1 << 6) | 0xc;
      expect(decode(word)).toEqual({ op: 'BNEZ', a: 5, offset: 0x8 });
    });

    it('decodes MOV.N (op0=13,r=0) as a plain register copy', () => {
      const dest = 4; // t field
      const src = 7; // s field
      const word = (0 << 12) | (src << 8) | (dest << 4) | 0xd;
      expect(decode(word)).toEqual({ op: 'MOV', dest: 4, src: 7 });
    });

    it('decodes RET.N (op0=13,r=15,t=0) reusing the RET tag', () => {
      const word = (0xf << 12) | (0 << 4) | 0xd;
      expect(decode(word)).toEqual({ op: 'RET' });
    });

    it('decodes RETW.N (op0=13,r=15,t=1) reusing the RETW tag', () => {
      const word = (0xf << 12) | (1 << 4) | 0xd;
      expect(decode(word)).toEqual({ op: 'RETW' });
    });

    it('decodes NOP.N (op0=13,r=15,t=3,s=0)', () => {
      const word = (0xf << 12) | (0 << 8) | (3 << 4) | 0xd;
      expect(decode(word)).toEqual({ op: 'NOP' });
    });

    it('decodes ILL.N (op0=13,r=15,t=6,s=0) as ILLEGAL - not specially handled', () => {
      const word = (0xf << 12) | (0 << 8) | (6 << 4) | 0xd;
      expect(decode(word).op).toBe('ILLEGAL');
    });
  });

  describe('logical and shift instructions', () => {
    it.each([
      ['AND', 0x1],
      ['OR', 0x2],
      ['XOR', 0x3],
    ] as const)('decodes %s (RRR, op2=0x%s)', (name, op2) => {
      const word = rrr(op2, 0x0, 4, 2, 3);
      expect(decode(word)).toEqual({ op: name, dest: 4, src1: 2, src2: 3 });
    });

    it('decodes NEG (op2=6, s=0)', () => {
      const word = rrr(0x6, 0x0, 5, 0, 7);
      expect(decode(word)).toEqual({ op: 'NEG', dest: 5, src: 7 });
    });

    it('decodes ABS (op2=6, s=1) - same shape as NEG, distinguished only by s', () => {
      const word = rrr(0x6, 0x0, 5, 1, 7);
      expect(decode(word)).toEqual({ op: 'ABS', dest: 5, src: 7 });
    });

    it('decodes SSR (op1=0,op2=4,r=0), src register in the s field', () => {
      const word = rrr(0x4, 0x0, 0, 6, 0);
      expect(decode(word)).toEqual({ op: 'SSR', src: 6 });
    });

    it('decodes SSL (op1=0,op2=4,r=1)', () => {
      const word = rrr(0x4, 0x0, 1, 6, 0);
      expect(decode(word)).toEqual({ op: 'SSL', src: 6 });
    });

    it('decodes SSAI (op1=0,op2=4,r=4) with a composite 5-bit shift amount', () => {
      // shift = (t&1)<<4 | s; t=1 (odd, contributes the high bit), s=0xa -> shift=0x1a=26
      const word = rrr(0x4, 0x0, 4, 0xa, 1);
      expect(decode(word)).toEqual({ op: 'SSAI', shift: 26 });
    });

    it('decodes SLL (op1=1,op2=0xa), src in the s field', () => {
      const word = rrr(0xa, 0x1, 3, 2, 0);
      expect(decode(word)).toEqual({ op: 'SLL', dest: 3, src: 2 });
    });

    it('decodes SRL (op1=1,op2=9), src in the t field', () => {
      const word = rrr(0x9, 0x1, 3, 0, 5);
      expect(decode(word)).toEqual({ op: 'SRL', dest: 3, src: 5 });
    });

    it('decodes SRA (op1=1,op2=0xb)', () => {
      const word = rrr(0xb, 0x1, 3, 0, 5);
      expect(decode(word)).toEqual({ op: 'SRA', dest: 3, src: 5 });
    });

    it('decodes SRC (op1=1,op2=8), the funnel shift', () => {
      const word = rrr(0x8, 0x1, 4, 2, 3);
      expect(decode(word)).toEqual({ op: 'SRC', dest: 4, src1: 2, src2: 3 });
    });

    it('decodes SRLI (op1=1,op2=4) with a plain 0-15 shift amount', () => {
      const word = rrr(0x4, 0x1, 6, 9, 5); // shift = s = 9
      expect(decode(word)).toEqual({ op: 'SRLI', dest: 6, src: 5, shift: 9 });
    });

    it('SLLI with salRaw=0 shifts by 0 (the documented "undefined shift by 32" case)', () => {
      const word = rrr(0x0, 0x1, 4, 2, 0x0); // op2=0,t=0 -> salRaw=0 -> 0x20-0=32, &0x1f=0
      expect(decode(word)).toEqual({ op: 'SLLI', dest: 4, src: 2, shift: 0 });
    });

    it('SLLI with a mid-range shift amount', () => {
      // op2=1 contributes bit4 of salRaw; t=0x8 -> salRaw=0x18=24 -> shift=(32-24)&0x1f=8
      const word = rrr(0x1, 0x1, 4, 2, 0x8);
      expect(decode(word)).toEqual({ op: 'SLLI', dest: 4, src: 2, shift: 8 });
    });

    it('decodes SRAI reassembling shift from op2 LSB + s (identity, no transform)', () => {
      // op2=3 -> bit4=1; s=0xa -> shift = (1<<4)|0xa = 0x1a = 26
      const word = rrr(0x3, 0x1, 4, 0xa, 7);
      expect(decode(word)).toEqual({ op: 'SRAI', dest: 4, src: 7, shift: 26 });
    });
  });

  describe('ADDI, NSA/NSAU, MULL, and the div32 family', () => {
    it('decodes ADDI (op0=2,r=0xc) with dest=t, src=s, and a signed imm8', () => {
      const t = 3;
      const s = 1;
      const imm8 = 0xfe; // -2
      const word = (imm8 << 16) | (0xc << 12) | (s << 8) | (t << 4) | 0x2;
      expect(decode(word)).toEqual({ op: 'ADDI', dest: 3, src: 1, imm: -2 });
    });

    it('decodes NSA (op1=0,op2=4,r=0xe), dest=t, src=s', () => {
      const word = rrr(0x4, 0x0, 0xe, 5, 6);
      expect(decode(word)).toEqual({ op: 'NSA', dest: 6, src: 5 });
    });

    it('decodes NSAU (op1=0,op2=4,r=0xf)', () => {
      const word = rrr(0x4, 0x0, 0xf, 5, 6);
      expect(decode(word)).toEqual({ op: 'NSAU', dest: 6, src: 5 });
    });

    it('decodes MULL (op1=2,op2=8)', () => {
      const word = rrr(0x8, 0x2, 4, 1, 2);
      expect(decode(word)).toEqual({ op: 'MULL', dest: 4, src1: 1, src2: 2 });
    });

    it.each([
      ['QUOU', 0xc],
      ['QUOS', 0xd],
      ['REMU', 0xe],
      ['REMS', 0xf],
    ] as const)('decodes %s (op1=2, op2=0x%s)', (name, op2) => {
      const word = rrr(op2, 0x2, 4, 1, 2);
      expect(decode(word)).toEqual({ op: name, dest: 4, src1: 1, src2: 2 });
    });
  });

  describe('interrupt-related instructions', () => {
    it('decodes RSIL (op1=0,op2=0,r=6), dest=t, level=s', () => {
      const word = rrr(0x0, 0x0, 6, 3, 4);
      expect(decode(word)).toEqual({ op: 'RSIL', dest: 4, level: 3 });
    });

    it('decodes RFI (op1=0,op2=0,r=3,t=1), level=s', () => {
      const word = rrr(0x0, 0x0, 3, 5, 1);
      expect(decode(word)).toEqual({ op: 'RFI', level: 5 });
    });

    it('does not confuse RFI (t=1) with RFE/RFWO/RFWU (t=0)', () => {
      const rfe = rrr(0x0, 0x0, 3, 0, 0);
      const rfwo = rrr(0x0, 0x0, 3, 4, 0);
      const rfwu = rrr(0x0, 0x0, 3, 5, 0);
      expect(decode(rfe)).toEqual({ op: 'RFE' });
      expect(decode(rfwo)).toEqual({ op: 'RFWO' });
      expect(decode(rfwu)).toEqual({ op: 'RFWU' });
    });

    it('decodes RSR.PS/WSR.PS (SR=230=0xE6 -> r=0xE,s=6)', () => {
      const rsr = rrr(0x0, 0x3, 0xe, 6, 2);
      const wsr = rrr(0x1, 0x3, 0xe, 6, 2);
      expect(decode(rsr)).toEqual({ op: 'RSR', sr: 230, reg: 2 });
      expect(decode(wsr)).toEqual({ op: 'WSR', sr: 230, reg: 2 });
    });

    it('decodes RSR.INTENABLE/WSR.INTENABLE (SR=228=0xE4 -> r=0xE,s=4)', () => {
      const rsr = rrr(0x0, 0x3, 0xe, 4, 5);
      const wsr = rrr(0x1, 0x3, 0xe, 4, 5);
      expect(decode(rsr)).toEqual({ op: 'RSR', sr: 228, reg: 5 });
      expect(decode(wsr)).toEqual({ op: 'WSR', sr: 228, reg: 5 });
    });
  });

  describe('FPU (single-precision) instructions', () => {
    it('decodes ADD.S/SUB.S/MUL.S (op1=0xa, op2=0/1/2)', () => {
      expect(decode(rrr(0x0, 0xa, 4, 1, 2))).toEqual({ op: 'ADD_S', dest: 4, src1: 1, src2: 2 });
      expect(decode(rrr(0x1, 0xa, 4, 1, 2))).toEqual({ op: 'SUB_S', dest: 4, src1: 1, src2: 2 });
      expect(decode(rrr(0x2, 0xa, 4, 1, 2))).toEqual({ op: 'MUL_S', dest: 4, src1: 1, src2: 2 });
    });

    it('decodes MOV.S/ABS.S/NEG.S (op1=0xa,op2=0xf, disambiguated by t)', () => {
      expect(decode(rrr(0xf, 0xa, 3, 2, 0))).toEqual({ op: 'MOV_S', dest: 3, src: 2 });
      expect(decode(rrr(0xf, 0xa, 3, 2, 1))).toEqual({ op: 'ABS_S', dest: 3, src: 2 });
      expect(decode(rrr(0xf, 0xa, 3, 2, 6))).toEqual({ op: 'NEG_S', dest: 3, src: 2 });
    });

    it('decodes WFR/RFR (op1=0xa,op2=0xf,t=5/4)', () => {
      expect(decode(rrr(0xf, 0xa, 3, 2, 5))).toEqual({ op: 'WFR', dest: 3, src: 2 });
      expect(decode(rrr(0xf, 0xa, 3, 2, 4))).toEqual({ op: 'RFR', dest: 3, src: 2 });
    });

    it('decodes FLOAT.S/UFLOAT.S/TRUNC.S/UTRUNC.S (op1=0xa, op2=0xc/d/9/e), scale=t unsigned', () => {
      expect(decode(rrr(0xc, 0xa, 2, 5, 9))).toEqual({ op: 'FLOAT_S', dest: 2, src: 5, scale: 9 });
      expect(decode(rrr(0xd, 0xa, 2, 5, 9))).toEqual({ op: 'UFLOAT_S', dest: 2, src: 5, scale: 9 });
      expect(decode(rrr(0x9, 0xa, 2, 5, 9))).toEqual({ op: 'TRUNC_S', dest: 2, src: 5, scale: 9 });
      expect(decode(rrr(0xe, 0xa, 2, 5, 9))).toEqual({ op: 'UTRUNC_S', dest: 2, src: 5, scale: 9 });
    });

    it('decodes OEQ.S/OLT.S/OLE.S/UN.S (op1=0xb, op2=2/4/6/1), dest is a BR index', () => {
      expect(decode(rrr(0x2, 0xb, 7, 1, 2))).toEqual({ op: 'OEQ_S', dest: 7, src1: 1, src2: 2 });
      expect(decode(rrr(0x4, 0xb, 7, 1, 2))).toEqual({ op: 'OLT_S', dest: 7, src1: 1, src2: 2 });
      expect(decode(rrr(0x6, 0xb, 7, 1, 2))).toEqual({ op: 'OLE_S', dest: 7, src1: 1, src2: 2 });
      expect(decode(rrr(0x1, 0xb, 7, 1, 2))).toEqual({ op: 'UN_S', dest: 7, src1: 1, src2: 2 });
    });

    it('decodes BT/BF (op0=6,n=3,m=1; r selects BT/BF, s=bs, imm8=signed offset)', () => {
      // word = imm8<<16 | r<<12 | s<<8 | t<<4 | op0; t=7 fixes n=3,m=1.
      const bt = (10 << 16) | (1 << 12) | (3 << 8) | (7 << 4) | 0x6;
      const bf = (10 << 16) | (0 << 12) | (3 << 8) | (7 << 4) | 0x6;
      expect(decode(bt >>> 0)).toEqual({ op: 'BT', src: 3, offset: 10 });
      expect(decode(bf >>> 0)).toEqual({ op: 'BF', src: 3, offset: 10 });
    });
  });
});
