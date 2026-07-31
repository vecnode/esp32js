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
 *     SLL, SRL, SRA, SRC, SLLI, SRAI, SRLI, SSR, SSL, SSAI, RSIL, RFI, RFE,
 *     RSR/WSR (PS and INTENABLE only), and the single-precision FPU subset
 *     ADD.S, SUB.S, MUL.S, MOV.S, NEG.S, ABS.S, WFR, RFR, FLOAT.S, UFLOAT.S,
 *     TRUNC.S, UTRUNC.S, OEQ.S, OLT.S, OLE.S, UN.S, BT, BF (see cpu/fpu.ts).
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
  | { op: 'ADDX2' | 'ADDX4' | 'ADDX8' | 'SUBX2' | 'SUBX4' | 'SUBX8'; dest: number; src1: number; src2: number }
  | { op: 'AND' | 'OR' | 'XOR'; dest: number; src1: number; src2: number }
  | { op: 'NEG' | 'ABS'; dest: number; src: number }
  | { op: 'NSA' | 'NSAU'; dest: number; src: number }
  | { op: 'MULL'; dest: number; src1: number; src2: number }
  | { op: 'MULUH' | 'MULSH'; dest: number; src1: number; src2: number }
  | { op: 'QUOU' | 'QUOS' | 'REMU' | 'REMS'; dest: number; src1: number; src2: number }
  | { op: 'ADDI'; dest: number; src: number; imm: number }
  | { op: 'MOV'; dest: number; src: number }
  | { op: 'MOVI'; dest: number; imm: number }
  | { op: 'SLL' | 'SRL' | 'SRA'; dest: number; src: number } // shift amount comes from SAR
  | { op: 'SRC'; dest: number; src1: number; src2: number } // funnel shift, also from SAR
  | { op: 'SLLI' | 'SRAI' | 'SRLI'; dest: number; src: number; shift: number }
  | { op: 'EXTUI'; dest: number; src: number; shift: number; mask: number }
  | { op: 'SSR' | 'SSL'; src: number }
  | { op: 'SSAI'; shift: number }
  | { op: 'L32I'; dest: number; base: number; offset: number }
  | { op: 'S32I'; src: number; base: number; offset: number }
  | { op: 'L8UI' | 'L16UI' | 'L16SI'; dest: number; base: number; offset: number }
  | { op: 'S8I' | 'S16I'; src: number; base: number; offset: number }
  | { op: 'L32R'; dest: number; offset: number }
  | { op: 'L32E'; dest: number; base: number; offset: number }
  | { op: 'S32E'; src: number; base: number; offset: number }
  | { op: 'J'; offset: number }
  | { op: 'BEQ' | 'BNE' | 'BLT' | 'BGE' | 'BLTU' | 'BGEU' | 'BNONE' | 'BALL' | 'BANY' | 'BNALL'; a: number; b: number; offset: number }
  | { op: 'BEQZ' | 'BNEZ' | 'BLTZ' | 'BGEZ'; a: number; offset: number }
  | { op: 'BEQI' | 'BNEI' | 'BLTI' | 'BGEI' | 'BLTUI' | 'BGEUI'; a: number; b4index: number; offset: number }
  | { op: 'BBCI' | 'BBSI'; src: number; bit: number; offset: number }
  | { op: 'CALL0'; offset: number }
  | { op: 'CALLN'; callinc: 1 | 2 | 3; offset: number }
  | { op: 'CALLX0'; target: number }
  | { op: 'CALLXN'; callinc: 1 | 2 | 3; target: number }
  | { op: 'ENTRY'; s: number; imm: number }
  | { op: 'RET' }
  | { op: 'RETW' }
  | { op: 'RFWO' }
  | { op: 'RFWU' }
  | { op: 'RSIL'; dest: number; level: number }
  | { op: 'RFI'; level: number }
  | { op: 'RFE' }
  | { op: 'RSR' | 'WSR'; sr: number; reg: number }
  | { op: 'MOVEQZ' | 'MOVNEZ' | 'MOVLTZ' | 'MOVGEZ'; dest: number; src: number; cond: number }
  | { op: 'ADD_S' | 'SUB_S' | 'MUL_S'; dest: number; src1: number; src2: number }
  | { op: 'MOV_S' | 'NEG_S' | 'ABS_S'; dest: number; src: number }
  | { op: 'WFR' | 'RFR'; dest: number; src: number }
  | { op: 'FLOAT_S' | 'UFLOAT_S' | 'TRUNC_S' | 'UTRUNC_S'; dest: number; src: number; scale: number }
  | { op: 'OEQ_S' | 'OLT_S' | 'OLE_S' | 'UN_S'; dest: number; src1: number; src2: number }
  | { op: 'BT' | 'BF'; src: number; offset: number };

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
        // ADDX2/4/8, SUBX2/4/8: same dest=r/src1=s/src2=t shape as ADD/SUB
        // above, computing dest = (src1<<n)+/-src2 - real hardware's own
        // scaled-index-arithmetic op (array indexing: base + index*elemSize
        // in one instruction). op2 continues ADD/SUB's own 8/c base values
        // by 1/2/3 for the x2/x4/x8 scale, a real, clean, evenly-spaced
        // sequence confirmed against several real compiled addx4/subx2/
        // subx4/subx8 examples (addx2/addx8 extended from the same
        // sequence, not independently seen yet, but the pattern is exact
        // and well-documented enough elsewhere to trust here).
        if (op2 === 0x9) return { op: 'ADDX2', dest: r, src1: s, src2: t };
        if (op2 === 0xa) return { op: 'ADDX4', dest: r, src1: s, src2: t };
        if (op2 === 0xb) return { op: 'ADDX8', dest: r, src1: s, src2: t };
        if (op2 === 0xd) return { op: 'SUBX2', dest: r, src1: s, src2: t };
        if (op2 === 0xe) return { op: 'SUBX4', dest: r, src1: s, src2: t };
        if (op2 === 0xf) return { op: 'SUBX8', dest: r, src1: s, src2: t };
        if (op2 === 0x0) {
          // RET/RETW: r=0, t=8/9 (m=2,n=0/1 per the generated decode tree).
          // CALLX0/CALLX4/CALLX8/CALLX12 (indirect windowed call, target in
          // register s) share this same r=0 slot, distinguished by t=0xC-0xF
          // (t = 0xC | callinc, callinc 0-3 selecting the 0/4/8/12 window
          // increment - the same increment CALLN's own "n" prefix selects
          // for the PC-relative form). This repo's own header comment
          // already documented CALLN's PC-relative form as covered; the
          // indirect form (used, among other things, for every call through
          // a function pointer or into a ROM routine loaded via L32R - i.e.
          // exactly how ESP-IDF's own startup code reaches its handful of
          // real Espressif mask-ROM calls) was missing entirely until now,
          // silently decoding as ILLEGAL and faulting the very first time
          // any compiled program actually used one.
          if (r === 0x0) {
            if (t === 0x8) return { op: 'RET' };
            if (t === 0x9) return { op: 'RETW' };
            if (t === 0xc) return { op: 'CALLX0', target: s };
            if (t >= 0xd && t <= 0xf) return { op: 'CALLXN', callinc: (t & 0x3) as 1 | 2 | 3, target: s };
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
          // BREAK (r=4, s/t are the two literal break-code immediates, not
          // registers - "break 1,0" is exactly what ESP-IDF's own
          // _xt_kernel_exc/_xt_panic entry points open with) - real
          // hardware only actually traps into a debugger if one is
          // attached via the OCD module; with none attached (this repo
          // models no debug/OCD unit at all, the same "not modeled, not
          // faked" posture as cache/MMU), BREAK is architecturally a
          // no-op that just falls through to the next instruction. Found
          // by tracing a real double-fault all the way back to its actual
          // origin: every single exception this repo raised (divide-by-
          // zero, illegal instruction, anything) correctly reached ESP-
          // IDF's own real exception handler, which itself opens with
          // this BREAK - meaning this one gap was silently turning every
          // real exception into an immediate double-fault, masking
          // whatever the original exception actually was.
          if (r === 0x4) return { op: 'NOP' };
          // r=2: memory/pipeline ordering family (ISYNC/RSYNC/ESYNC/DSYNC/
          // EXCW/MEMW/EXTW, selected by t) - real hardware distinguishes
          // these for pipeline/cache reordering guarantees; a sequential
          // single-instruction-at-a-time interpreter like this one has no
          // reordering to guard against in the first place, so all of them
          // decode to the same no-op tag. MEMW specifically (t=0xc) is the
          // one actually needed so far - real, common, unremarkable code
          // (e.g. right after a register write feeding a peripheral,
          // ESP-IDF's own rtc_vddsdio_get_config()) uses it constantly;
          // decoding it as ILLEGAL faulted on some of the most ordinary
          // compiled code there is, not anything exotic.
          if (r === 0x2) return { op: 'NOP' };
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
        // MULUH/MULSH (32x32->64 multiply, upper 32 bits) - confirmed
        // against real compiled muluh/mulsh examples, filling the two
        // op2 slots this family otherwise leaves free between MULL(8) and
        // QUOU(0xc).
        if (op2 === 0xa) return { op: 'MULUH', dest: r, src1: s, src2: t };
        if (op2 === 0xb) return { op: 'MULSH', dest: r, src1: s, src2: t };
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
      if (op1 === 0x4 || op1 === 0x5) {
        // EXTUI (extract unsigned bit field): dest=r, src=t (opposite of
        // most RRR ops, where t is usually the dest) - shiftimm is a 5-bit
        // value split across op1's own LSB (its high bit) and s (its low
        // 4 bits), maskimm is op2+1 (op2 is only 4 bits, encoding widths
        // 1-16, never 0). Solved empirically against half a dozen examples
        // pulled from a real compiled binary (shift/mask/dest/src all
        // cross-checked against objdump's own disassembly of each one,
        // not derived from a single example or guessed from partial
        // documentation) after finding this instruction entirely
        // unimplemented - a very ordinary bitfield-extraction op (register
        // field reads, struct bitfields), not something exotic.
        const shift = ((op1 & 0x1) << 4) | s;
        const mask = op2 + 1;
        return { op: 'EXTUI', dest: r, src: t, shift, mask };
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
        // MOVEQZ/MOVNEZ/MOVLTZ/MOVGEZ (conditional move): dest=r, the
        // value moved on a true condition=s, the register tested=t -
        // solved against several real compiled moveqz/movnez examples
        // (MOVLTZ/MOVGEZ's op2 values follow the exact same op2=8..11
        // sequence real Xtensa docs give the whole family, extended here
        // by pattern rather than independently confirmed against an
        // example, unlike every other opcode this class newly added).
        if (op2 === 0x8) return { op: 'MOVEQZ', dest: r, src: s, cond: t };
        if (op2 === 0x9) return { op: 'MOVNEZ', dest: r, src: s, cond: t };
        if (op2 === 0xa) return { op: 'MOVLTZ', dest: r, src: s, cond: t };
        if (op2 === 0xb) return { op: 'MOVGEZ', dest: r, src: s, cond: t };
      }
      if (op1 === 0xa) {
        // FP1 (single-precision arithmetic/conversion) family: r/s/t are
        // FR (float) or AR (int) registers depending on the opcode - see
        // cpu/fpu.ts's doc comment for exactly which. op2=0xf's t field
        // further disambiguates a "move/bit-move" cluster the same way
        // op1=0x0's r/s fields disambiguate RET/RSIL/RFI/etc above.
        if (op2 === 0x0) return { op: 'ADD_S', dest: r, src1: s, src2: t };
        if (op2 === 0x1) return { op: 'SUB_S', dest: r, src1: s, src2: t };
        if (op2 === 0x2) return { op: 'MUL_S', dest: r, src1: s, src2: t };
        if (op2 === 0x9) return { op: 'TRUNC_S', dest: r, src: s, scale: t };
        if (op2 === 0xc) return { op: 'FLOAT_S', dest: r, src: s, scale: t };
        if (op2 === 0xd) return { op: 'UFLOAT_S', dest: r, src: s, scale: t };
        if (op2 === 0xe) return { op: 'UTRUNC_S', dest: r, src: s, scale: t };
        if (op2 === 0xf) {
          if (t === 0x0) return { op: 'MOV_S', dest: r, src: s };
          if (t === 0x1) return { op: 'ABS_S', dest: r, src: s };
          if (t === 0x4) return { op: 'RFR', dest: r, src: s };
          if (t === 0x5) return { op: 'WFR', dest: r, src: s };
          if (t === 0x6) return { op: 'NEG_S', dest: r, src: s };
        }
      }
      if (op1 === 0xb) {
        // FP2 (single-precision compare) family: dest is a BR (boolean
        // register) index, src1/src2 are FR registers.
        if (op2 === 0x1) return { op: 'UN_S', dest: r, src1: s, src2: t };
        if (op2 === 0x2) return { op: 'OEQ_S', dest: r, src1: s, src2: t };
        if (op2 === 0x4) return { op: 'OLT_S', dest: r, src1: s, src2: t };
        if (op2 === 0x6) return { op: 'OLE_S', dest: r, src1: s, src2: t };
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
      // L8UI/L16UI/L16SI/S8I/S16I: same shape as L32I/S32I above, just a
      // narrower (byte/half-word) memory access - L8UI/S8I's offset is the
      // raw imm8 (no scaling, matching L32I doc), L16UI/L16SI/S16I's is
      // imm8*2 (confirmed against real l8ui/l16ui examples pulled from a
      // compiled binary; S8I/S16I extended from the exact same r-value
      // sequence real Xtensa docs give this whole family, not
      // independently confirmed against an example the way the loads are).
      if (r === 0x0) return { op: 'L8UI', dest: t, base: s, offset: imm8 };
      if (r === 0x1) return { op: 'L16UI', dest: t, base: s, offset: imm8 << 1 };
      if (r === 0x9) return { op: 'L16SI', dest: t, base: s, offset: imm8 << 1 };
      if (r === 0x4) return { op: 'S8I', src: t, base: s, offset: imm8 };
      if (r === 0x5) return { op: 'S16I', src: t, base: s, offset: imm8 << 1 };
      break;

    case 0x5: { // CALL0/CALL4/CALL8/CALL12, selected by n; offset in units of 4
      const off18 = (word >>> 6) & 0x3ffff;
      const offset = sext(off18, 18) * 4;
      if (n === 0) return { op: 'CALL0', offset };
      return { op: 'CALLN', callinc: n as 1 | 2 | 3, offset };
    }

    case 0x6: // J (n=0); BEQZ/etc (n=1); BEQI/etc (n=2); ENTRY/BT-BF/BLTUI/BGEUI (n=3)
      if (n === 0) {
        const off18 = (word >>> 6) & 0x3ffff;
        return { op: 'J', offset: sext(off18, 18) };
      }
      if (n === 1) {
        // BEQZ/BNEZ/BLTZ/BGEZ ("BZ" format): s = the compared register, m
        // selects the condition (0..3, same EQ/NE/LT/GE order as n=2's own
        // BEQI/BNEI/BLTI/BGEI below - the two families share this ordering
        // throughout the real ISA), offset is a 12-bit signed immediate
        // (not imm8 - this family's own displacement field is wider).
        // Previously entirely undecoded (this class's own type already
        // existed, and cpu.ts already had a real BEQZ/BNEZ execute case
        // for it, but nothing ever produced one) - found by tracing a real
        // compiled binary into a plain, ordinary `bnez a10, ...` bounds
        // check and watching it fall through to ILLEGAL.
        const offset = sext(imm12, 12);
        const ops = ['BEQZ', 'BNEZ', 'BLTZ', 'BGEZ'] as const;
        return { op: ops[m]!, a: s, offset };
      }
      if (n === 2) {
        // BEQI/BNEI/BLTI/BGEI ("BRI12"-ish immediate-compare family, m
        // selects the condition): s = the compared register, r = an index
        // into the b4const table (cpu.ts) rather than a raw immediate -
        // real hardware picks from {-1,1,2,3,4,5,6,7,8,10,12,16,32,64,128,
        // 256} instead of encoding an arbitrary signed value, since these
        // are meant for common small-constant comparisons a compiler emits
        // constantly (loop bounds, small enum/flag checks) - confirmed
        // against a real compiled binary's own beqi/bnei/blti/bgei uses,
        // matching this m-assignment and the table's values exactly for
        // every one of them, not just one example.
        const offset = sext(imm8, 8);
        const ops = ['BEQI', 'BNEI', 'BLTI', 'BGEI'] as const;
        return { op: ops[m]!, a: s, b4index: r, offset };
      }
      if (n === 3 && m === 0) {
        // ENTRY: s = bits[11:8] (must be a0-a3 on real hardware), imm = bits[23:12] * 8
        return { op: 'ENTRY', s, imm: imm12 << 3 };
      }
      if (n === 3 && m === 1) {
        // BT/BF (branch on a BR boolean register): s = bs (the BR index),
        // r selects BT (1) vs BF (0), imm8 = signed displacement - same
        // shape as the op0=0x7 BRI8 family, just living under op0=0x6's
        // n=3,m=1 slot instead (Opcode_bt/bf_Slot_inst_encode in
        // xtensa-modules.inc.c: base encoding 0x001076/0x000076).
        return { op: r === 0x1 ? 'BT' : 'BF', src: s, offset: sext(imm8, 8) };
      }
      if (n === 3 && (m === 2 || m === 3)) {
        // BLTUI/BGEUI: same shape as BEQI/etc above, but comparing against
        // the b4constu table (unsigned) instead of b4const (signed) - real
        // hardware fills the two slots that wouldn't make sense unsigned
        // (b4const's -1 and 1) with 32768 and 65536 instead, real values
        // used by real compiler idioms (b4constu[0]=32768 tests a value's
        // sign bit when reinterpreted as unsigned, b4constu[1]=65536 tests
        // for anything beyond 16 bits) - completing op0=6's n=3 slot
        // exactly (m=0 ENTRY, m=1 BT/BF, m=2/3 here), confirmed against a
        // real compiled binary's own bltui/bgeui uses.
        const offset = sext(imm8, 8);
        return { op: m === 2 ? 'BLTUI' : 'BGEUI', a: s, b4index: r, offset };
      }
      break;

    case 0x7: { // BRI8 conditional branches: r selects condition, imm8 = signed displacement
      const offset = sext(imm8, 8);
      if (r === 0x1) return { op: 'BEQ', a: s, b: t, offset };
      if (r === 0x9) return { op: 'BNE', a: s, b: t, offset };
      if (r === 0x2) return { op: 'BLT', a: s, b: t, offset };
      if (r === 0xa) return { op: 'BGE', a: s, b: t, offset };
      // BLTU/BGEU: unsigned register-vs-register counterparts to BLT/BGE,
      // continuing this family's own r-value sequence (confirmed against
      // several real compiled bltu/bgeu examples) - previously only the
      // immediate-vs-constant forms (BLTUI/BGEUI) existed.
      if (r === 0x3) return { op: 'BLTU', a: s, b: t, offset };
      if (r === 0xb) return { op: 'BGEU', a: s, b: t, offset };
      // BNONE/BALL/BANY/BNALL (bitwise mask test branches), evenly spaced
      // by 4 in this family's own r sequence - confirmed against several
      // real compiled examples of each.
      if (r === 0x0) return { op: 'BNONE', a: s, b: t, offset };
      if (r === 0x4) return { op: 'BALL', a: s, b: t, offset };
      if (r === 0x8) return { op: 'BANY', a: s, b: t, offset };
      if (r === 0xc) return { op: 'BNALL', a: s, b: t, offset };
      if ((r & 0x6) === 0x6) {
        // BBCI/BBSI (branch if bit clear/set immediate): r's bits[2:1] are
        // fixed "11" (this family's own identifying bits, checked above),
        // bit3 selects BBCI(0)/BBSI(1), and bit0 supplies the bit index's
        // 5th bit (bitindex = t | ((r&1)<<4), t alone only reaching 0-15) -
        // solved empirically against 6 real examples pulled from a compiled
        // binary (3 BBCI, 2 BBSI, one deliberately with a small in-range
        // index to rule out the low-4-bits-only case), not derived from a
        // single example or guessed from partial memory of the ISA.
        const bit = t | ((r & 0x1) << 4);
        return { op: (r >>> 3) & 0x1 ? 'BBSI' : 'BBCI', src: s, bit, offset };
      }
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
