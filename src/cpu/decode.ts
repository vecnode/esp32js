/**
 * Xtensa LX6 instruction decode - narrow (24-bit) opcode set only.
 *
 * Bit layouts and immediate-reconstruction formulas are taken from this
 * repo's own QEMU source at the commit before the TypeScript rewrite
 * (`target/xtensa/core-esp32/xtensa-modules.inc.c`, generated opcode field
 * tables; `target/xtensa/translate.c`, translate_* semantics) - not
 * reconstructed from general Xtensa documentation. PC-relative operands
 * (L32R/J/CALL0/CALLN/branches) return the *relative* displacement only; the
 * caller (cpu.ts) combines it with PC, matching the reference's own split
 * between decode-time `xtensa_operand_decode` and `xtensa_operand_undo_reloc`.
 *
 * Covers: ADD, SUB, MOVI, L32I, S32I, L32R, L32E, S32E, J, BEQ, BNE, BLT,
 * BGE, CALL0, CALL4/8/12, ENTRY, RET, RETW, RFWO, RFWU. Anything else decodes
 * to ILLEGAL - the opcode table matches translate.c's 7672 lines only in the
 * slice this milestone needs; full coverage is a follow-on per
 * ARCHITECTURE.md.
 *
 * op0=0x5 (CALL0/CALL4/8/12) and op0=0x6 (J/ENTRY/BEQZ/.../LOOP/...) each
 * share one 4-bit op0 with several unrelated instructions, disambiguated by
 * a `n` field at bits[5:4] (and, for op0=0x6's non-J members, a further `m`
 * field at bits[7:6]) - see the generated decode tree around
 * `Field_op0_Slot_inst_get (insn) == 6` in xtensa-modules.inc.c. Getting `n`
 * wrong here silently misdecodes ENTRY/BEQZ/etc. as J, so it's checked
 * explicitly rather than inferred from op0 alone.
 */

export type Decoded =
  | { op: 'ILLEGAL'; word: number }
  | { op: 'ADD'; dest: number; src1: number; src2: number }
  | { op: 'SUB'; dest: number; src1: number; src2: number }
  | { op: 'MOVI'; dest: number; imm: number }
  | { op: 'L32I'; dest: number; base: number; offset: number }
  | { op: 'S32I'; src: number; base: number; offset: number }
  | { op: 'L32R'; dest: number; offset: number }
  | { op: 'L32E'; dest: number; base: number; offset: number }
  | { op: 'S32E'; src: number; base: number; offset: number }
  | { op: 'J'; offset: number }
  | { op: 'BEQ' | 'BNE' | 'BLT' | 'BGE'; a: number; b: number; offset: number }
  | { op: 'CALL0'; offset: number }
  | { op: 'CALLN'; callinc: 1 | 2 | 3; offset: number }
  | { op: 'ENTRY'; s: number; imm: number }
  | { op: 'RET' }
  | { op: 'RETW' }
  | { op: 'RFWO' }
  | { op: 'RFWU' };

/** Sign-extend the low `bits` bits of `value` to a 32-bit signed int. */
function sext(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/**
 * Decode one 24-bit instruction word (already fetched little-endian from
 * three consecutive bytes). Field positions, from
 * `Field_{op0,t,s,r,imm8,imm16,n,m}_Slot_inst_get`:
 *   op0 = bits[3:0], n = bits[5:4], m = bits[7:6] (t = bits[7:4] = m<<2|n,
 *   two equivalent views of the same nibble), s = bits[11:8], r = bits[15:12],
 *   op1 = bits[19:16], op2 = bits[23:20], imm8 = bits[23:16] (whole top byte).
 */
export function decode(word: number): Decoded {
  const op0 = word & 0xf;
  const t = (word >>> 4) & 0xf;
  const n = (word >>> 4) & 0x3;
  const m = (word >>> 6) & 0x3;
  const s = (word >>> 8) & 0xf;
  const r = (word >>> 12) & 0xf;
  const op1 = (word >>> 16) & 0xf;
  const op2 = (word >>> 20) & 0xf;
  const imm8 = (word >>> 16) & 0xff;
  const imm12 = (word >>> 12) & 0xfff;

  switch (op0) {
    case 0x0: // RRR arithmetic/"special" family
      if (op1 === 0x0) {
        // ADD/SUB: op2 selects, r/s/t = dest/src1/src2 (Opcode_add/sub base 0x8/0xC << 20)
        if (op2 === 0x8) return { op: 'ADD', dest: r, src1: s, src2: t };
        if (op2 === 0xc) return { op: 'SUB', dest: r, src1: s, src2: t };
        if (op2 === 0x0) {
          // RET/RETW: r=0, t=8/9 (m=2,n=0/1 per the generated decode tree)
          if (r === 0x0) {
            if (t === 0x8) return { op: 'RET' };
            if (t === 0x9) return { op: 'RETW' };
          }
          // RFWO/RFWU: r=3, t=0, s=4/5
          if (r === 0x3 && t === 0x0) {
            if (s === 0x4) return { op: 'RFWO' };
            if (s === 0x5) return { op: 'RFWU' };
          }
        }
      }
      if (op1 === 0x9) {
        // L32E/S32E: r = immrx4 (4-bit magnitude, always a negative x4 offset)
        const offset = ((0xfffffff0 | r) << 2) | 0;
        if (op2 === 0x0) return { op: 'L32E', dest: t, base: s, offset };
        if (op2 === 0x4) return { op: 'S32E', src: t, base: s, offset };
      }
      break;

    case 0x1: { // L32R (RI16): imm16 = bits[23:8], always a negative word-aligned offset
      const imm16 = (word >>> 8) & 0xffff;
      const offset = ((0xffff0000 | imm16) << 2) | 0;
      return { op: 'L32R', dest: t, offset };
    }

    case 0x2: // LSAI family: r selects sub-op, s = base reg, t = dest/src reg
      if (r === 0x2) return { op: 'L32I', dest: t, base: s, offset: imm8 << 2 };
      if (r === 0x6) return { op: 'S32I', src: t, base: s, offset: imm8 << 2 };
      if (r === 0xa) {
        // MOVI: 12-bit signed immediate reassembled from s (high nibble) + imm8 (low byte)
        const raw12 = ((s << 8) | imm8) & 0xfff;
        return { op: 'MOVI', dest: t, imm: sext(raw12, 12) };
      }
      break;

    case 0x5: { // CALL0/CALL4/CALL8/CALL12, selected by n; offset in units of 4
      const off18 = (word >>> 6) & 0x3ffff;
      const offset = sext(off18, 18) * 4;
      if (n === 0) return { op: 'CALL0', offset };
      return { op: 'CALLN', callinc: n as 1 | 2 | 3, offset };
    }

    case 0x6: // J (n=0), ENTRY (n=3,m=0); BEQZ/BNEZ/.../LOOP (n=1,2 or n=3,m!=0) not covered
      if (n === 0) {
        const off18 = (word >>> 6) & 0x3ffff;
        return { op: 'J', offset: sext(off18, 18) };
      }
      if (n === 3 && m === 0) {
        // ENTRY: s = bits[11:8] (must be a0-a3 on real hardware), imm = bits[23:12] * 8
        return { op: 'ENTRY', s, imm: imm12 << 3 };
      }
      break;

    case 0x7: { // BRI8 conditional branches: r selects condition, imm8 = signed displacement
      const offset = sext(imm8, 8);
      if (r === 0x1) return { op: 'BEQ', a: s, b: t, offset };
      if (r === 0x9) return { op: 'BNE', a: s, b: t, offset };
      if (r === 0x2) return { op: 'BLT', a: s, b: t, offset };
      if (r === 0xa) return { op: 'BGE', a: s, b: t, offset };
      break;
    }

    default:
      break;
  }

  return { op: 'ILLEGAL', word };
}
