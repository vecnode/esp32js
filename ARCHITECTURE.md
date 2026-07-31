# esp32js architecture and accuracy plan

## Two layers: SoC (silicon-accurate) and Board (pinout/population)

QEMU's own C source in this repo (`hw/xtensa/esp32_picsimlab.c`) only models the
**ESP32 SoC** — the chip, not a specific board. It doesn't know about DevKit V1,
DevKit C V4, or ESP32-CAM; those differ only in which SoC pins are broken out,
which peripheral chips sit on the board (USB-UART bridge, PSRAM, camera sensor,
microSD), and which GPIOs are reserved by that populated hardware. So esp32js
mirrors that split:

- **`src/soc/`** — the ESP32 chip itself: CPU core, memory map, peripheral
  register blocks, interrupt matrix. This is the part that must match the C
  implementation register-for-register. One SoC model serves all boards.
- **`src/boards/`** — thin data: pin mapping + which SoC peripherals/external
  chips are actually present. No new emulation logic, just board metadata
  layered on the shared SoC.

This is the same shape `hw/xtensa/esp32_picsimlab.c` already uses internally
(one `Esp32SocState` device tree, board specifics only in what's wired up),
just split into two files instead of one.

## Reference source mapping

Every module lists the exact file(s) in this repo it must match. This fork's
C source is the ground truth — not general Espressif datasheets, not stock
QEMU upstream — since it already carries the physicalsim-specific behavior
(the HMP GPIO/ADC injection commands this whole project exists to serve).

| esp32js module | Reference C source | Notes |
|---|---|---|
| `cpu/registers.ts` | `target/xtensa/win_helper.c` | done — windowed register file |
| `cpu/decode.ts`, `cpu/cpu.ts` | `target/xtensa/translate.c` (7672 lines) | opcode decode + ALU/load-store/branch semantics |
| `cpu/exceptions.ts` | `target/xtensa/exc_helper.c`, `cpu.h` (XEA2) | **done**, but living directly on `Cpu` rather than a separate module - see Phase 2 status. Interrupt levels 1-7 dispatch (level 7 = NMI, unmaskable), RSIL/RFI/RFE/WSR.PS/RSR.PS/WSR.INTENABLE/RSR.INTENABLE all real; still open: interrupt *type* beyond level-triggered |
| `cpu/fpu.ts` | `target/xtensa/fpu_helper.c` — **done (the subset below)**, see Phase 2 status | single-precision only (`XCHAL_HAVE_DFP=0`); MADD.S/MSUB.S, ROUND.S/CEIL.S/FLOOR.S, conditional FP moves, FCR/FSR, CPENABLE gating not modeled |
| `soc/memmap.ts` | `hw/xtensa/esp32_picsimlab.c:73-84` (`esp32_memmap[]`) | see table below |
| `soc/registers.ts` (base addrs) | `include/hw/esp32/esp32_reg.h` (`DR_REG_*_BASE`) | see table below |
| `peripherals/gpio.ts` | `hw/esp32/esp32_gpio.c` — **done (digital I/O + per-pin edge/level interrupts)**, see Phase 4/5 status | function-select-dependent behavior not modeled - see `peripherals/iomux.ts` |
| `peripherals/iomux.ts` | `hw/esp32/esp32_iomux.c` — **done (per-pin register storage)**, see Phase 4 status | pins 28-31 undocumented in the reference itself, omitted here too; no GPIO function-select side effects |
| `peripherals/timer.ts` | `hw/esp32/esp32_timg.c` — **done (T0/T1 counters + alarms, full WDT stage pipeline)**, see Phase 4/5 status | TIMG0/TIMG1, each with a watchdog; only TIMG0 wired into `soc/bus.ts` so far; polled `advance(cycles)`, not real-time-paced like the reference |
| `peripherals/uart.ts` | `hw/esp32/esp32_uart.c` — **done (real RX FIFO + interrupts + real TX pacing, deliberately beyond the reference's own incomplete TX stub)**, see Phase 4/5 status | 3 instances on real hardware (UART0/1/2); only UART0 implemented so far |
| `peripherals/adc.ts` | `hw/esp32/esp32_sens.c` — **done (ADC1/ADC2 channel select + injected value read)**, see Phase 4 status | touch sensor channels and ADC_ATTEN/width config not modeled |
| `peripherals/intmatrix.ts` | `hw/xtensa/esp32_intc.c`, `include/hw/xtensa/esp32_intc.h` — **done (matrix mechanism)**, see Phase 4 status | peripheral IRQ → CPU interrupt line; source indices from `include/hw/esp32/esp32_reg.h`'s `ETS_*_INTR_SOURCE` enum |
| `soc/rtc_cntl.ts` | `hw/esp32/esp32_rtc_cntl.c` — **done (reset cause + scratch/clock/stall registers, no RTC WDT or real-time clock)**, see Phase 3 status | needed for reset/boot, not just deep-sleep |
| `soc/dport.ts` | `hw/esp32/esp32_dport.c` — **done (APPCPU control + CPU_PER_CONF + cache-enable storage only)**, see Phase 3 status | CPU control, cache config, PSRAM enable - PSRAM/MMU/flash-encryption still open |
| `loader/elf.ts` | *(none - standard ELF32, not ESP32-specific)* — **done**, see Phase 3 status | `PT_LOAD` segments + entry point only; no esptool flash-image container, no relocations |
| `boards/board.ts` | *(none - this project's own board-runtime glue, not ported from the fork)* — **done**, see Phase 5 status | one `Board` class for all three boards; no camera/microSD emulation for ESP32-CAM |

(Every `hw/esp32/*` and `include/hw/esp32/*` path above was corrected from an
earlier guess that used the wrong directory prefix, e.g. `hw/gpio/`,
`hw/timer/`, `hw/char/`, `hw/misc/` - verified against
`git ls-tree -r cae84de99b^` rather than assumed a second time.)

## Memory map (from `esp32_memmap[]`, `hw/xtensa/esp32_picsimlab.c:73-84`)

| Region | Base | Size |
|---|---|---|
| DROM | `0x3ff90000` | `0x10000` |
| IROM | `0x40000000` | `0x70000` |
| DRAM | `0x3ffae000` | `0x52000` |
| IRAM | `0x40080000` | `0x40000` |
| ICACHE0 | `0x40070000` | `0x8000` |
| ICACHE1 | `0x40078000` | `0x8000` |
| RTC_SLOW | `0x50000000` | `0x2000` |
| RTC_FAST (instr) | `0x400c0000` | `0x2000` |
| RTC_FAST (data) | `0x3ff80000` | `0x2000` |

One region in that C array is deliberately **excluded**: `ESP32_MEMREGION_FRAMEBUF`
(`0x20000000`, PICSimLab's virtual RGB display). That's a PICSimLab simulation
convenience wired onto the SoC as a fake peripheral — it does not exist on any
real ESP32 board, so it has no place in a hardware-accurate emulator of real
DevKit boards.

## Peripheral register base addresses (`include/hw/misc/esp32_reg.h`)

DPORT `0x3ff00000`, AES `0x3ff01000`, RSA `0x3ff02000`, SHA `0x3ff03000`,
UART0 `0x3ff40000`, SPI1 `0x3ff42000`, SPI0 `0x3ff43000`, GPIO `0x3ff44000`,
RTC_CNTL `0x3ff48000`, SENS `0x3ff48800`, IO_MUX `0x3ff49000`, I2S0 `0x3ff4f000`,
UART1 `0x3ff50000`, I2C0 `0x3ff53000`, RMT `0x3ff56000`, LEDC `0x3ff59000`,
EFUSE `0x3ff5a000`, TIMG0 `0x3ff5f000`, TIMG1 `0x3ff60000`, SPI2 `0x3ff64000`,
SPI3 `0x3ff65000`, I2C1 `0x3ff67000`, SDMMC `0x3ff68000`, UART2 `0x3ff6e000`.

## What's real silicon vs. what QEMU itself stubs out

`hw/xtensa/esp32_picsimlab.c` registers I2S0/I2S1 (`esp32.i2s0`, `esp32.i2s1`)
as `create_unimplemented_device` — bus-error-avoiding register stubs, not
functional emulation. Real functional emulation stops there even in the C
reference. This matters directly for **ESP32-CAM**: its camera sensor talks
to the SoC over I2S in camera (DVP) mode. Since even this repo's QEMU doesn't
functionally emulate that path, "accurate to the C implementation" for
ESP32-CAM means: stub the same registers the same way (so firmware boot and
init don't hang), not invent new camera-capture emulation that has no
reference to be accurate *to*. Real image capture is out of scope until/unless
a reference implementation exists to match against.

## Board definitions

All three boards share one SoC. They differ only in:

| Board | USB-UART bridge | PSRAM | GPIO reservations |
|---|---|---|---|
| ESP32 DevKit V1 | CP2102 | no | none beyond boot-strap pins (GPIO0/2/5/12/15) |
| ESP32 DevKit C V4 | CP2102N | no | same boot-strap pins |
| ESP32-CAM | none (needs external FTDI) | yes, 4 MB (`dport.has_psram`) | GPIO0/2/4/12–16/21–23/25–27/32/33 reserved for OV2640 DVP + microSD SPI |

None of this is CPU/peripheral-behavior difference — it's board metadata that
determines which of the SoC's pins `physicalsim` can validly drive and
whether the PSRAM cache window (`s->dport.has_psram` in `esp32_dport.c`) is
enabled. The SoC emulation underneath is identical and must be equally
accurate for all three.

## Performance approach

- Register file and RAM/flash as `Uint32Array`/`Uint8Array` typed arrays, never boxed numbers or objects, on both the CPU and peripheral sides.
- Decode dispatch via a precomputed function-pointer table indexed by opcode class, not a `switch` re-evaluated per instruction or a decode tree walked from scratch each fetch.
- No exceptions/try-catch in the fetch-execute hot path; XEA2 exceptions are represented as explicit control-flow (return codes / state transitions), matching how `translate.c` itself compiles exceptions to explicit TCG branches rather than host-language exceptions.
- Peripheral MMIO dispatch by address-range binary search or direct bit-masked table lookup (the address ranges above are all naturally aligned), not a chain of `if` per device.

## Validation methodology

Correctness claims are only as good as what they're checked against. Plan:

1. **Unit tests per CPU mechanic**, cross-referencing the exact C helper (as already done for `registers.ts` against `win_helper.c`).
2. **Golden-trace comparison**: build this repo's `qemu-system-xtensa` (once buildable — see the pending dead-code cleanup), run a small test firmware image under both it and esp32js with the same input stimulus (via the same GPIO/ADC injection path physicalsim uses), and diff the observed GPIO/UART output sequences.
3. **Real firmware smoke tests**: boot actual ESP-IDF/Arduino "blink" and "read ADC" binaries through esp32js and confirm they reach `app_main()` and toggle the expected pins — this is the practical bar, since it exercises windowing, exceptions, and the interrupt matrix together in a way unit tests alone don't.

## Status

Phase 1: SoC memory map (`soc/memmap.ts`) and the three board definitions
(`boards/`), both pure data validated against the addresses above.

Phase 2 (in progress): `cpu/decode.ts` + `cpu/cpu.ts` implement a fetch/
execute loop covering both instruction widths - 24-bit (ADD, SUB, ADDI, AND,
OR, XOR, NEG, ABS, NSA, NSAU, MULL, QUOU, QUOS, REMU, REMS, MOVI, L32I,
S32I, L32R, L32E, S32E, J, BEQ/BNE/BLT/BGE, CALL0, CALL4/8/12, ENTRY, RET,
RETW, RFWO, RFWU, SLL, SRL, SRA, SRC, SLLI, SRAI, SRLI, SSR, SSL, SSAI) and
16-bit density (ADD.N, ADDI.N, L32I.N, S32I.N, MOVI.N, BEQZ.N, BNEZ.N,
MOV.N, RET.N, RETW.N, NOP.N) - enough to run hand-assembled control flow
including a full windowed call/return sequence
that exercises `cpu/registers.ts`'s rotate/markFrameLive/isFrameLive
mechanics end to end (previously untested). Bit layouts, PC-relocation
formulas, and exception-vectoring semantics were pulled from this repo's
own pre-rewrite QEMU source (`target/xtensa/core-esp32/xtensa-modules.inc.c`
and `core-esp32/core-isa.h` field/vector-offset tables; `target/xtensa/
translate.c`, `win_helper.c`, and `exc_helper.c` semantics; all still
recoverable from git history at `cae84de99b^`), not reconstructed from
general documentation.

Density (16-bit) support isn't optional polish - GCC's `-mdensity`, the
default for Xtensa/ESP-IDF's toolchain, emits 16-bit instructions
throughout ordinary compiled code, so a 24-bit-only decoder would
misdecode real firmware from essentially its first instruction. Instruction
width is now variable: `decode.ts` exports `instructionLength(word)`
(op0 in `[0x8,0xd]` is 2 bytes, everything else 3, per the
`Slot_inst16a_decode`/`Slot_inst16b_decode` split in xtensa-modules.inc.c),
and `Cpu.step()`'s default PC advance uses it instead of a fixed constant.
Several `.N` opcodes are semantically identical to a 24-bit counterpart
(ADD.N/ADD, L32I.N/L32I, S32I.N/S32I, MOVI.N/MOVI, RET.N/RET, RETW.N/RETW)
and decode straight to that same tag, so `cpu.ts` needed no changes for
them - only ADDI.N, MOV.N, NOP.N, BEQZ.N, and BNEZ.N needed new execution
cases. MOVI.N's immediate is a genuinely asymmetric range (-32..95, not a
plain signed 7-bit field) verified directly against
`OperandSem_opnd_sem_simm7_decode`'s bit trick rather than assumed.

The logical (AND/OR/XOR/NEG/ABS) and shift (SLL/SRL/SRA/SRC/SLLI/SRAI/
SRLI/SSR/SSL/SSAI) groups round out the RRR opcode space under op0=0. Two
things worth flagging as non-obvious, both verified against the reference
rather than assumed:
  - SLLI's and SRAI's immediate fields overlap op2's own low bit - the
    "opcode selector" and part of the shift-amount operand are the *same
    physical bit*, reused for different purposes (`Field_sal`/
    `Field_sargt` in xtensa-modules.inc.c both fold in "bit[20]", which is
    literally op2's LSB). Missing this would either misdecode these as a
    different opcode or silently truncate the shift amount to 4 bits.
  - `Cpu.sar` (the SAR/shift-amount special register): SSR and SSAI store
    the amount directly (0-31), SSL stores its 32's-complement (1-32)
    instead, but SLL/SRL/SRA/SRC don't need to track which mode was used
    last - real hardware doesn't either, since `translate_sll`'s fallback
    path computes `(32 - SAR) & 0x3f` unconditionally and that happens to
    equal the "fast path" QEMU takes when it can prove SSL ran most
    recently in the same translation block. That fast path is purely a
    compile-time optimization, not a distinct runtime behavior, so this
    interpreter (which has no equivalent of "the same translation block")
    doesn't need to reproduce it - it just always applies the one formula.

ADDI (24-bit; ADDI.N's density counterpart already existed), NSA/NSAU
(leading-sign/zero-bit count, using `Math.clz32` - `NSA`'s clrsb semantics
needs a small correction for negative inputs, `Math.clz32(~v)`, verified
against `tcg_gen_clrsb_i32`/`tcg_gen_clzi_i32` in translate.c rather than
assumed), MULL (32x32->32 multiply, via `Math.imul` for correct wraparound),
and the div32 family (QUOU/QUOS/REMU/REMS) round out the RRR opcode space
further. QUOS/REMS special-case `INT_MIN / -1` (translate_quos in
translate.c shares one function for both opcodes via a `par[0]` flag) to
return INT_MIN/0 respectively rather than overflow a 32-bit result. All
four raise a genuine divide-by-zero exception through the same general
path as illegal instructions (`gen_zero_check` in translate.c checks the
divisor before the divide itself runs, not after) - `ExceptionCause` grew a
`'divide-by-zero'` kind for this, and `raiseIllegal` was generalized into
`raiseGeneralException` so both causes share the double-exception
escalation logic instead of duplicating it.

A minimal exception model now exists directly on `Cpu`: PS.EXCM, PS.OWB,
EPC1, and a configurable VECBASE (defaulting to its hardware reset value,
`0x40000000`). Illegal instructions, divide-by-zero, double exceptions, and
window over/underflow all vector to their real, correctly-offset targets
exactly as `HELPER(exception_cause)`/`HELPER(window_check)`/
`HELPER(test_underflow_retw)` do; `Cpu.step()` never throws or halts for
these - it vectors and keeps going, exposing what happened (if anything)
via `Cpu.lastException`, matching how real silicon has no "stuck" state.
`cpu.test.ts` proves this end to end: a crafted window overflow and a
crafted window underflow each vector to their size-appropriate handler
slot, and a synthetic RFWO/RFWU handler (explicitly *not* a claimed replica
of the real ROM spill routine - that exact register layout is an ABI/
firmware convention with no reference in this QEMU fork's source) restores
state and successfully retries the faulting instruction.

Interrupt delivery is now real, from `exc_helper.c`'s `handle_interrupt`/
`xtensa_get_cintlevel` and `core-esp32/core-isa.h`'s per-line
`XCHAL_INTn_LEVEL` table (which of the 32 CPU interrupt lines is level 1
vs. level 3 etc. is fixed ESP32 silicon configuration, not
software-selectable - copied into `cpu.ts` as a literal 32-entry array, not
guessed). `Cpu.setInterruptLine(n, active)` is the one entry point anything
external (so far: `peripherals/intmatrix.ts`, or a test) drives; `step()`
checks for a takeable interrupt before every fetch, exactly where real
hardware checks between instructions. Level 1 shares the exact same
EPC1/PS.EXCM/vector path as illegal-instruction and divide-by-zero
(`raiseGeneralException` now also takes `{kind:'interrupt', level:1}`) -
PS.INTLEVEL is untouched, only PS.EXCM is set, matching
`handle_interrupt`'s `level <= 1` branch precisely. Levels 2-6 get their own
saved PC/PS-snapshot pair and their own `XCHAL_INTLEVELn_VECOFS` vector
slot, and return via a newly-added `RFI level` instruction. `RSIL`
(raise PS.INTLEVEL, return the *old* full packed PS) and `WSR`/`RSR`
restricted to exactly SR 230 (PS) and SR 228 (INTENABLE) - real Xtensa SR
numbers, not invented, decoded generically by `(r<<4)|s` in `decode.ts` but
only backed for these two in `cpu.ts` - round out the real
raise-interrupt-level / enable-a-line / restore-on-exit pattern ESP-IDF's
critical sections actually use. `cpu.test.ts` proves the full round trip:
level-1 delivery, a level-2 interrupt taken and returned via RFI, a
level-4 interrupt correctly preempting a level-2 one already in progress
(exercising `xtensa_get_cintlevel`'s `PS.EXCM` escalation, not just
`PS.INTLEVEL` alone), and RSIL/WSR.PS's critical-section pattern.

NMI (level 7) is now modeled too: `checkInterrupts` checks the ESP32's real
hardware-fixed NMI line (line 14) unconditionally, before the normal
INTENABLE/cintlevel-gated scan, matching `handle_interrupt`'s `level ==
nmi_level` OR-clause in `exc_helper.c` - NMI bypasses both the
interrupt-enable mask and the current CPU interrupt level entirely, exactly
as real hardware does. It reuses the same per-level saved-PC/PS-snapshot and
vector-slot machinery as levels 2-6 (`VEC_INTLEVEL[7] = 0x2c0`,
`XCHAL_NMI_VECOFS`). `RFE` (return from a level-1 exception/interrupt/
illegal-instruction/divide-by-zero - all of which share EPC1 as their one
save slot) is implemented too: it clears `PS.EXCM` and jumps to `EPC1`,
matching `translate_rfe` exactly; `RFWO`/`RFWU` (the same `r=3` opcode
family, `t=0`, `s=4`/`5`) are decoded but not executed, since nothing in
this repo's windowed-register model needs them yet.

Not modeled: PS.CALLINC is a single `pendingCallinc` field rather than part
of a full PS register; interrupt *type* (level/edge/software/timer/NMI,
`XCHAL_INTn_TYPE`) - every line here behaves as level-type, true for ESP32's
real peripheral lines but not for edge/software/timer lines, which would
need real WSR.INTSET/INTCLEAR semantics this repo doesn't have. EXCCAUSE
isn't a modeled register - 'illegal', 'divide-by-zero', and 'interrupt' are the
only general-exception causes that exist so far, distinguished purely by
the `ExceptionCause` tag; VECBASE still has no WSR/RSR instruction wired to
it (tests set it directly). BREAK.N and ILL.N (debug breakpoint and
guaranteed-illegal, both rare in ordinary compiled code) aren't specially
handled - they fall through to the same ILLEGAL path as any unrecognized
opcode, which happens to be correct for ILL.N and an acceptable stand-in
for BREAK.N until debug exceptions exist. SSA8L/SSA8B (byte-alignment shift
setup, a narrower-use variant of SSL/SSR), MUL16U/MUL16S/MULUH/MULSH
(16-bit and high-word multiply - only the 32x32->32-low MULL is
implemented), and MAC16 are still unimplemented. `cpu/exceptions.ts` as a
separate module may or may not end up warranted - this increment reinforces
that the state (PS.EXCM/INTLEVEL/OWB, EPC/EPS by level) is cohesive enough
to keep living directly on `Cpu` rather than needing its own file yet.

`cpu/fpu.ts`'s `Fpu` (single-precision FPU coprocessor state - FR register
file + BR boolean register) is now implemented too, covering ADD.S/SUB.S/
MUL.S, MOV.S/NEG.S/ABS.S, WFR/RFR (raw AR<->FR bit-pattern moves, no
conversion), FLOAT.S/UFLOAT.S/TRUNC.S/UTRUNC.S (int<->float conversion
scaled by a 4-bit unsigned immediate), OEQ.S/OLT.S/OLE.S/UN.S (FR compares
writing one BR bit), and BT/BF (branch on a BR bit). The one detail worth
flagging explicitly rather than assuming from the opcode names: FLOAT.S/
UFLOAT.S negate their scale immediate before the `2^scale` multiply while
TRUNC.S/UTRUNC.S don't (`translate_float_s`/`translate_ftoi_s` in
`translate.c`) - confirmed from the reference rather than guessed, since
getting the sign backwards would silently produce reciprocal-scaled values.
Not implemented, and why: MADD.S/MSUB.S (fused multiply-add/sub) and
ROUND.S/CEIL.S/FLOOR.S (the other three float-to-int rounding modes) are
outside this milestone's opcode list; MOVEQZ.S/MOVNEZ.S/MOVLTZ.S/MOVGEZ.S/
MOVF.S/MOVT.S (conditional FP moves) and UEQ.S/ULT.S/ULE.S (unordered-or-
true compare variants) aren't implemented either; FCR/FSR (rounding-mode
and sticky-exception-flag user registers) and CPENABLE gating (real
hardware traps FPU use before CPENABLE enables it) aren't modeled - every
FP op here behaves as round-to-nearest-even with no flag tracking and no
enable check, see `fpu.ts`'s own doc comment for the full detail. Arithmetic
uses JS's `Math.fround` for IEEE-754 single-precision rounding rather than
QEMU's `softfloat` library bit-for-bit - close enough for real firmware's
FP usage (sensor scaling, simple math), but doesn't claim to replicate
softfloat's subnormal/NaN-payload edge cases exactly.

Phase 3 (started): `soc/bus.ts`'s `SystemBus` is the first thing in the
project backed by real bytes rather than a test double - one `Uint8Array`
per region in `MEMORY_MAP`, satisfying `cpu/cpu.ts`'s `Bus` interface
directly. `test/soc/bus.test.ts` proves the CPU can fetch and execute a
hand-assembled program placed at IRAM's real base address, not just against
`cpu.test.ts`'s flat scratch array - the first time Phase 1's memory map and
Phase 2's CPU have been exercised together.

Explicitly out of scope for `SystemBus` right now, and flagged rather than
half-built (peripheral coverage below is current as of the boot-sequence
work, not the original UART-only cut): DROM/IROM have no read-only
enforcement; unmapped access reads as 0 / silently no-ops on write instead
of raising LOAD_STORE_ERROR_CAUSE, because doing that properly needs an
EXCVADDR-carrying fault channel from `Bus` back to `Cpu` (analogous to
`HELPER(exception_cause_vaddr)` in `exc_helper.c`) that doesn't exist yet.

The boot-sequence half of Phase 3 is now started too: `Cpu`'s own default
`pc` (when no explicit value is passed to the constructor) is
`RESET_VECTOR` = `0x40000400` (`XCHAL_RESET_VECTOR_VADDR`, core-isa.h) -
real ESP32 silicon's actual reset PC, inside IROM where the boot ROM lives
- rather than an arbitrary 0. `soc/rtc_cntl.ts`'s `RtcCntl` backs reset
cause tracking (`RTC_CNTL_RESET_STATE`, matching real `esp_reset_reason()`)
and the software reset triggers (`RTC_CNTL_OPTIONS0`'s SW_SYS_RESET/
SW_PROCPU_RESET bits, matching `esp_restart()`), plus scratch/clock/stall
registers as plain storage; `soc/dport.ts`'s `Dport` backs APPCPU control,
CPU_PER_CONF, and cache-enable registers as plain storage (no second CPU,
no real cache, so nothing acts on them yet - see each file's own doc
comment for exactly what's real vs. inert storage). `test/soc/bus.test.ts`
includes a real boot idiom end to end: read `RESET_STATE` (as
`esp_reset_reason()` would), then trigger a software PROCPU reset via
`S32I`, observed both through the register read-back and an `onReset`
callback.

Loading a real firmware image is now done too: `loader/elf.ts`'s `loadElf`
reads an ELF32 file's `PT_LOAD` program headers and writes each segment's
bytes onto a `Bus` at its real `p_vaddr` (zero-filling any BSS tail where
`p_memsz` exceeds `p_filesz`), returning `e_entry` to start a `Cpu` at.
Unlike every other module here, this one isn't ported from the QEMU C
fork - ELF loading isn't ESP32-specific behavior (real QEMU loads ELF
images through its generic, board-agnostic `load_elf()`, not anything in
`hw/esp32/`), so it's a from-scratch implementation of the standard ELF32
format instead. This is what makes "accept normal ESP32 code" true: a
`.elf` built by `xtensa-esp32-elf-gcc`/ESP-IDF already has its `PT_LOAD`
segments placed at real IRAM/DRAM/DROM/IROM addresses by the toolchain's
own linker script - the same addresses `soc/memmap.ts` models - so loading
by address directly onto a real `SystemBus` runs real compiled firmware
without needing a hand-assembled JS test program. `test/soc/bus.test.ts`
proves this end to end: an ELF built with a `.text` segment (packed
instruction words) and a `.bss` segment (`p_filesz=0 < p_memsz`, zero-fill
only) loaded via `loadElf`, then a real `Cpu` started at the returned entry
point and stepped through those instructions.

Still open for Phase 3: this project doesn't execute the real boot ROM or
2nd-stage bootloader (no such binary is loaded), so "boot" here means a
`Cpu` that resets to the right PC with correctly-behaving RTC_CNTL/DPORT
registers, not a full power-on-to-`app_main()` trace; esptool's separate
flash-image container format (the `.bin` it produces for flashing over
serial, distinct from the `.elf` `loadElf` reads) and SPI flash/MMU address
translation aren't modeled - neither is a CPU or peripheral behavior, and
both sit strictly before an ELF's segments ever reach the addresses this
project cares about being accurate at; the RTC watchdog (this fork's own
RTC_CNTL doesn't model one either - see `rtc_cntl.ts`'s doc comment); a
real second CPU core (all of DPORT's APPCPU_* registers are inert without
one).

Phase 4 (started): `peripherals/uart.ts`'s `Uart0` - TX only, wired into
`soc/bus.ts` as the first live peripheral in the SoC's real address space
(`PERIPHERAL_BASE.uart0`). Register offsets and behavior are taken from
`include/hw/esp32/esp32_uart.h` (register map) and `hw/esp32/esp32_uart.c`'s
`uart_read`/`uart_write` (semantics) - both recoverable from git history at
`cae84de99b^`, same as the CPU work. `test/soc/bus.test.ts` proves the
whole path end to end: a real `Cpu` running code loaded in IRAM (Phase 3)
writes characters via `S32I` into UART0's real peripheral address, and
`Uart0.onTx` observes them - the first time all three of memory map (Phase
1), CPU (Phase 2), and a peripheral (Phase 4) have worked together.

One correctness note worth being explicit about: `SystemBus.write32`
dispatches UART_FIFO writes to `Uart0.writeWord` directly, in one call -
critical, since a naive byte-by-byte write path (composing the 32-bit write
from four single-byte writes, the way plain memory regions work) would
fire `onTx` up to four times with wrong intermediate values instead of once
with the real byte. Real firmware only ever does aligned 32-bit MMIO
access, so this was never going to surface as a runtime bug, but it would
have been a landmine for exactly the kind of side-effecting peripheral
register this project is about to add more of - `write32`/`read32` route
to peripherals *before* falling into the generic memory-region byte
composition, not after, specifically to avoid it. `SystemBus` now
generalizes this into a small peripheral-slot table (base/size/device)
rather than hardcoding a single UART special case, so adding the next
peripheral (GPIO, below) was a data addition, not new dispatch logic.

At this point in the project, UART0 was TX-only: RX (`UART_FIFO` always
read back 0xEE, matching the reference's own "FIFO empty" case) and
interrupt generation (`esp32_uart_update_irq` needs live FIFO conditions
this repo didn't compute yet) were both open. Real RX and interrupts came
later, once the cycle counter existed - see Phase 5 status below. UART1/
UART2 remain fully open.

`peripherals/gpio.ts`'s `Gpio` (digital I/O only) is the second live
peripheral, from `include/hw/esp32/esp32_gpio.h`/`hw/esp32/esp32_gpio.c`.
GPIO_OUT/OUT_W1TS/OUT_W1TC, GPIO_ENABLE/ENABLE_W1TS/ENABLE_W1TC, GPIO_IN,
GPIO_IN1, and GPIO_STRAP are implemented, including a reference detail
worth calling out rather than "fixing": this fork has no simulated external
circuit by default, so driving a pin configured as output loops straight
back into GPIO_IN/IN1 (`esp32_gpio_write`'s diff-check against the old
out/enable values) - reading back a pin you just drove returns what you
drove, which happens to be exactly this project's situation too, so it's
preserved as-is. `setPin`/`getPin` expose the reference's `set_gpio`
external-input callback for tests/embedders to drive a pin from outside the
chip (a button, etc.) without going through the MMIO path.
`test/soc/bus.test.ts` includes a "blink" test: `S32I` instructions enable
a pin as output and toggle it high/low, observed via `bus.gpio.getPin()`.

Not implemented for GPIO at this point in the project: per-pin edge/level
interrupt generation (`gpio_pin[]`'s int_type field, GPIO_PCPU_INT/
ACPU_INT) - the interrupt matrix existed already, but nothing computed a
live per-pin interrupt condition to feed into it yet; that came later, see
Phase 5 status below. The IO_MUX-driven signal routing matrix
(GPIO_FUNCy_IN/OUT_SEL_CFG) real firmware uses to route a GPIO to/from a
peripheral (UART TXD, SPI, etc.) instead of raw digital I/O is still open -
`peripherals/iomux.ts` backs IO_MUX's own per-pin MUX_GPIOn register
storage (see below), but nothing connects a pin's stored function-select
value back into `Gpio`'s behavior, so `Gpio` still always behaves as raw
digital I/O regardless of what's written there.

`peripherals/timer.ts`'s `Timg` (TIMG0's registers + WDT unlock/feed) is
the third live peripheral, from `include/hw/esp32/esp32_timg.h`/`hw/esp32/
esp32_timg.c`. At this point in the project it was register storage only -
T0/T1 never advanced and the watchdog never timed out, since nothing gave
`Cpu.step()` any notion of elapsed time to scale a counter against yet. The
watchdog's *unlock/lock/feed* mechanism (`TIMG_WDTPROTECT`'s magic-word
gate, `TIMG_WDTFEED`) was implemented faithfully regardless, since it's
exactly what real boot firmware needs to interact with correctly (disable
or feed the watchdog early in `app_main`) and has no timing dependency of
its own. `test/soc/bus.test.ts` includes a real "disable the watchdog" boot
idiom test (unlock, clear WDTCONFIG0's EN bit, re-lock) run through `S32I`
end to end. T0/T1 actually advancing, real alarm interrupts, and the WDT's
full stage-timeout pipeline came later, once `Cpu` gained a cycle counter -
see Phase 5 status below for the current, real behavior.

`peripherals/intmatrix.ts`'s `IntMatrix` is the fourth live peripheral -
the real 69-entry-per-CPU register array from `hw/xtensa/esp32_intc.c`
(`esp32_intmatrix_read`/`_write`/`_irq_handler`), mapped at its real
address (`PERIPHERAL_BASE.dport + 0x104`, i.e. `A_DPORT_PRO_MAC_INTR_MAP` -
these registers really do live inside DPORT's own window; `soc/dport.ts`
now exists too, as a separate `SystemBus` peripheral slot covering only the
lower part of that same address range - the two don't overlap).
`IntMatrix.attach(cpu)` wires its output
to a `Cpu` (a `SystemBus` doesn't otherwise hold a `Cpu` reference, so this
is an explicit step the embedder takes once after constructing both).
`setSourceLevel(source, level)` is `esp32_intmatrix_irq_handler`'s
equivalent - the entry point a peripheral's live condition would drive. A
reference quirk is preserved deliberately rather than "fixed": writing
exactly the value `6` to a map register (`INTMATRIX_UNINT_VALUE`, also the
reset default for every entry) is a firmware idiom for "disconnect this
source" - it lowers whatever CPU line was previously routed to, without
treating 6 as a distinct "disabled" sentinel bit anywhere else in the
model. `test/soc/bus.test.ts` proves a full real path end to end: GPIO's
interrupt source (by number, `ETS_GPIO_INTR_SOURCE`=22) routed through the
matrix to a CPU line, asserted via `setSourceLevel`, and taken by a real
`Cpu.step()`.

Explicitly deferred, and why: no peripheral's live interrupt condition is
computed and fed into `IntMatrix.setSourceLevel` automatically yet - doing
that needs a "sync each peripheral's condition into its source line once
per step" concept that doesn't exist in this poll/step-based interpreter,
and is a separate scope decision from the matrix mechanism itself (which
is real and independently testable today, as shown above). Multiple
sources mapped to the same CPU line aren't OR'd - matching the reference's
own literal behavior (last event wins) rather than "improving" on it.

`peripherals/iomux.ts`'s `IoMux` is the fifth live peripheral, from
`include/hw/esp32/esp32_iomux.h`/`hw/esp32/esp32_iomux.c`. It's plain
per-pin register storage - real hardware's offset-to-pin mapping is
genuinely irregular (it follows the physical pin/pad layout, not GPIO
number order), so `OFFSET_TO_PIN` is transcribed directly from the
reference's per-case switch statement rather than derived from a formula;
pins 28-31 are commented out in the reference itself ("Not documented") and
are omitted here too. The reference's `esp32_iomux_write` also calls
`qemu_set_irq(s->iomux_sync[0], ...)` to notify `Gpio` that a pin's routed
function changed - not implemented, since this repo's `Gpio` is
unconditionally raw digital I/O and has nothing for that notification to
usefully drive yet (see `gpio.ts`'s own doc comment).

`peripherals/adc.ts`'s `Adc` is the sixth live peripheral (SAR ADC / SENS),
from `include/hw/esp32/esp32_sens.h`/`hw/esp32/esp32_sens.c`. ADC1 and ADC2
each have their own "start conversion" register (`SENS_MEAS1/2_START_SAR`):
writing it encodes the channel to sample as a one-hot bitmask in
bits[30:19] (`bitpos()`, matching the reference, finds which single bit is
set); reading it back returns `0x10000 | adcValue[channel]` - bit16 is the
real hardware's conversion-done flag, modeled here as always "done"
immediately, since there's no real ADC hardware taking time to convert.
ADC2's channel indexes into the *same* 32-entry value array as ADC1,
offset by 8 (`ADC_values[channel2 + 8]`) - replicated exactly rather than
giving ADC2 its own array, since that's what the reference actually does.
`setChannelValue`/`getChannelValue` are this peripheral's equivalent of
`Gpio.setPin`/`getPin` - the entry point for injecting a simulated analog
reading from outside the chip. Not implemented: touch sensor channels (the
reference's own touch model folds in `rand()` noise and
physicalsim-specific calibration constants that aren't meaningful to
reproduce without the same calibration data); ADC_ATTEN/width configuration
registers, which the reference itself doesn't back either.

Every other peripheral in `PERIPHERAL_BASE` besides UART0/GPIO/TIMG0/
RTC_CNTL/DPORT/interrupt-matrix/IO_MUX/SENS remains fully open.

Phase 5 (started): a timing model and peripheral self-driven interrupts -
the gap between "the CPU runs real firmware" and "this is embeddable the
way `avr8js` is embedded in Wokwi." `cpu/cpu.ts`'s `Cpu` now carries
`cycles: bigint` (matching `Timg`'s own 64-bit-counter style) plus a
per-opcode `CYCLE_COST` table and a flat `EXCEPTION_COST` for any step that
takes an interrupt or exception vector, exposed per-step as
`lastStepCycles` so a caller can forward exactly that delta onward without
recomputing it. This is explicitly **not** claimed to be sourced from the
QEMU fork or real silicon timing - unlike AVR (where avr8js's cycle counts
come straight from Atmel's published datasheet), Xtensa has no equally
simple public per-opcode cycle table, and this repo's own QEMU source
doesn't model per-instruction guest timing either (TCG isn't cycle-accurate
without `icount`, which this fork doesn't use). The costs are plausible
relative weights only (memory access and divide/FPU ops cost more than a
register-register ALU op) - enough to give TIMG/UART a monotonic clock to
advance against, not a timing-accuracy claim.

`soc/bus.ts`'s `SystemBus.tick(cycles)` now exists too, forwarding to every
peripheral implementing an optional `advance(cycles)` - `SystemBus` still
doesn't loop or hold a `Cpu` reference itself (a driver calls
`cpu.step(); bus.tick(cpu.lastStepCycles)` once per step), the same
separation `intmatrix.attach(cpu)` already established.

`peripherals/timer.ts`'s `Timg` is a real clock and a real watchdog now,
not just register storage. T0/T1's `advance(cycles)` scales `cycles` by the
configured `DIVIDER` field (`esp32_timg_timer_div_from_reg`'s exact
remapping: raw 0 -> 65536, raw 1 or 2 -> 2, else as-is) and advances the
64-bit counter; reaching `TxALARM` (with the `ALARM` bit armed and
`LEVEL_INT` set) raises that timer's interrupt. A genuinely surprising
reference detail is preserved deliberately rather than "fixed": `ALARM` is
a one-shot arm bit that self-clears the instant it fires -
`AUTORELOAD` reloads the *counter* from `TxLOAD`, but does **not** by
itself keep the alarm re-armed for next time (`esp32_timg_timer_cb`
clears its local `alarm` flag before reloading, so `esp32_timg_timer_
update_alarm`'s subsequent call bails immediately) - real firmware using
autoreload must rewrite `TxCONFIG` with `ALARM=1` after every interrupt.
The WDT's full `esp32_timg_wdt_update_config`/`esp32_timg_wdt_cb` pipeline
is implemented too: each stage (`WDTCONFIG0`'s `STG0-3` fields) counts
against its own timeout (`WDTCONFIG2-5`, scaled by `WDTCONFIG1`'s
`PRESCALE`) and on expiry performs that stage's configured action (off /
interrupt / CPU-reset / system-reset) before advancing to the next stage
(wrapping after 4); `WDTFEED` now genuinely resets stage and counter back
to 0 rather than being a no-op, and enabling the WDT (`EN` 0->1) does the
same, matching the reference's `en && !old_en` branch. A WDT stage
configured as CPU/system-reset calls a new `Timg.onWdtReset` hook, which
`soc/bus.ts` wires to a new `RtcCntl.triggerWdtReset(kind)` - extending
`RESET_CAUSE` with the two real ESP32 causes attributed to a timer group's
watchdog (`TG0WDT_SYS_RESET=7`, `TGWDT_CPU_RESET=11`,
`esp32_rtc_cntl.h`), fired through the same `onReset` hook a software
reset already uses. `Timg.onInterruptChange(source, active)` reports each
of T0/T1/WDT's live `INT_ENA & INT_RAW` condition (only when it flips),
which `soc/bus.ts`'s constructor wires directly to
`IntMatrix.setSourceLevel` at the matching `INTMATRIX_SOURCE.TG0_*` index -
unlike `intmatrix.attach(cpu)`, this wiring doesn't need an external `Cpu`
reference, since `SystemBus` already owns both peripheral instances, so it
happens immediately in the constructor. `test/soc/bus.test.ts` proves both
paths end to end: a real T0 alarm reaching a real `Cpu` through the matrix
via `bus.tick()`, and a real WDT system-reset reaching `RtcCntl.onReset`.

Not implemented for TIMG: LACT (the legacy always-on RTC timer) and RTC
calibration registers; edge-triggered interrupts (`EDGE_INT` config bits
are decoded but ignored - this repo's interrupt matrix only models
level-type lines for every peripheral so far); `WDTCONFIG0.FLASHBOOT_
MODE_EN` (ties the watchdog to a board-level "flash boot mode" flag this
repo doesn't track); TIMG1 as a second instance; firing more than once per
`advance()` call when a single call's cycle delta is large enough to cross
an alarm/timeout more than once - harmless for the intended
one-`Cpu.step()`-at-a-time driving pattern, worth flagging for a caller
batching many steps into one `tick()`.

`peripherals/gpio.ts`'s `Gpio` now generates real per-pin edge/level
interrupts too, from `GPIO_PINn`'s `INT_TYPE` field (bits[9:7]:
0=disabled, 1=rising, 2=falling, 3=any edge, 4=low level, 5=high level -
`get_triggering`) and its two enable bits, `PRO_CPU_INT_ENABLE` (bit 15)
and `APP_CPU_INT_ENABLE` (bit 13) - both routing to the same single
combined `onInterruptChange` this class exposes, matching the reference's
own single `qemu_irq irq` output regardless of which enable bit fired. The
evaluation happens **only** on the `setPin` external-stimulus path
(`set_gpio` in the reference) - the existing output-loopback write path
(a `GPIO_OUT` write reflecting into `GPIO_IN`) updates `gpio_in` directly
without ever touching interrupt state, exactly as the reference does: a
chip driving its own output pin does not self-interrupt on that pin. Two
reference quirks are preserved deliberately rather than "fixed": `GPIO_
STATUS`/`GPIO_STATUS1` are genuinely vestigial (plain read/write storage,
never touched by the real trigger logic - only `GPIO_PCPU_INT`/`GPIO_ACPU_
INT` and their `_1` counterparts are the actual interrupt latches), and
`GPIO_STATUS_W1TC`/`STATUS1_W1TC` each unconditionally lower the *combined*
interrupt line when they succeed, without checking whether the *other*
32-bit half (pins 0-31 vs. 32-39) still has a pending condition - so
clearing one half's interrupts can spuriously silence a still-pending
interrupt from the other half. `soc/bus.ts`'s constructor wires `Gpio.
onInterruptChange` to `IntMatrix.setSourceLevel(INTMATRIX_SOURCE.GPIO,
...)`, the same immediate-constructor-time pattern as TIMG's wiring above.
`test/soc/bus.test.ts` proves a real rising-edge GPIO interrupt reaching a
real `Cpu` through the matrix end to end.

`peripherals/uart.ts`'s `Uart0` gets a real RX FIFO and real interrupt
generation too. `pushRx(byte)` (the external-stimulus entry point, same
shape as `Gpio.setPin`) feeds a FIFO capped at the real 128-byte
`UART_FIFO_LENGTH`; `UART_FIFO` reads pop from it (still falling back to
`0xEE` only when empty), and `UART_STATUS`'s `RXFIFO_CNT` reflects real
depth. `esp32_uart_update_irq`'s condition is ported directly: `RXFIFO_
FULL` (depth >= `UART_CONF1`'s `RXFIFO_FULL_THRD`), `TXFIFO_EMPTY`, and
`TX_DONE`, plus `RXFIFO_TOUT` (an idle-since-last-RX timeout, polled via
`advance(cycles)` instead of the reference's real-time `QEMUTimer` -
`UART_CONF1`'s `TOUT_THRD` bit-count converts straight into a cycle count
via `UART_CLKDIV`'s divider, `cycles = thresholdBits * clkdiv`, without
needing a separate APB-frequency constant, the same "one cycle == one APB
tick" convention `peripherals/timer.ts` already established). The combined
result is `Uart0.onInterruptChange`, which `soc/bus.ts`'s constructor wires
to `INTMATRIX_SOURCE.UART0` - the same immediate-constructor-time pattern
as TIMG/GPIO. `test/soc/bus.test.ts` proves a real RXFIFO_FULL interrupt
reaching a real `Cpu` through the matrix via `bus.uart0.pushRx`.

TX pacing turned out to not be a gap to close at all, once the reference
was actually checked rather than assumed: `uart_transmit` drains the
*entire* TX FIFO synchronously in one call (writing straight to the real
chardev backend) before `esp32_uart_update_irq` even runs - there is no
real per-byte TX timing in the reference to port. `TXFIFO_EMPTY`/`TX_DONE`
are consequently "always empty"/"never done" by the time anything observes
them, in the reference as much as here; `onTx` firing synchronously was
already the right model. A second surprising, faithfully-preserved quirk:
`UART_INT_CLR` only has one real effect (clearing `RXFIFO_TOUT`'s flag) -
`uart_write` calls `esp32_uart_update_irq` unconditionally after every
write, which immediately recomputes `INT_RAW`/`INT_ST` from live
conditions and overwrites whatever `INT_CLR`'s own direct register
manipulation just did; a still-true level condition like `RXFIFO_FULL`
cannot be silenced by writing `INT_CLR` while it remains true.

Phase 5 completes with `src/boards/board.ts`'s `Board` - the piece that
ties everything above together into something an embedder (physicalsim, a
test, a REPL) can actually point at a `.elf` and run. One `Board` class
serves all three real boards (`new Board(ESP32_DEVKIT_V1)`, `new
Board(ESP32_DEVKIT_C_V4)`, `new Board(ESP32_CAM)`), since every
`BoardDefinition` here differs only in pin metadata, not emulated behavior
- the underlying `SystemBus` is identical for all three, matching this
project's own "one SoC model, thin board data" split from Phase 1. A
`Board`'s constructor performs the two wiring steps an embedder would
otherwise have to know exist: `bus.intmatrix.attach(cpu)` (`soc/bus.ts`'s
own doc comment) and wiring `Uart0.onTx` to a plain `onSerialOut` field.
`loadFirmware(elf)` calls `loadElf` and starts the `Cpu` at its entry
point; `step()`/`run(count)` call `cpu.step(); bus.tick(cpu.lastStepCycles)`
together, so a caller never has to remember that sequencing either.
`setPin`/`getPin`, `serialIn`, and `setAdcChannel`/`getAdcChannel` are thin
passthroughs to `bus.gpio`/`bus.uart0`/`bus.adc` - `setPin` additionally
checks the board's own pin list and calls `onReservedPinWarning` (a plain
callback, not `console.warn` directly, since a bare global `console` isn't
part of the ES2020 lib this project targets to stay usable in both the
browser and Node without pulling in DOM types) when driving a
`flash-spi`/`boot-strap`/`camera`/`sd-card` pin - still permitted, just
flagged, since a test might deliberately want to. `test/boards/board.test.ts`
proves all three boards construct correctly, take a real interrupt through
the matrix, load and run a real synthetic ELF, and exercise every
passthrough.

Not implemented: anything camera- or microSD-specific for ESP32-CAM -
`Board` doesn't add camera frame emulation or SD card behavior; those GPIOs
are ordinary digital I/O with `role: 'camera'`/`'sd-card'` metadata only,
consistent with this project's already-established I2S-stub scope limit
(see "What's real silicon vs. what QEMU itself stubs out" above).

`Cpu` now bridges its approximate cycle count to real elapsed time.
`cpuFreqHz` (constructor parameter, default `240_000_000` - ESP32's real,
documented maximum CPU clock, not an approximation) converts each step's
`CYCLE_COST` into `lastStepNanos`/`elapsedNanos`. This matters because
`Timg`/`Uart0` are driven off a *different*, fixed real clock (the 80MHz
APB bus) regardless of what the CPU is clocked at - treating "cycles" as
if they were already APB ticks (the assumption both files' doc comments
flagged when first written) conflated two real, distinct clock domains
into one ambiguous unit. Real elapsed nanoseconds is the correct
intermediate value: CPU-cycle-approximate but expressed in a unit every
peripheral can convert into its own real, documented clock rate. This is
the foundation for real UART baud pacing (below) and more accurate TIMG
timing - see each file's own updated doc comment for the conversion math.

`SystemBus.tick`, `Timg`, and `Uart0` all consume that real unit now
instead of raw cycles. `Timg`'s `advance(nanos)` converts incoming
nanoseconds into real APB ticks via a shared `apbTicksFromNanos` helper
(`ticks = nanos * 80MHz / (1e9 * divisor)`, tracking a nanosecond
remainder across calls so repeated small `advance()` calls - the intended
one-`Cpu.step()`-at-a-time pattern - don't lose precision to integer
division), used by both T0/T1's `DIVIDER` and the WDT's `PRESCALE`.
`Uart0`'s `RXFIFO_TOUT` idle timeout is computed directly in real
nanoseconds now too, via the reference's own real formula
(`ns = rxToutThresBits * 1e9 / baudRate`) with `baudRate` derived from
`UART_CLKDIV` exactly as `uart_calc_baud` does (the `TICK_REF_ALWAYS_ON`/
80MHz-APB path only - `REF_TICK` isn't modeled) - no more indirect
"cycles via clkdiv" conversion trick, since real elapsed time is now
available directly from `Cpu`.

`Uart0`'s TX side is genuinely paced now, closing the last of the four
gaps identified for physicalsim usability. This is a deliberate departure
from the reference, called out explicitly since this project otherwise
matches it exactly, quirks included: `uart_transmit` drains the entire TX
FIFO synchronously in one call with no timing delay at all, and the
reference's own source still carries commented-out retry logic for a real
async write path that was evidently never finished. Rather than replicate
that known-incomplete stub, `Uart0` now queues written bytes (capped at
the real 128-byte `UART_FIFO_LENGTH`, dropped past that) and drains them
over real time via `advance(nanos)`, using ordinary, universally
documented serial-frame timing - not an Xtensa- or ESP32-specific
invention: `frameNanos()` reads `UART_CONF0`'s real `BIT_NUM`/
`STOP_BIT_NUM`/`PARITY_EN` fields (`1 start bit + data + parity + stop`
bits, over the real baud rate) - `CONF0` now also gets its real reset
default (`esp32_uart_reset_hold`'s `STOP_BIT_NUM=1`, `BIT_NUM=3`, i.e. 8
data bits), previously untracked since nothing read it before TX pacing
existed. `TXFIFO_EMPTY`/`TX_DONE`/`UART_STATUS`'s `TXFIFO_CNT` all reflect
this real queue depth and in-flight state now, instead of being hardcoded
"always empty/never done" to match the reference's own stub; `onTx` fires
once a byte's transmit time has actually elapsed, not synchronously at
write time. `advance()`'s TX-draining loop handles more than one byte
finishing within a single call (a caller batching several `Cpu.step()`s
worth of elapsed time before calling `tick()` is a legitimate pattern,
unlike TIMG/WDT's "at most once per `advance()` call" simplification).
