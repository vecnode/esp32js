/**
 * Fetch/execute loop for the narrow-opcode subset covered by decode.ts.
 *
 * PC-relative target formulas (J/CALL0/CALLN/L32R/branches) are taken from
 * this repo's own QEMU source at the pre-rewrite commit
 * (`Operand_{soffset,soffsetx4,uimm16x4,label8}_rtoa` in
 * `xtensa-modules.inc.c`), not reconstructed from general documentation:
 *   - J, branches:    target = pc + 4 + offset
 *   - CALL0/CALLN:    target = (pc & ~3) + 4 + offset   (offset already x4)
 *   - L32R:           target = ((pc + 3) & ~3) + offset (offset already negative x4)
 *   - CALL0/CALLN return addr (a0 / a[callinc*4]): pc + 3 - the address right
 *     after this 3-byte instruction, deliberately not word-aligned (matches
 *     real CALL0/RET).
 *
 * Windowed calls (CALL4/8/12 + ENTRY + RETW), from `win_helper.c`
 * (`HELPER(entry)`, `HELPER(window_check)`, `HELPER(retw)`,
 * `HELPER(test_ill_retw)`, `HELPER(test_underflow_retw)`) and `translate.c`
 * (`gen_callw_slot`, `translate_entry`, `gen_window_check`, `translate_retw`):
 *   - CALLN does NOT rotate the register window - it only stashes
 *     (callinc<<30)|(pc+3) into a[callinc*4] and sets PS.CALLINC. The window
 *     rotates later, inside the callee's ENTRY. This repo models the
 *     PS.CALLINC handoff with a single `pendingCallinc` field rather than a
 *     full PS register.
 *   - ENTRY first checks for window OVERFLOW: it scans WINDOWSTART (via the
 *     same replicate-and-count-trailing-zeros approach as
 *     `HELPER(window_check)`) for a still-live, unspilled frame within
 *     `callinc` quads ahead. If found, real hardware doesn't run ENTRY's own
 *     effects this cycle - it rotates onto the colliding frame, raises a
 *     size-appropriate WindowOverflow{4,8,12} exception, and (once the
 *     handler's RFWO retries) re-fetches this same ENTRY instruction from
 *     EPC1. Only when there's no collision does ENTRY do its normal work:
 *     write the new stack pointer into the *pre-rotation* window at index
 *     (callinc<<2)|(s&3) - the same physical register that becomes the new
 *     window's a1 once RegisterFile.rotate() runs - then mark that frame
 *     live and rotate.
 *   - RETW replicates HELPER(test_ill_retw)'s m/n legality check using
 *     RegisterFile.isFrameLive(), then HELPER(test_underflow_retw)'s check
 *     for whether the target frame is actually resident; if not, it rotates
 *     back and raises a size-appropriate WindowUnderflow{4,8,12} exception
 *     instead of returning, mirroring real hardware exactly.
 *   - L32E/S32E and RFWO/RFWU are the actual instructions a window
 *     over/underflow handler uses to spill/fill registers and retry -
 *     implemented here so the exception path can be exercised end to end,
 *     see cpu.test.ts. This repo does not ship the real ROM handler routines
 *     (their exact spill layout is an ABI/firmware convention, not something
 *     defined in this QEMU fork's source) - tests use a minimal synthetic
 *     stand-in that only exercises the hardware-verified mechanism (RFWO
 *     restoring PS/window state and retrying), not a claimed-accurate spill.
 *
 * Exceptions, from `exc_helper.c` (`HELPER(exception_cause)`) and
 * `core-esp32/core-isa.h` (`XCHAL_*_VECOFS`): illegal instructions, integer
 * divide-by-zero (QUOU/QUOS/REMU/REMS, checked before the divide itself -
 * `gen_zero_check` in translate.c), and (recursively) a second exception
 * while PS.EXCM is already set all vector through the same general path
 * (EPC1=pc, PS.EXCM=1, jump to the kernel or double-exception vector - this
 * repo assumes PS.UM=0, i.e. no user/kernel ring split, as real
 * ESP-IDF/bare-metal firmware runs entirely in ring 0).
 * Window over/underflow vector directly to their own dedicated, size-keyed
 * vector slots instead, with no EXCCAUSE involved, exactly as
 * `HELPER(window_check)`/`HELPER(test_underflow_retw)` do. VECBASE defaults
 * to its hardware reset value, `XCHAL_VECBASE_RESET_VADDR` (0x40000000).
 * `Cpu`'s own default `pc` (when the constructor's third argument is
 * omitted) is `RESET_VECTOR`, `XCHAL_RESET_VECTOR_VADDR` (0x40000400) -
 * where real ESP32 silicon's boot ROM actually lives, inside IROM. This
 * project doesn't load or execute that ROM (Phase 3's boot sequence starts
 * a `Cpu` directly with RAM/flash already populated), but a fresh `Cpu`
 * still reflects the chip's real reset PC rather than an arbitrary 0.
 *
 * SAR (shift amount register, `this.sar`): SSR/SSAI store the amount
 * directly, SSL stores its 32's-complement - see the field's own doc
 * comment for why SLL/SRL/SRA/SRC don't need to track which of those set it
 * last. SLLI/SRAI/SRLI take their shift amount from the instruction itself
 * instead and never touch SAR.
 *
 * QUOS/REMS (signed divide/remainder): `INT_MIN / -1` can't be represented
 * in 32 bits, so real hardware special-cases it rather than trapping or
 * producing garbage (`translate_quos` in translate.c, shared by both
 * opcodes via a `par[0]` flag) - QUOS returns INT_MIN unchanged, REMS
 * returns 0. QUOU/REMU (unsigned) have no such case.
 *
 * Nothing here throws for a bad-but-real CPU condition (ARCHITECTURE.md):
 * illegal opcodes and window over/underflow are all handled by vectoring,
 * same as real silicon - `step()` always returns normally, and callers
 * observe what happened (if anything) via `Cpu.lastException`.
 *
 * Interrupt delivery, from `exc_helper.c`'s `handle_interrupt` and
 * `xtensa_get_cintlevel`, `core-esp32/core-isa.h`'s per-line `XCHAL_INTn_
 * LEVEL` table (real ESP32 hardware wiring - which of the 32 CPU interrupt
 * lines is "level 1" vs "level 3" etc. is fixed silicon configuration, not
 * software-selectable), and `cpu.h`'s SR field layout (`PS_INTLEVEL`,
 * `PS_EXCM`). `Cpu.setInterruptLine(line, active)` is the one entry point a
 * peripheral (or, so far, only a test) drives to assert/deassert a line;
 * `step()` checks for a takeable interrupt before every fetch, exactly
 * where real hardware checks between instructions:
 *   - The "current interrupt level" is `max(PS.INTLEVEL, PS.EXCM ? 3 : 0)`
 *     (`xtensa_get_cintlevel` - ESP32's `XCHAL_EXCM_LEVEL` is 3), so any
 *     exception or interrupt in flight (which sets PS.EXCM) blocks levels
 *     1-3 until it's cleared, exactly like a real critical section.
 *   - Level 1 shares the *same* vector/EPC1/EXCM path as illegal-
 *     instruction/divide-by-zero (`raiseGeneralException`, now also taking
 *     `{kind:'interrupt', level:1}`) - PS.INTLEVEL is untouched, only
 *     PS.EXCM is set, matching `handle_interrupt`'s `level <= 1` branch.
 *   - Levels 2-7 use their own dedicated EPC[level]/EPS[level] (saving
 *     PC and enough of "PS" to restore it - EXCM, INTLEVEL, OWB, and the
 *     PS.CALLINC stand-in) and their own vector slot
 *     (`XCHAL_INTLEVELn_VECOFS`), set `PS.INTLEVEL = level` and `PS.EXCM =
 *     1`, and are returned from via `RFI level` (restores the saved state
 *     and jumps to the saved PC) rather than the exception path's RFWO/RFWU.
 *   - RSIL (set PS.INTLEVEL, return the *old* full PS value) and WSR/RSR
 *     restricted to exactly SR 230 (PS) and SR 228 (INTENABLE) - the
 *     minimum needed for a real critical-section pattern
 *     (`rsil`/save-old-PS/`wsr.ps`-to-restore) and enabling specific
 *     interrupt lines. Any other special register number decodes but isn't
 *     backed - `RSR`/`WSR` on one is treated as illegal, not silently
 *     wrong, since this repo doesn't model that register at all yet.
 *
 * Deliberately not modeled: NMI (level 7) - it's unmaskable on real
 * hardware (bypasses the `cintlevel` gate entirely) and ESP32 config
 * reserves exactly one line for it; skipped here since nothing in this
 * project raises it yet. Interrupt *type* (level/edge/software/timer/NMI,
 * `XCHAL_INTn_TYPE`) isn't modeled either - every line here behaves as
 * level-type (the caller of `setInterruptLine` is responsible for
 * deasserting it, there's no separate "clear" instruction path) - true for
 * ESP32's actual peripheral interrupt lines, but real edge/software lines
 * would need real WSR.INTSET/INTCLEAR semantics this repo doesn't have.
 */

import { decode, instructionLength, type Decoded } from './decode.js';
import { Fpu, ftoiS, ftouiS, itofS, uitofS } from './fpu.js';
import type { RegisterFile } from './registers.js';

/**
 * Per-opcode cycle cost for `Cpu.cycles` - an approximation, not a fact taken
 * from this repo's QEMU fork. Unlike AVR (where avr8js's own per-instruction
 * cycle counts come straight from Atmel's published datasheet timing table),
 * Xtensa has no equivalently simple public per-opcode cycle table, and this
 * repo's own QEMU source doesn't model per-instruction guest timing either
 * (TCG dispatch isn't cycle-accurate without `icount`, which this fork
 * doesn't use). These costs exist so peripherals that need *some* notion of
 * elapsed time (TIMG's counters, UART baud pacing) have a monotonic clock to
 * advance against - plausible relative weights (memory access and
 * divide/FPU cost more than a register-register ALU op), not a claim about
 * real ESP32 silicon timing. Anything not listed defaults to 1 cycle.
 */
const CYCLE_COST: Partial<Record<Decoded['op'], bigint>> = {
  L32I: 2n,
  S32I: 2n,
  L32R: 2n,
  L32E: 2n,
  S32E: 2n,
  MULL: 2n,
  QUOU: 4n,
  QUOS: 4n,
  REMU: 4n,
  REMS: 4n,
  CALL0: 2n,
  CALLN: 2n,
  CALLX0: 2n,
  CALLXN: 2n,
  RET: 2n,
  RETW: 2n,
  ENTRY: 3n,
  RFWO: 3n,
  RFWU: 3n,
  RFI: 3n,
  RFE: 3n,
  ADD_S: 3n,
  SUB_S: 3n,
  MUL_S: 3n,
  FLOAT_S: 4n,
  UFLOAT_S: 4n,
  TRUNC_S: 4n,
  UTRUNC_S: 4n,
};

/** Flat cost for taking an interrupt or exception vector - same approximation caveat as `CYCLE_COST`. */
const EXCEPTION_COST = 4n;

/**
 * ESP32's real, documented maximum CPU clock (Espressif's ESP32 datasheet) -
 * the default `Cpu` assumes if the embedder doesn't say otherwise. Unlike
 * `CYCLE_COST`, this number itself isn't an approximation - it's what turns
 * the approximate cycle count into an approximate but *real-unit* elapsed
 * time (`lastStepNanos`/`elapsedNanos`), which is what peripherals with
 * their own real, fixed clock (TIMG/UART, both driven off the 80MHz APB bus
 * regardless of CPU frequency - see `peripherals/timer.ts`) actually need,
 * rather than a shared, ambiguous "cycle" conflating two different clock
 * domains.
 */
const DEFAULT_CPU_FREQ_HZ = 240_000_000n;

const NANOS_PER_SECOND = 1_000_000_000n;

export interface Bus {
  readByte(addr: number): number;
  read32(addr: number): number;
  write32(addr: number, value: number): void;
  /** Needed for S8I/S16I - real single/half-word stores, not just the L8UI/L16UI/L16SI reads read32/readByte already covered. */
  writeByte(addr: number, value: number): void;
}

export type ExceptionCause =
  | { kind: 'illegal' }
  | { kind: 'divide-by-zero' }
  | { kind: 'interrupt'; level: number }
  | { kind: 'double' }
  | { kind: 'window-overflow'; size: 4 | 8 | 12 }
  | { kind: 'window-underflow'; size: 4 | 8 | 12 };

/** VECBASE's hardware reset value (XCHAL_VECBASE_RESET_VADDR, core-isa.h). */
const VECBASE_RESET = 0x40000000;

/** PC's hardware reset value (XCHAL_RESET_VECTOR_VADDR, core-isa.h) - inside IROM, where the real boot ROM lives. */
export const RESET_VECTOR = 0x40000400;

/** Vector offsets relative to VECBASE, from XCHAL_*_VECOFS in core-isa.h. */
const VEC_WINDOW_OVERFLOW: Record<4 | 8 | 12, number> = { 4: 0x000, 8: 0x080, 12: 0x100 };
const VEC_WINDOW_UNDERFLOW: Record<4 | 8 | 12, number> = { 4: 0x040, 8: 0x0c0, 12: 0x140 };
const VEC_KERNEL = 0x300; // XCHAL_KERNEL_VECOFS - general exceptions, PS.UM=0 assumed
const VEC_DOUBLE = 0x3c0; // XCHAL_DOUBLEEXC_VECOFS
/**
 * XCHAL_INTLEVELn_VECOFS for n=2..7 (index 0/1 unused - level 1 shares
 * VEC_KERNEL). Level 7 is NMI (XCHAL_NMI_VECOFS == XCHAL_INTLEVEL7_VECOFS)
 * and reuses the same saved-PC/PS-by-level machinery as levels 2-6, with
 * one difference: it's unmaskable (see `checkInterrupts`).
 */
const VEC_INTLEVEL: Record<number, number> = { 2: 0x180, 3: 0x1c0, 4: 0x200, 5: 0x240, 6: 0x280, 7: 0x2c0 };

/** ESP32's real, hardware-fixed level assignment for each of the 32 CPU interrupt lines (XCHAL_INTn_LEVEL, core-isa.h). */
const LINE_LEVEL: readonly number[] = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1, 1, 7, 3, 5, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 3, 4, 3, 4, 5,
];

/** The one CPU line ESP32 wires to NMI (XCHAL_INT14_TYPE == NMI, core-isa.h) - unmaskable, bypasses INTENABLE and cintlevel entirely. */
const NMI_LINE = 14;

/** EXCM_LEVEL: while PS.EXCM is set, the effective interrupt level is at least this (xtensa_get_cintlevel). */
const EXCM_LEVEL = 3;

/** Special register numbers this repo backs via RSR/WSR (real Xtensa SR numbers, not invented). */
const SR_PS = 230;
const SR_INTENABLE = 228;
// VECBASE (real Xtensa SR 231, e.g. <xtensa/config/specreg.h>) - the class
// already carries a `vecbase` field (used by every raiseXxx() exception-
// target calculation below), but WSR/RSR never exposed it to software at
// all until now. A real, necessary gap, not just an over-restriction: every
// real ESP-IDF binary's own startup code (call_start_cpu0) explicitly does
// `wsr.vecbase` right after its own ENTRY, to relocate the exception vector
// table from the boot-time default (VECBASE_RESET, pointing at nothing this
// repo emulates) to the app's own IRAM-resident vector table - without this,
// that write silently (well, not silently - it raised ILLEGAL) failed, so
// the CPU kept computing every subsequent exception's target against the
// stale boot-default vecbase, landing nowhere real.
const SR_VECBASE = 231;

interface PsSnapshot {
  excm: boolean;
  intlevel: number;
  owb: number;
  callinc: 0 | 1 | 2 | 3;
}

/** Count trailing zero bits of a 32-bit unsigned value (32 if x is 0). */
function ctz32(x: number): number {
  x >>>= 0;
  if (x === 0) return 32;
  let n = 0;
  while ((x & 1) === 0) {
    x >>>= 1;
    n++;
  }
  return n;
}

/** BEQI/BNEI/BLTI/BGEI's real constant table (Xtensa ISA's own b4const), confirmed against a real compiled binary's own uses. */
const B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256] as const;
/** BLTUI/BGEUI's real constant table (b4constu) - identical to B4CONST except indices 0/1, which real hardware fills with 32768/65536 instead of -1/1 (values that only make sense unsigned). */
const B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256] as const;

export class Cpu {
  pc: number;
  readonly regs: RegisterFile;
  readonly fpu = new Fpu();
  private readonly bus: Bus;

  vecbase = VECBASE_RESET;
  /** PS.EXCM. */
  excm = false;
  /** PS.OWB: the pre-rotation window base captured when an exception fires. */
  owb = 0;
  epc1 = 0;
  /** Set by step() when an exception fired this step; null otherwise. */
  lastException: ExceptionCause | null = null;

  /**
   * Monotonic count of approximated cycles elapsed (see `CYCLE_COST`'s doc
   * comment for what this is and isn't). A `bigint`, matching `Timg`'s own
   * 64-bit counters (`peripherals/timer.ts`) - a `number` would lose
   * precision long before any real simulation session finishes.
   */
  cycles = 0n;
  /** The cost `step()` just added to `cycles` - what a caller forwards to `SystemBus.tick()` without recomputing it. */
  lastStepCycles = 0n;

  /** This `Cpu`'s assumed clock rate - see `DEFAULT_CPU_FREQ_HZ`'s doc comment. */
  readonly cpuFreqHz: bigint;
  /** `cycles` converted to elapsed nanoseconds via `cpuFreqHz` - a real unit, not an ambiguous "cycle". */
  elapsedNanos = 0n;
  /** The nanoseconds `step()` just added to `elapsedNanos` - what a caller forwards to `SystemBus.tick()`. */
  lastStepNanos = 0n;

  /**
   * SAR (shift amount register). SSR/SSAI store the amount directly (0-31);
   * SSL stores its 32's-complement instead (1-32), so SAR alone doesn't say
   * which "mode" was last set - but that's fine, because real hardware
   * doesn't track a mode either: SLL always computes its shift amount as
   * `(32 - SAR) & 0x3f` and SRL/SRA/SRC always use SAR directly, regardless
   * of whether SSR or SSL set it last (verified against `translate_sll`'s
   * fallback path in translate.c, which is mathematically identical to the
   * "fast path" QEMU takes when it can prove SSL ran most recently in the
   * same translation block - that fast path is a compile-time optimization,
   * not a distinct runtime behavior, so this interpreter doesn't need it).
   */
  sar = 0;

  /**
   * Stand-in for PS.CALLINC: the quad-count set by the most recent CALLN,
   * consumed by the ENTRY it's paired with. Zero means "no CALLN pending" -
   * an ENTRY reached in that state is illegal, since real ABI code always
   * runs CALLN immediately into a function whose first instruction is ENTRY.
   */
  private pendingCallinc: 0 | 1 | 2 | 3 = 0;

  /**
   * Plain read-what-you-last-wrote storage for special registers this repo
   * doesn't give real behavior to (PS/INTENABLE/VECBASE above are the ones
   * that do). Real hardware special registers RSR/WSR doesn't specifically
   * back here (MEMCTL - instruction/data cache prefetch config - is the
   * first one actually hit, by ESP-IDF's own startup code) configure real
   * hardware behavior this repo doesn't model (cache, in MEMCTL's case) -
   * exactly the same "unmapped access is a harmless no-op, not a fault"
   * posture `SystemBus`'s own doc comment already documents for memory
   * addresses, extended here to special registers. Software that reads
   * back what it wrote (a common "save/restore cache config" pattern
   * around a critical section) still sees consistent values; software
   * that depends on the register's real hardware *effect* just silently
   * doesn't get it, the same gap unmapped memory already has.
   */
  private readonly scratchSpecialRegs = new Map<number, number>();

  /** PS.INTLEVEL (0-7 used; ESP32 has levels 1-6 plus NMI at 7, unsupported here). */
  intlevel = 0;
  /** INTENABLE special register: which of the 32 CPU interrupt lines can currently take. */
  intenable = 0;
  /** Live level of each of the 32 CPU interrupt lines - see `setInterruptLine`. */
  private interruptLines = 0;
  /** EPC2-EPC6 (index by level, 0/1/7 unused) - PC saved on entry to a level-2..6 interrupt. */
  private readonly epcByLevel = new Map<number, number>();
  /** EPS2-EPS6 (index by level) - the PsSnapshot saved on entry to a level-2..6 interrupt. */
  private readonly psByLevel = new Map<number, PsSnapshot>();

  constructor(regs: RegisterFile, bus: Bus, pc = RESET_VECTOR, cpuFreqHz = DEFAULT_CPU_FREQ_HZ) {
    this.regs = regs;
    this.bus = bus;
    this.pc = pc >>> 0;
    this.cpuFreqHz = cpuFreqHz;
  }

  /**
   * Assert or deassert CPU interrupt line `n` (0-31) - the one entry point
   * a peripheral (via an interrupt matrix) or test drives. Level-triggered:
   * the caller is responsible for deasserting it once its condition clears,
   * matching every currently-modeled ESP32 peripheral interrupt line (see
   * this file's header comment on interrupt *type*).
   */
  setInterruptLine(n: number, active: boolean): void {
    this.interruptLines = active ? this.interruptLines | (1 << n) : this.interruptLines & ~(1 << n);
  }

  /** xtensa_get_cintlevel: PS.EXCM raises the effective level to at least EXCM_LEVEL. */
  private currentInterruptLevel(): number {
    return this.excm && EXCM_LEVEL > this.intlevel ? EXCM_LEVEL : this.intlevel;
  }

  private packPs(): number {
    return (
      ((1 << 18) | (this.pendingCallinc << 16) | (this.owb << 8) | (this.excm ? 0x10 : 0) | (this.intlevel & 0xf)) >>> 0
    );
  }

  private unpackPs(value: number): void {
    this.intlevel = value & 0xf;
    this.excm = (value & 0x10) !== 0;
    this.owb = (value >>> 8) & 0xf;
    this.pendingCallinc = ((value >>> 16) & 0x3) as 0 | 1 | 2 | 3;
  }

  private snapshotPs(): PsSnapshot {
    return { excm: this.excm, intlevel: this.intlevel, owb: this.owb, callinc: this.pendingCallinc };
  }

  private restorePs(snapshot: PsSnapshot): void {
    this.excm = snapshot.excm;
    this.intlevel = snapshot.intlevel;
    this.owb = snapshot.owb;
    this.pendingCallinc = snapshot.callinc;
  }

  /** Levels 2-6 (and 7/NMI) share this: save PC/PS, set PS.INTLEVEL/EXCM, jump to that level's vector. */
  private takeLeveledInterrupt(pc: number, level: number): number {
    this.epcByLevel.set(level, pc >>> 0);
    this.psByLevel.set(level, this.snapshotPs());
    this.intlevel = level;
    this.excm = true;
    this.lastException = { kind: 'interrupt', level };
    return (this.vecbase + VEC_INTLEVEL[level]!) >>> 0;
  }

  /**
   * HELPER(handle_interrupt): finds the highest-level active&enabled line
   * that exceeds the current interrupt level and takes it, returning the
   * vector address to jump to - or null if nothing is currently takeable.
   * NMI (`NMI_LINE`) is checked first and bypasses both INTENABLE and the
   * cintlevel gate entirely - real hardware's `handle_interrupt` ORs
   * `level == nmi_level` into the takeable condition unconditionally.
   */
  private checkInterrupts(pc: number): number | null {
    if (this.interruptLines & (1 << NMI_LINE)) {
      return this.takeLeveledInterrupt(pc, 7);
    }

    const active = this.interruptLines & this.intenable;
    if (active === 0) return null;
    const cintlevel = this.currentInterruptLevel();
    let bestLevel = 0;
    for (let line = 0; line < 32; line++) {
      if (active & (1 << line)) {
        const level = LINE_LEVEL[line]!;
        if (level > cintlevel && level > bestLevel && level <= 6) bestLevel = level;
      }
    }
    if (bestLevel === 0) return null;

    if (bestLevel === 1) {
      return this.raiseGeneralException(pc, { kind: 'interrupt', level: 1 });
    }
    return this.takeLeveledInterrupt(pc, bestLevel);
  }

  /** Records a step's cycle cost in both units - `cycles` (raw instruction count) and `elapsedNanos` (real time, via `cpuFreqHz`). */
  private accountCost(cost: bigint): void {
    this.lastStepCycles = cost;
    this.cycles += cost;
    this.lastStepNanos = (cost * NANOS_PER_SECOND) / this.cpuFreqHz;
    this.elapsedNanos += this.lastStepNanos;
  }

  private fetch24(addr: number): number {
    const b0 = this.bus.readByte(addr);
    const b1 = this.bus.readByte((addr + 1) >>> 0);
    const b2 = this.bus.readByte((addr + 2) >>> 0);
    return (b0 | (b1 << 8) | (b2 << 16)) >>> 0;
  }

  /**
   * HELPER(exception_cause): the general exception path (illegal
   * instruction, integer divide-by-zero, ...) - both vector to the same
   * kernel slot and only differ in EXCCAUSE, which this repo doesn't model
   * as a register (there's no other consumer of it yet), just the
   * `ExceptionCause` tag. Escalates to the double-exception vector if
   * PS.EXCM was already set, exactly as `HELPER(exception_cause)` does.
   */
  private raiseGeneralException(pc: number, cause: { kind: 'illegal' } | { kind: 'divide-by-zero' } | { kind: 'interrupt'; level: 1 }): number {
    const wasExcm = this.excm;
    this.epc1 = pc >>> 0;
    this.excm = true;
    this.lastException = wasExcm ? { kind: 'double' } : cause;
    return (this.vecbase + (wasExcm ? VEC_DOUBLE : VEC_KERNEL)) >>> 0;
  }

  private raiseIllegal(pc: number): number {
    return this.raiseGeneralException(pc, { kind: 'illegal' });
  }

  private raiseDivideByZero(pc: number): number {
    return this.raiseGeneralException(pc, { kind: 'divide-by-zero' });
  }

  private raiseWindowOverflow(pc: number, owb: number, size: 4 | 8 | 12): number {
    this.epc1 = pc >>> 0;
    this.excm = true;
    this.owb = owb;
    this.lastException = { kind: 'window-overflow', size };
    return (this.vecbase + VEC_WINDOW_OVERFLOW[size]) >>> 0;
  }

  private raiseWindowUnderflow(pc: number, owb: number, size: 4 | 8 | 12): number {
    this.epc1 = pc >>> 0;
    this.excm = true;
    this.owb = owb;
    this.lastException = { kind: 'window-underflow', size };
    return (this.vecbase + VEC_WINDOW_UNDERFLOW[size]) >>> 0;
  }

  /**
   * Address -> JS handler, for real Espressif mask-ROM functions this repo
   * doesn't (and realistically can't, without vendoring/re-implementing the
   * actual ROM image) execute for real. ESP-IDF's own startup path
   * (`call_start_cpu0` onward) calls a handful of these completely
   * unconditionally, on every board, immediately after boot - with nothing
   * mapped at their real fixed addresses (this repo's own "irom" region is
   * just zero-initialized backing memory, not a real ROM dump), the very
   * first such call faulted on an illegal/unmapped fetch.
   *
   * A handler runs entirely in the CALLER's own (unrotated) register
   * window - real hardware only rotates the window inside a callee's own
   * ENTRY, and a JS-native stub never executes one, so a2-a7 are exactly
   * the caller's own argument registers, unshifted, matching CALLX4/8/12's
   * real ABI. `returnFromStub()` (below) completes the call the same way a
   * matching ENTRY-then-RETW pair would, minus the window rotation neither
   * side ever needs.
   */
  readonly romStubs = new Map<number, () => void>();

  /**
   * Finishes a call intercepted via `romStubs`: reads the return address
   * CALLN already stashed (in a4/a8/a12, per its own `callinc`) and jumps
   * there directly - real hardware's ENTRY would additionally rotate the
   * register window by that same `callinc`, but a stub that never
   * allocates its own window has nothing to rotate away from.
   *
   * `returnValue`, if given, is written to the *caller's* register that
   * physically becomes the callee's a2 once real hardware's ENTRY rotates
   * the window by `callinc` quads - i.e. a10 for a callx8 (callinc=2, so
   * a2+8), not literally register a2. Getting this wrong is easy to miss
   * even having gotten everything else about this mechanism right: it was
   * only caught by tracing a real call site (`callx8` immediately followed
   * by `mov.n a6, a10` reading its result) and noticing the stub's return
   * value landed in the wrong register entirely.
   *
   * The packed return-info value only carries the low 30 bits of the
   * return PC (`callinc<<30 | (pc+3)&0x3fffffff` - see CALLN/CALLXN) - the
   * top 2 bits are never stored at all, real hardware assumes a call and
   * its return both land in the same 30-bit-addressable region, and
   * reconstructs them from whatever's *currently* in PC (see RETW's own
   * identical `(pc & 0xc0000000) | (a0 & 0x3fffffff)`, the reference this
   * mirrors). At the point this runs, `this.pc` is still the stub's own
   * ROM address, in the same region as the real call site, so this is
   * exactly as valid here as it is for RETW.
   */
  returnFromStub(returnValue?: number): void {
    const callinc = this.pendingCallinc;
    const retInfo = this.regs.get(callinc << 2);
    if (returnValue !== undefined) {
      this.regs.set((callinc << 2) + 2, returnValue >>> 0);
    }
    this.pendingCallinc = 0;
    this.pc = ((this.pc & 0xc0000000) | (retInfo & 0x3fffffff)) >>> 0;
  }

  step(): void {
    this.lastException = null;
    const pc = this.pc;

    const stub = this.romStubs.get(pc);
    if (stub) {
      // A plain CALLX8's own cost (CYCLE_COST['CALLX8']) - a stub replaces
      // the callee's real body, not the call itself, so it's charged the
      // same as any other single instruction, not left free.
      stub();
      this.accountCost(1n);
      return;
    }

    const interruptVector = this.checkInterrupts(pc);
    if (interruptVector !== null) {
      this.pc = interruptVector;
      this.accountCost(EXCEPTION_COST);
      return;
    }

    const word = this.fetch24(pc);
    const inst = decode(word);
    let nextPc = (pc + instructionLength(word)) >>> 0;

    switch (inst.op) {
      case 'NOP':
        break;
      case 'ADD':
        this.regs.set(inst.dest, (this.regs.get(inst.src1) + this.regs.get(inst.src2)) >>> 0);
        break;
      case 'SUB':
        this.regs.set(inst.dest, (this.regs.get(inst.src1) - this.regs.get(inst.src2)) >>> 0);
        break;
      case 'ADDX2':
      case 'ADDX4':
      case 'ADDX8': {
        const scale = inst.op === 'ADDX2' ? 1 : inst.op === 'ADDX4' ? 2 : 3;
        this.regs.set(inst.dest, ((this.regs.get(inst.src1) << scale) + this.regs.get(inst.src2)) >>> 0);
        break;
      }
      case 'SUBX2':
      case 'SUBX4':
      case 'SUBX8': {
        const scale = inst.op === 'SUBX2' ? 1 : inst.op === 'SUBX4' ? 2 : 3;
        this.regs.set(inst.dest, ((this.regs.get(inst.src1) << scale) - this.regs.get(inst.src2)) >>> 0);
        break;
      }
      case 'AND':
        this.regs.set(inst.dest, (this.regs.get(inst.src1) & this.regs.get(inst.src2)) >>> 0);
        break;
      case 'OR':
        this.regs.set(inst.dest, (this.regs.get(inst.src1) | this.regs.get(inst.src2)) >>> 0);
        break;
      case 'XOR':
        this.regs.set(inst.dest, (this.regs.get(inst.src1) ^ this.regs.get(inst.src2)) >>> 0);
        break;
      case 'NEG':
        this.regs.set(inst.dest, -this.regs.get(inst.src) >>> 0);
        break;
      case 'ABS':
        this.regs.set(inst.dest, Math.abs(this.regs.get(inst.src) | 0) >>> 0);
        break;
      case 'NSA': {
        // clrsb: redundant leading sign bits, not counting the sign bit itself.
        const v = this.regs.get(inst.src) | 0;
        this.regs.set(inst.dest, (v < 0 ? Math.clz32(~v) : Math.clz32(v)) - 1);
        break;
      }
      case 'NSAU':
        this.regs.set(inst.dest, Math.clz32(this.regs.get(inst.src) >>> 0));
        break;
      case 'MULL':
        this.regs.set(inst.dest, Math.imul(this.regs.get(inst.src1), this.regs.get(inst.src2)) >>> 0);
        break;
      case 'MULUH': {
        const product = BigInt(this.regs.get(inst.src1) >>> 0) * BigInt(this.regs.get(inst.src2) >>> 0);
        this.regs.set(inst.dest, Number((product >> 32n) & 0xffffffffn) >>> 0);
        break;
      }
      case 'MULSH': {
        const product = BigInt(this.regs.get(inst.src1) | 0) * BigInt(this.regs.get(inst.src2) | 0);
        this.regs.set(inst.dest, Number((product >> 32n) & 0xffffffffn) >>> 0);
        break;
      }
      case 'QUOU':
      case 'QUOS':
      case 'REMU':
      case 'REMS': {
        const dividend = this.regs.get(inst.src1);
        const divisor = this.regs.get(inst.src2);
        if (divisor === 0) {
          nextPc = this.raiseDivideByZero(pc);
          break;
        }
        if (inst.op === 'QUOU') {
          this.regs.set(inst.dest, Math.floor(dividend / divisor) >>> 0);
        } else if (inst.op === 'REMU') {
          this.regs.set(inst.dest, (dividend >>> 0) % (divisor >>> 0));
        } else {
          // QUOS/REMS: signed. INT_MIN / -1 would overflow a 32-bit signed
          // result, so real hardware special-cases it (translate_quos)
          // rather than trapping: QUOS returns INT_MIN unchanged, REMS
          // returns 0.
          const sDividend = dividend | 0;
          const sDivisor = divisor | 0;
          if (sDividend === -0x80000000 && sDivisor === -1) {
            this.regs.set(inst.dest, inst.op === 'QUOS' ? 0x80000000 : 0);
          } else if (inst.op === 'QUOS') {
            this.regs.set(inst.dest, (sDividend / sDivisor | 0) >>> 0);
          } else {
            this.regs.set(inst.dest, (sDividend % sDivisor) >>> 0);
          }
        }
        break;
      }
      case 'SLL': {
        const shiftAmt = (32 - this.sar) & 0x3f; // always this formula - see the `sar` field's comment
        const value = this.regs.get(inst.src);
        this.regs.set(inst.dest, shiftAmt >= 32 ? 0 : (value << shiftAmt) >>> 0);
        break;
      }
      case 'SRL':
        this.regs.set(inst.dest, this.regs.get(inst.src) >>> this.sar);
        break;
      case 'SRA':
        this.regs.set(inst.dest, ((this.regs.get(inst.src) | 0) >> this.sar) >>> 0);
        break;
      case 'SRC': {
        // Funnel shift: {src1:src2} as one 64-bit value, shifted right by SAR, low 32 bits kept.
        const hi = BigInt(this.regs.get(inst.src1) >>> 0);
        const lo = BigInt(this.regs.get(inst.src2) >>> 0);
        const combined = (hi << 32n) | lo;
        this.regs.set(inst.dest, Number((combined >> BigInt(this.sar)) & 0xffffffffn) >>> 0);
        break;
      }
      case 'SLLI':
        this.regs.set(inst.dest, (this.regs.get(inst.src) << inst.shift) >>> 0);
        break;
      case 'SRAI':
        this.regs.set(inst.dest, ((this.regs.get(inst.src) | 0) >> inst.shift) >>> 0);
        break;
      case 'SRLI':
        this.regs.set(inst.dest, this.regs.get(inst.src) >>> inst.shift);
        break;
      case 'EXTUI': {
        // mask is always 1-16 (op2+1, op2 being 4 bits) - (1<<mask)-1 never
        // needs the 32-bit-overflow special case a generic "mask width"
        // helper would.
        const maskBits = (1 << inst.mask) - 1;
        this.regs.set(inst.dest, ((this.regs.get(inst.src) >>> inst.shift) & maskBits) >>> 0);
        break;
      }
      case 'SSR':
        this.sar = this.regs.get(inst.src) & 0x1f;
        break;
      case 'SSL':
        this.sar = (32 - (this.regs.get(inst.src) & 0x1f)) & 0x3f;
        break;
      case 'SSAI':
        this.sar = inst.shift & 0x1f;
        break;
      case 'ADDI':
        this.regs.set(inst.dest, (this.regs.get(inst.src) + inst.imm) >>> 0);
        break;
      case 'MOV':
        this.regs.set(inst.dest, this.regs.get(inst.src));
        break;
      case 'MOVI':
        this.regs.set(inst.dest, inst.imm >>> 0);
        break;
      case 'L32I':
      case 'L32E': {
        const addr = (this.regs.get(inst.base) + inst.offset) >>> 0;
        this.regs.set(inst.dest, this.bus.read32(addr));
        break;
      }
      case 'S32I':
      case 'S32E': {
        const addr = (this.regs.get(inst.base) + inst.offset) >>> 0;
        this.bus.write32(addr, this.regs.get(inst.src));
        break;
      }
      case 'L8UI': {
        const addr = (this.regs.get(inst.base) + inst.offset) >>> 0;
        this.regs.set(inst.dest, this.bus.readByte(addr));
        break;
      }
      case 'L16UI':
      case 'L16SI': {
        const addr = (this.regs.get(inst.base) + inst.offset) >>> 0;
        const raw = this.bus.readByte(addr) | (this.bus.readByte((addr + 1) >>> 0) << 8);
        this.regs.set(inst.dest, inst.op === 'L16SI' ? ((raw << 16) >> 16) >>> 0 : raw);
        break;
      }
      case 'S8I': {
        const addr = (this.regs.get(inst.base) + inst.offset) >>> 0;
        this.bus.writeByte(addr, this.regs.get(inst.src) & 0xff);
        break;
      }
      case 'S16I': {
        const addr = (this.regs.get(inst.base) + inst.offset) >>> 0;
        const value = this.regs.get(inst.src);
        this.bus.writeByte(addr, value & 0xff);
        this.bus.writeByte((addr + 1) >>> 0, (value >>> 8) & 0xff);
        break;
      }
      case 'L32R': {
        const addr = (((pc + 3) & ~0x3) + inst.offset) >>> 0;
        this.regs.set(inst.dest, this.bus.read32(addr));
        break;
      }
      case 'J':
        nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      case 'CALL0':
        this.regs.set(0, (pc + 3) >>> 0);
        nextPc = ((pc & ~0x3) + 4 + inst.offset) >>> 0;
        break;
      case 'CALLN': {
        const retInfo = ((inst.callinc << 30) | ((pc + 3) & 0x3fffffff)) >>> 0;
        this.regs.set(inst.callinc << 2, retInfo);
        this.pendingCallinc = inst.callinc;
        nextPc = ((pc & ~0x3) + 4 + inst.offset) >>> 0;
        break;
      }
      case 'CALLX0': {
        // Indirect counterpart to CALL0 - same "a0 = return address" effect,
        // just jumping to a register-held target instead of a PC-relative
        // one (real hardware doesn't require word-alignment on the target
        // here the way CALL0/CALLN's own PC-relative form does). Reads the
        // target before writing a0, same "don't clobber before reading"
        // reasoning as CALLXN below, even though a0 and the target register
        // don't usually collide in real ABI code for this particular form.
        const target = this.regs.get(inst.target) >>> 0;
        this.regs.set(0, (pc + 3) >>> 0);
        nextPc = target;
        break;
      }
      case 'CALLXN': {
        // Indirect counterpart to CALLN - identical return-info/pendingCallinc
        // bookkeeping, just reading the call target from a register (loaded
        // by the caller via L32R/MOV, e.g. a real ROM function's address or
        // any C function pointer) rather than a PC-relative offset. Real
        // ABI code's target register is conventionally the *same* register
        // the return info is about to be written into (callx8's target is
        // a8, the same a[callinc<<2] slot callinc=2 writes to) - reading
        // the target before that write, not after, is load-bearing here,
        // not stylistic: getting this backwards was a real bug found while
        // bringing this instruction up at all (a fresh addition, not a
        // regression) - it clobbered the call target with the return-info
        // value before ever reading it, sending every indirect call
        // somewhere near the vector table instead of its real destination.
        const target = this.regs.get(inst.target) >>> 0;
        const retInfo = ((inst.callinc << 30) | ((pc + 3) & 0x3fffffff)) >>> 0;
        this.regs.set(inst.callinc << 2, retInfo);
        this.pendingCallinc = inst.callinc;
        nextPc = target;
        break;
      }
      case 'ENTRY': {
        // Real hardware restricts ENTRY's base register to a0-a3 (test_exceptions_entry).
        // Deliberately does NOT also require pendingCallinc !== 0: PS.CALLINC
        // is a real, plain 2-bit processor-state field with no "unset" state
        // of its own - 0 is simply "no rotation", not an illegal encoding
        // (win_helper.c's HELPER(entry)/translate_entry, the class's own
        // reference above, never checks or faults on it either). A real bug
        // this used to have: CALLN is the only thing that ever sets
        // pendingCallinc away from its reset default of 0, but the very
        // first ENTRY any program ever executes - the reset/entry vector's
        // own function prologue, or any debugger-style direct PC injection
        // (this repo's own Board.loadFirmware(), which jumps straight into
        // the loaded ELF's entry point the same way a hardware debugger's
        // "reset and run" does) - is never reached via a preceding CALLN,
        // so pendingCallinc is still genuinely 0 there. Treating that as
        // illegal meant *every* compiled program immediately double-faulted
        // on its very first instruction, before main()/app_main() or
        // anything else ever ran - found by single-stepping a real compiled
        // ESP-IDF binary and watching it fault on step 1, at the entry
        // point's own leading `entry a1, N`.
        if (inst.s > 3) {
          nextPc = this.raiseIllegal(pc);
          break;
        }
        const callinc = this.pendingCallinc;
        const windowBase = this.regs.getWindowBase();
        const windowStart = this.regs.getWindowStart();
        // Replicate WINDOWSTART to 32 bits so the shift-and-count below
        // wraps circularly through all 16 window positions, matching
        // xtensa_replicate_windowstart()/HELPER(window_check).
        const replicated = (windowStart | (windowStart << 16)) >>> 0;
        const shifted = replicated >>> (windowBase + 1);
        const n = ctz32(shifted) + 1; // distance to the nearest still-live frame ahead
        if (n <= callinc) {
          // Overflow: a live, unspilled frame is in the way. Size is
          // inferred from how far the *next* live frame is past it -
          // adjacent (0) means a 4-register frame is blocking, and so on;
          // anything uncertain conservatively resolves to 12 (over-spilling
          // is harmless, under-spilling corrupts data).
          const sizeSel = ctz32(shifted >>> n);
          const size: 4 | 8 | 12 = sizeSel === 0 ? 4 : sizeSel === 1 ? 8 : 12;
          this.regs.rotate(n); // hardware rotates onto the colliding frame before dispatching
          nextPc = this.raiseWindowOverflow(pc, windowBase, size);
          break;
        }
        const newSp = (this.regs.get(inst.s) - inst.imm) >>> 0;
        this.regs.set((callinc << 2) | (inst.s & 3), newSp);
        this.regs.markFrameLive(callinc);
        this.regs.rotate(callinc);
        this.pendingCallinc = 0; // consumed - nothing else in this minimal model reads it
        break;
      }
      case 'RET':
        nextPc = this.regs.get(0) >>> 0;
        break;
      case 'RETW': {
        const a0 = this.regs.get(0) >>> 0;
        const n = (a0 >>> 30) & 0x3;
        let m = 0;
        if (this.regs.isFrameLive(1)) m = 1;
        else if (this.regs.isFrameLive(2)) m = 2;
        else if (this.regs.isFrameLive(3)) m = 3;
        if (n === 0 || (m !== 0 && m !== n)) {
          nextPc = this.raiseIllegal(pc);
          break;
        }
        if (!this.regs.isFrameLive(n)) {
          const owb = this.regs.getWindowBase();
          const size: 4 | 8 | 12 = n === 1 ? 4 : n === 2 ? 8 : 12;
          this.regs.rotate(-n);
          nextPc = this.raiseWindowUnderflow(pc, owb, size);
          break;
        }
        this.regs.clearFrameLive(0);
        this.regs.rotate(-n);
        nextPc = ((pc & 0xc0000000) | (a0 & 0x3fffffff)) >>> 0;
        break;
      }
      case 'RFWO':
      case 'RFWU': {
        this.excm = false;
        if (inst.op === 'RFWO') this.regs.clearFrameLive(0);
        else this.regs.markFrameLive(0);
        this.regs.rotate(this.owb - this.regs.getWindowBase());
        nextPc = this.epc1 >>> 0;
        break;
      }
      case 'RSIL':
        this.regs.set(inst.dest, this.packPs());
        this.intlevel = inst.level & 0xf;
        break;
      case 'RFI': {
        const saved = this.psByLevel.get(inst.level);
        const savedPc = this.epcByLevel.get(inst.level);
        if (saved === undefined || savedPc === undefined) {
          // No matching level-2..7 interrupt entry to return from - real
          // hardware behavior for a bogus level here isn't modeled; treat
          // as illegal rather than silently jumping somewhere wrong.
          nextPc = this.raiseIllegal(pc);
          break;
        }
        this.restorePs(saved);
        nextPc = savedPc >>> 0;
        break;
      }
      case 'RFE':
        // translate_rfe: PS.EXCM cleared, jump to EPC1 - returns from a
        // level-1 exception/interrupt/illegal-instruction/divide-by-zero,
        // all of which share that one save slot.
        this.excm = false;
        nextPc = this.epc1 >>> 0;
        break;
      case 'RSR':
        if (inst.sr === SR_PS) this.regs.set(inst.reg, this.packPs());
        else if (inst.sr === SR_INTENABLE) this.regs.set(inst.reg, this.intenable >>> 0);
        else if (inst.sr === SR_VECBASE) this.regs.set(inst.reg, this.vecbase >>> 0);
        else this.regs.set(inst.reg, this.scratchSpecialRegs.get(inst.sr) ?? 0); // unbacked - see scratchSpecialRegs
        break;
      case 'ADD_S':
        this.fpu.setFr(inst.dest, Math.fround(this.fpu.getFr(inst.src1) + this.fpu.getFr(inst.src2)));
        break;
      case 'SUB_S':
        this.fpu.setFr(inst.dest, Math.fround(this.fpu.getFr(inst.src1) - this.fpu.getFr(inst.src2)));
        break;
      case 'MUL_S':
        this.fpu.setFr(inst.dest, Math.fround(this.fpu.getFr(inst.src1) * this.fpu.getFr(inst.src2)));
        break;
      case 'MOV_S':
        this.fpu.setFr(inst.dest, this.fpu.getFr(inst.src));
        break;
      case 'NEG_S':
        this.fpu.setFr(inst.dest, -this.fpu.getFr(inst.src));
        break;
      case 'ABS_S':
        this.fpu.setFr(inst.dest, Math.abs(this.fpu.getFr(inst.src)));
        break;
      case 'WFR':
        this.fpu.writeFrBits(inst.dest, this.regs.get(inst.src));
        break;
      case 'RFR':
        this.regs.set(inst.dest, this.fpu.readFrBits(inst.src));
        break;
      case 'FLOAT_S':
        this.fpu.setFr(inst.dest, itofS(this.regs.get(inst.src), -inst.scale));
        break;
      case 'UFLOAT_S':
        this.fpu.setFr(inst.dest, uitofS(this.regs.get(inst.src), -inst.scale));
        break;
      case 'TRUNC_S':
        this.regs.set(inst.dest, ftoiS(this.fpu.getFr(inst.src), inst.scale) >>> 0);
        break;
      case 'UTRUNC_S':
        this.regs.set(inst.dest, ftouiS(this.fpu.getFr(inst.src), inst.scale));
        break;
      case 'OEQ_S':
        this.fpu.setBr(inst.dest, this.fpu.getFr(inst.src1) === this.fpu.getFr(inst.src2));
        break;
      case 'OLT_S':
        this.fpu.setBr(inst.dest, this.fpu.getFr(inst.src1) < this.fpu.getFr(inst.src2));
        break;
      case 'OLE_S':
        this.fpu.setBr(inst.dest, this.fpu.getFr(inst.src1) <= this.fpu.getFr(inst.src2));
        break;
      case 'UN_S':
        this.fpu.setBr(inst.dest, Number.isNaN(this.fpu.getFr(inst.src1)) || Number.isNaN(this.fpu.getFr(inst.src2)));
        break;
      case 'BT':
      case 'BF': {
        const taken = inst.op === 'BT' ? this.fpu.getBr(inst.src) : !this.fpu.getBr(inst.src);
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'WSR':
        if (inst.sr === SR_PS) this.unpackPs(this.regs.get(inst.reg));
        else if (inst.sr === SR_INTENABLE) this.intenable = this.regs.get(inst.reg) >>> 0;
        else if (inst.sr === SR_VECBASE) this.vecbase = this.regs.get(inst.reg) >>> 0;
        else this.scratchSpecialRegs.set(inst.sr, this.regs.get(inst.reg) >>> 0); // unbacked - see scratchSpecialRegs
        break;
      case 'MOVEQZ':
      case 'MOVNEZ':
      case 'MOVLTZ':
      case 'MOVGEZ': {
        const cond = this.regs.get(inst.cond) | 0;
        const taken =
          inst.op === 'MOVEQZ'
            ? cond === 0
            : inst.op === 'MOVNEZ'
              ? cond !== 0
              : inst.op === 'MOVLTZ'
                ? cond < 0
                : cond >= 0;
        if (taken) this.regs.set(inst.dest, this.regs.get(inst.src));
        break;
      }
      case 'BEQ':
      case 'BNE':
      case 'BLT':
      case 'BGE': {
        const a = this.regs.get(inst.a) | 0;
        const b = this.regs.get(inst.b) | 0;
        const taken =
          inst.op === 'BEQ'
            ? a === b
            : inst.op === 'BNE'
              ? a !== b
              : inst.op === 'BLT'
                ? a < b
                : a >= b;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'BLTU':
      case 'BGEU': {
        const a = this.regs.get(inst.a) >>> 0;
        const b = this.regs.get(inst.b) >>> 0;
        const taken = inst.op === 'BLTU' ? a < b : a >= b;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'BNONE':
      case 'BALL':
      case 'BANY':
      case 'BNALL': {
        const a = this.regs.get(inst.a) >>> 0;
        const b = this.regs.get(inst.b) >>> 0;
        const masked = (a & b) >>> 0;
        const taken =
          inst.op === 'BNONE' ? masked === 0 : inst.op === 'BALL' ? masked === b : inst.op === 'BANY' ? masked !== 0 : masked !== b;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'BEQZ':
      case 'BNEZ':
      case 'BLTZ':
      case 'BGEZ': {
        const a = this.regs.get(inst.a) | 0;
        const taken =
          inst.op === 'BEQZ' ? a === 0 : inst.op === 'BNEZ' ? a !== 0 : inst.op === 'BLTZ' ? a < 0 : a >= 0;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'BEQI':
      case 'BNEI':
      case 'BLTI':
      case 'BGEI': {
        // Signed comparisons against the b4const table - real hardware
        // compares as signed 32-bit values here (unlike BLTUI/BGEUI below).
        const a = this.regs.get(inst.a) | 0;
        const b = B4CONST[inst.b4index]!;
        const taken =
          inst.op === 'BEQI' ? a === b : inst.op === 'BNEI' ? a !== b : inst.op === 'BLTI' ? a < b : a >= b;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'BLTUI':
      case 'BGEUI': {
        const a = this.regs.get(inst.a) >>> 0;
        const b = B4CONSTU[inst.b4index]!;
        const taken = inst.op === 'BLTUI' ? a < b : a >= b;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'BBCI':
      case 'BBSI': {
        const bitValue = (this.regs.get(inst.src) >>> inst.bit) & 1;
        const taken = inst.op === 'BBCI' ? bitValue === 0 : bitValue === 1;
        if (taken) nextPc = (pc + 4 + inst.offset) >>> 0;
        break;
      }
      case 'ILLEGAL':
        nextPc = this.raiseIllegal(pc);
        break;
    }

    const cost = this.lastException !== null ? EXCEPTION_COST : (CYCLE_COST[inst.op] ?? 1n);
    this.accountCost(cost);
    this.pc = nextPc;
  }
}
