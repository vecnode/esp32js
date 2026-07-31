/**
 * Xtensa LX6 FPU coprocessor state - single-precision only
 * (`XCHAL_HAVE_DFP=0`, so there's no FR/AR-pair-based double-precision path).
 *
 * Semantics are taken from this repo's own QEMU source at the pre-rewrite
 * commit (recoverable from git history at `cae84de99b^`):
 * `target/xtensa/fpu_helper.c`'s `itof_s`/`uitof_s`/`ftoi_s`/`ftoui_s`
 * (`float32_scalbn`-based scaling) and `target/xtensa/translate.c`'s
 * `translate_float_s`/`translate_ftoi_s`, which is the surprising bit worth
 * calling out explicitly rather than guessing from the opcode names alone:
 * FLOAT.S/UFLOAT.S negate their scale immediate before calling
 * itof_s/uitof_s (`scale = -imm`), while TRUNC.S/UTRUNC.S pass their
 * immediate straight through unnegated (`scale = imm`) - both feed the same
 * "multiply by 2^scale" operation, so the negation alone is what makes
 * FLOAT.S mean "integer / 2^imm" and TRUNC.S mean "float * 2^imm". The
 * immediate itself (`imm_t`, `OPERAND_imm_t` in xtensa-modules.inc.c) is a
 * plain unsigned 4-bit field (0-15), not sign-extended.
 *
 * TRUNC.S/UTRUNC.S round toward zero (`float_round_to_zero`, the reference's
 * own hardcoded `par[0]` for exactly these two opcodes, per their
 * `translate.c` opcode-table entries) - ROUND.S/CEIL.S/FLOOR.S, which use
 * the other three IEEE rounding modes, aren't implemented (see below).
 *
 * FR (float register file) is backed by one shared ArrayBuffer viewed as
 * both a Float32Array (arithmetic - ADD.S/SUB.S/MUL.S/MOV.S/NEG.S/ABS.S) and
 * a Uint32Array (WFR/RFR's raw bit-pattern move between an AR and FR
 * register - `translate_wfr_s`/`translate_rfr_s` just copy the 32-bit
 * pattern, no numeric conversion).
 *
 * BR (boolean register file) is modeled as a 16-bit bitmask rather than 16
 * separate fields - OEQ.S/OLT.S/OLE.S/UN.S each write one bit (their `dest`
 * operand), BT/BF each read one bit (their `src` operand).
 *
 * Not implemented, and why: MADD.S/MSUB.S (fused multiply-add/sub) and
 * ROUND.S/CEIL.S/FLOOR.S (the other three float-to-int rounding modes) -
 * outside this milestone's opcode list (ADD.S/SUB.S/MUL.S/MOV.S/NEG.S/
 * ABS.S/WFR/RFR/FLOAT.S/UFLOAT.S/TRUNC.S/UTRUNC.S/OEQ.S/OLT.S/OLE.S/UN.S/
 * BT/BF); MOVEQZ.S/MOVNEZ.S/MOVLTZ.S/MOVGEZ.S/MOVF.S/MOVT.S (conditional FP
 * moves) and UEQ.S/ULT.S/ULE.S (unordered-or-true compare variants - only
 * the ordered OEQ.S/OLT.S/OLE.S and UN.S itself are implemented); FCR/FSR
 * (rounding-mode-select and sticky-exception-flag user registers -
 * `env->fp_status`'s rounding mode and exception flags aren't modeled here,
 * so every op behaves as round-to-nearest-even with no flag tracking, same
 * as this repo not modeling EXCCAUSE as a register elsewhere); CPENABLE
 * gating (real hardware raises a coprocessor exception if the FPU is used
 * before CPENABLE enables it - not modeled, the same scope decision as this
 * repo's simplified PS register not carrying a full CPENABLE field).
 */

const NUM_FR = 16;

export class Fpu {
  private readonly buffer = new ArrayBuffer(NUM_FR * 4);
  private readonly f32 = new Float32Array(this.buffer);
  private readonly u32 = new Uint32Array(this.buffer);

  /** BR: one bit per boolean register (0-15) - see this file's doc comment. */
  br = 0;

  getFr(i: number): number {
    return this.f32[i]!;
  }

  setFr(i: number, value: number): void {
    this.f32[i] = value;
  }

  /** WFR: raw bit-pattern move from an AR value into FR[i] - no conversion. */
  writeFrBits(i: number, bits: number): void {
    this.u32[i] = bits >>> 0;
  }

  /** RFR: raw bit-pattern move from FR[i] out to an AR value - no conversion. */
  readFrBits(i: number): number {
    return this.u32[i]!;
  }

  getBr(i: number): boolean {
    return (this.br & (1 << i)) !== 0;
  }

  setBr(i: number, value: boolean): void {
    this.br = value ? this.br | (1 << i) : this.br & ~(1 << i);
  }
}

/** HELPER(itof_s): (int32)v scaled by 2^scale (`float32_scalbn`). */
export function itofS(v: number, scale: number): number {
  return Math.fround((v | 0) * Math.pow(2, scale));
}

/** HELPER(uitof_s): (uint32)v scaled by 2^scale. */
export function uitofS(v: number, scale: number): number {
  return Math.fround((v >>> 0) * Math.pow(2, scale));
}

/** HELPER(ftoi_s) with rounding_mode=float_round_to_zero (TRUNC.S): v scaled by 2^scale, truncated to int32. */
export function ftoiS(v: number, scale: number): number {
  return Math.trunc(v * Math.pow(2, scale)) | 0;
}

/** HELPER(ftoui_s) with rounding_mode=float_round_to_zero (UTRUNC.S): v scaled by 2^scale, truncated to uint32. */
export function ftouiS(v: number, scale: number): number {
  return Math.trunc(v * Math.pow(2, scale)) >>> 0;
}
