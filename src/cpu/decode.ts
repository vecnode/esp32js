/**
 * Xtensa LX6 instruction decode.
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
 * Covers both instruction widths:
 *   - 24-bit ("wide"): ADD, SUB, ADDI, AND, OR, XOR, NEG, ABS, NSA, NSAU,
 *     MULL, QUOU, QUOS, REMU, REMS, MOVI, L32I, S32I, L32R, L32E, S32E, J,
 *     BEQ, BNE, BLT, BGE, CALL0, CALL4/8/12, ENTRY, RET, RETW, RFWO, RFWU,
 *     SLL, SRL, SRA, SRC, SLLI, SRAI, SRLI, SSR, SSL, SSAI, RSIL, RFI,
 *     RSR/WSR (PS and INTENABLE only).
 *   - 16-bit ("density"/".N"): ADD.N, ADDI.N, L32I.N, S32I.N, MOVI.N,
 *     BEQZ.N, BNEZ.N, MOV.N, RET.N, RETW.N, NOP.N.
 * Anything else decodes to ILLEGAL - the opcode table matches translate.c's
 * 7672 lines only in the slice this milestone needs; full coverage is a
 * follow-on per ARCHITECTURE.md.
 *
 * Density support is not optional polish: GCC's `-mdensity` (the default
 * for Xtensa targets, including ESP-IDF's toolchain) emits 16-bit
 * instructions throughout ordinary compiled code. Decoding only the 24-bit
 * set would misdecode real firmware from essentially its first instruction
 * onward. Instruction width is determined by op0 alone (bits[3:0] of the
 * first byte): op0 in [0x8,0xd] is a 16-bit instruction (see
 * `instructionLength` below and the `Slot_inst16a_decode`/
 * `Slot_inst16b_decode` split in xtensa-modules.inc.c); the fields
 * themselves reuse the same low-16-bit positions as their 24-bit
 * counterparts, so the same `t`/`s`/`r` extraction works for both widths -
 * only the top byte (bits[23:16], irrelevant to a 2-byte instruction) is
 * arbitrary garbage that must not be read for these opcodes, and isn't.
 *
 * Several `.N` opcodes are semantically identical to a 24-bit counterpart
 * (ADD.N/ADD, L32I.N/L32I, S32I.N/S32I, MOVI.N/MOVI, RET.N/RET,
 * RETW.N/RETW) and decode to that same `Decoded` tag - `cpu.ts` doesn't
 * need to know which encoding produced it.
 *
 * op0=0x5 (CALL0/CALL4/8/12) and op0=0x6 (J/ENTRY/BEQZ/.../LOOP/...) each
 * share one 4-bit op0 with several unrelated instructions, disambiguated by
 * a `n` field at bits[5:4] (and, for op0=0x6's non-J members, a further `m`
 * field at bits[7:6]) - see the generated decode tree around
 * `Field_op0_Slot_inst_get (insn) == 6` in xtensa-modules.inc.c. Getting `n`
 * wrong here silently misdecodes ENTRY/BEQZ/etc. as J, so it's checked
 * explicitly rather than inferred from op0 alone. (That 24-bit BEQZ family
 * is distinct from - and not to be confused with - the 16-bit BEQZ.N
 * covered here, which lives entirely under op0=0xc instead.)
 */

export type Decoded =
  | { op: 'ILLEGAL'; word: number }
  | { op: 'NOP' }
  | { op: 'ADD'; dest: number; src1: number; src2: number }
  | { op: 'SUB'; dest: number; src1: number; src2: number }
  | { op: 'AND' | 'OR' | 'XOR'; dest: number; src1: number; src2: number }
  | { op: 'NEG' | 'ABS'; dest: number; src: number }
  | { op: 'NSA' | 'NSAU'; dest: number; src: number }
  | { op: 'MULL'; dest: number; src1: number; src2: number }
  | { op: 'QUOU' | 'QUOS' | 'REMU' | 'REMS'; dest: number; src1: number; src2: number }
  | { op: 'ADDI'; dest: number; src: number; imm: number }
  | { op: 'MOV'; dest: number; src: number }
  | { op: 'MOVI'; dest: number; imm: number }
  | { op: 'SLL' | 'SRL' | 'SRA'; dest: number; src: number } // shift amount comes from SAR
  | { op: 'SRC'; dest: number; src1: number; src2: number } // funnel shift, also from SAR
  | { op: 'SLLI' | 'SRAI' | 'SRLI'; dest: number; src: number; shift: number }
  | { op: 'SSR' | 'SSL'; src: number }
  | { op: 'SSAI'; shift: number }
  | { op: 'L32I'; dest: number; base: number; offset: number }
  | { op: 'S32I'; src: number; base: number; offset: number }
  | { op: 'L32R'; dest: number; offset: number }
  | { op: 'L32E'; dest: number; base: number; offset: number }
  | { op: 'S32E'; src: number; base: number; offset: number }
  | { op: 'J'; offset: number }
  | { op: 'BEQ' | 'BNE' | 'BLT' | 'BGE'; a: number; b: number; offset: number }
  | { op: 'BEQZ' | 'BNEZ'; a: number; offset: number }
  | { op: 'CALL0'; offset: number }
  | { op: 'CALLN'; callinc: 1 | 2 | 3; offset: number }
  | { op: 'ENTRY'; s: number; imm: number }
  | { op: 'RET' }
  | { op: 'RETW' }
  | { op: 'RFWO' }
  | { op: 'RFWU' }
  | { op: 'RSIL'; dest: number; level: number }
  | { op: 'RFI'; level: number }
  | { op: 'RFE' }
  | { op: 'RSR' | 'WSR'; sr: number; reg: number };

/** Sign-extend the low `bits` bits of `value` to a 32-bit signed int. */
function sext(value: number, bits: number): number {
  const shift = 32 - bits;
  return (value << shift) >> shift;
}

/**
 * Byte length of the instruction whose first byte(s) are encoded in `word`.
 * Only op0 (bits[3:0]) matters: 0x8-0xd are the 16-bit density formats
 * (instr16a/instr16b in xtensa-modules.inc.c), everything else is 24-bit.
 * Callers should fetch 3 bytes regardless (cheaper than fetching 2, probing
 * op0, and maybe fetching a 3rd) and just ignore the unused top byte for a
 * 2-byte result.
 */
export function instructionLength(word: number): 2 | 3 {
  const op0 = word & 0xf;
  return op0 >= 0x8 && op0 <= 0xd ? 2 : 3;
}

/**
 * Decode one instruction word (3 bytes fetched little-endian; the top byte
 * is ignored for 16-bit instructions - see `instructionLength`). Field
 * positions, from `Field_{op0,t,s,r,imm8,imm16,n,m}_Slot_inst_get` (24-bit)
 * and `Field_{op0,t,s,r,i,z,imm6,imm7}_Slot_inst16{a,b}_get` (16-bit, same
 * low-bit positions as their 24-bit counterparts):
 *   op0 = bits[3:0], n = bits[5:4], m = bits[7:6] (t = bits[7:4] = m<<2|n,
 *   two equivalent views of the same nibble), s = bits[11:8], r = bits[15:12],
 *   op1 = bits[19:16], op2 = bits[23:20], imm8 = bits[23:16] (whole top byte).
 *   16-bit-only: i = bit[7], z = bit[6].
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
        // ADD/SUB/AND/OR/XOR: op2 selects, r/s/t = dest/src1/src2
        if (op2 === 0x8) return { op: 'ADD', dest: r, src1: s, src2: t };
        if (op2 === 0xc) return { op: 'SUB', dest: r, src1: s, src2: t };
        if (op2 === 0x1) return { op: 'AND', dest: r, src1: s, src2: t };
        if (op2 === 0x2) return { op: 'OR', dest: r, src1: s, src2: t };
        if (op2 === 0x3) return { op: 'XOR', dest: r, src1: s, src2: t };
        if (op2 === 0x6) {
          // NEG/ABS share r=dest, t=src; s is a fixed 0/1 selector, not a register.
          if (s === 0x0) return { op: 'NEG', dest: r, src: t };
          if (s === 0x1) return { op: 'ABS', dest: r, src: t };
        }
        if (op2 === 0x0) {
          // RET/RETW: r=0, t=8/9 (m=2,n=0/1 per the generated decode tree)
          if (r === 0x0) {
            if (t === 0x8) return { op: 'RET' };
            if (t === 0x9) return { op: 'RETW' };
          }
          // RSIL: r=6 (fixed), dest=t, level=s (immediate 0-15)
          if (r === 0x6) return { op: 'RSIL', dest: t, level: s };
          // r=3 family: t=0 -> RFE(s=0)/RFWO(s=4)/RFWU(s=5); t=1 -> RFI (level=s)
          if (r === 0x3) {
            if (t === 0x0) {
              if (s === 0x0) return { op: 'RFE' };
              if (s === 0x4) return { op: 'RFWO' };
              if (s === 0x5) return { op: 'RFWU' };
            }
            if (t === 0x1) return { op: 'RFI', level: s };
          }
        }
        if (op2 === 0x4) {
          // SSR/SSL: r=0/1 selects, src register = s. SSAI: r=4 (fixed), shift
          // is a composite of t's LSB (bit4) and s (bits[11:8]) - identity,
          // no further transform (OperandSem_opnd_sem_bbi_decode).
          if (r === 0x0) return { op: 'SSR', src: s };
          if (r === 0x1) return { op: 'SSL', src: s };
          if (r === 0x4) return { op: 'SSAI', shift: ((t & 0x1) << 4) | s };
          // NSA/NSAU: r=0xe/0xf (fixed), dest=t, src=s (r is not a register here).
          if (r === 0xe) return { op: 'NSA', dest: t, src: s };
          if (r === 0xf) return { op: 'NSAU', dest: t, src: s };
        }
      }
      if (op1 === 0x2) {
        // MULL (32x32->32 multiply) and the div32 family: r=dest, s=src1, t=src2.
        if (op2 === 0x8) return { op: 'MULL', dest: r, src1: s, src2: t };
        if (op2 === 0xc) return { op: 'QUOU', dest: r, src1: s, src2: t };
        if (op2 === 0xd) return { op: 'QUOS', dest: r, src1: s, src2: t };
        if (op2 === 0xe) return { op: 'REMU', dest: r, src1: s, src2: t };
        if (op2 === 0xf) return { op: 'REMS', dest: r, src1: s, src2: t };
      }
      if (op1 === 0x1) {
        // Shifts: op2 selects. SLLI/SRAI's op2 LSB doubles as the shift
        // amount's high bit (Field_sal/Field_sargt composite with bit[20],
        // i.e. op2's own LSB) - see Opcode_slli/srai base encodings
        // (0x010000/0x210000) and their Field_sal/Field_sargt getters.
        if (op2 === 0xa) return { op: 'SLL', dest: r, src: s };
        if (op2 === 0x9) return { op: 'SRL', dest: r, src: t };
        if (op2 === 0xb) return { op: 'SRA', dest: r, src: t };
        if (op2 === 0x8) return { op: 'SRC', dest: r, src1: s, src2: t };
        if (op2 === 0x4) return { op: 'SRLI', dest: r, src: t, shift: s };
        if (op2 === 0x0 || op2 === 0x1) {
          const salRaw = ((op2 & 0x1) << 4) | t;
          return { op: 'SLLI', dest: r, src: s, shift: (0x20 - salRaw) & 0x1f };
        }
        if (op2 === 0x2 || op2 === 0x3) {
          return { op: 'SRAI', dest: r, src: t, shift: ((op2 & 0x1) << 4) | s };
        }
      }
      if (op1 === 0x9) {
        // L32E/S32E: r = immrx4 (4-bit magnitude, always a negative x4 offset)
        const offset = ((0xfffffff0 | r) << 2) | 0;
        if (op2 === 0x0) return { op: 'L32E', dest: t, base: s, offset };
        if (op2 === 0x4) return { op: 'S32E', src: t, base: s, offset };
      }
      if (op1 === 0x3) {
        // RSR/WSR: op2 selects (0=RSR, 1=WSR); the special-register number
        // is (r<<4)|s (e.g. PS=0xE6=230, INTENABLE=0xE4=228 - each named
        // SR gets its own opcode in the reference, but they all share this
        // same field layout, so decoding the SR number generically and
        // letting cpu.ts decide which ones it backs is simpler than one
        // Decoded variant per register name).
        const sr = (r << 4) | s;
        if (op2 === 0x0) return { op: 'RSR', sr, reg: t };
        if (op2 === 0x1) return { op: 'WSR', sr, reg: t };
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
      if (r === 0xc) return { op: 'ADDI', dest: t, src: s, imm: sext(imm8, 8) };
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

    // --- 16-bit density ("instr16a") formats: op0 selects the opcode outright ---
    case 0x8: // L32I.N: same semantics as L32I, offset = r (lsi4x4 field) * 4
      return { op: 'L32I', dest: t, base: s, offset: r << 2 };
    case 0x9: // S32I.N
      return { op: 'S32I', src: t, base: s, offset: r << 2 };
    case 0xa: // ADD.N: same semantics as ADD
      return { op: 'ADD', dest: r, src1: s, src2: t };
    case 0xb: { // ADDI.N: imm (ai4const, field t) is 1-15 literal, or -1 when the field is 0
      const imm = t === 0 ? -1 : t;
      return { op: 'ADDI', dest: r, src: s, imm };
    }

    // --- 16-bit density ("instr16b") formats: op0=0xc/0xd, further split by i/z or r/t ---
    case 0xc: {
      const i = (word >>> 7) & 0x1;
      if (i === 0) {
        // MOVI.N: dest = s (not t!); imm7 = {hi:bits[6:4], lo:bits[15:12]=r},
        // sign-extended only when both of imm7's top two bits are set
        // (OperandSem_opnd_sem_simm7_decode) - an asymmetric -32..95 range,
        // not a plain signed 7-bit field.
        const hi = (word >>> 4) & 0x7;
        const raw7 = (hi << 4) | r;
        const bit6 = (raw7 >>> 6) & 1;
        const bit5 = (raw7 >>> 5) & 1;
        const imm = ((bit6 & bit5 ? 0xffffff80 : 0) | raw7) | 0;
        return { op: 'MOVI', dest: s, imm };
      }
      // BEQZ.N/BNEZ.N: z selects, imm6 = {hi:bits[5:4], lo:bits[15:12]=r}
      const z = (word >>> 6) & 0x1;
      const hi6 = (word >>> 4) & 0x3;
      const offset = (hi6 << 4) | r;
      return z === 0 ? { op: 'BEQZ', a: s, offset } : { op: 'BNEZ', a: s, offset };
    }
    case 0xd:
      if (r === 0x0) return { op: 'MOV', dest: t, src: s }; // MOV.N
      if (r === 0xf) {
        if (t === 0x0) return { op: 'RET' }; // RET.N
        if (t === 0x1) return { op: 'RETW' }; // RETW.N
        if (t === 0x3 && s === 0x0) return { op: 'NOP' }; // NOP.N
        // t=2 (BREAK.N) and t=6,s=0 (ILL.N) intentionally fall through to ILLEGAL below.
      }
      break;

    default:
      break;
  }

  return { op: 'ILLEGAL', word };
}
