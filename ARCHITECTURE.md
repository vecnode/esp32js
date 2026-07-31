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
| `cpu/exceptions.ts` | `target/xtensa/exc_helper.c`, `cpu.h` (XEA2) | **mostly done**, but living directly on `Cpu` rather than a separate module - see Phase 2 status. Interrupt levels 1-6 dispatch, RSIL/RFI/WSR.PS/RSR.PS/WSR.INTENABLE/RSR.INTENABLE all real; still open: NMI (level 7), interrupt *type* beyond level-triggered, RFE (return from a level-1 exception/interrupt) |
| `cpu/fpu.ts` | `target/xtensa/fpu_helper.c` | single-precision only (`XCHAL_HAVE_DFP=0`) |
| `soc/memmap.ts` | `hw/xtensa/esp32_picsimlab.c:73-84` (`esp32_memmap[]`) | see table below |
| `soc/registers.ts` (base addrs) | `include/hw/esp32/esp32_reg.h` (`DR_REG_*_BASE`) | see table below |
| `peripherals/gpio.ts` | `hw/esp32/esp32_gpio.c` — **done (digital I/O only)**, see Phase 4 status | + IO_MUX (`hw/esp32/esp32_iomux.c`) for pin function select - not started |
| `peripherals/timer.ts` | `hw/esp32/esp32_timg.c` — **done (registers + WDT unlock/feed, no free-running clock)**, see Phase 4 status | TIMG0/TIMG1, each with a watchdog; only TIMG0 wired into `soc/bus.ts` so far |
| `peripherals/uart.ts` | `hw/esp32/esp32_uart.c` — **done (TX only)**, see Phase 4 status | 3 instances on real hardware (UART0/1/2); only UART0 implemented so far |
| `peripherals/adc.ts` | `hw/esp32/esp32_sens.c`, `esp32_ana.c` | SAR ADC1/ADC2 |
| `peripherals/intmatrix.ts` | `hw/xtensa/esp32_intc.c`, `include/hw/xtensa/esp32_intc.h` — **done (matrix mechanism)**, see Phase 4 status | peripheral IRQ → CPU interrupt line; source indices from `include/hw/esp32/esp32_reg.h`'s `ETS_*_INTR_SOURCE` enum |
| `soc/rtc_cntl.ts` | `hw/esp32/esp32_rtc_cntl.c` | needed for reset/boot, not just deep-sleep |
| `soc/dport.ts` | `hw/esp32/esp32_dport.c` | CPU control, cache config, PSRAM enable |

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
RTC_CNTL `0x3ff48000`, IO_MUX `0x3ff49000`, I2S0 `0x3ff4f000`,
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

Not modeled: PS.CALLINC is a single `pendingCallinc` field rather than part
of a full PS register; NMI (level 7) - unmaskable on real hardware
(bypasses the `cintlevel` gate entirely), skipped since nothing raises it
yet; interrupt *type* (level/edge/software/timer/NMI,`XCHAL_INTn_TYPE`) -
every line here behaves as level-type, true for ESP32's real peripheral
lines but not for edge/software/timer lines, which would need real
WSR.INTSET/INTCLEAR semantics this repo doesn't have; RFE (return from a
level-1 exception/interrupt) - illegal-instruction/divide-by-zero/level-1-
interrupt vectoring was already exercised without a full return in earlier
tests, and that scope boundary carries forward unchanged. EXCCAUSE isn't a
modeled register - 'illegal', 'divide-by-zero', and 'interrupt' are the
only general-exception causes that exist so far, distinguished purely by
the `ExceptionCause` tag; VECBASE still has no WSR/RSR instruction wired to
it (tests set it directly). BREAK.N and ILL.N (debug breakpoint and
guaranteed-illegal, both rare in ordinary compiled code) aren't specially
handled - they fall through to the same ILLEGAL path as any unrecognized
opcode, which happens to be correct for ILL.N and an acceptable stand-in
for BREAK.N until debug exceptions exist. SSA8L/SSA8B (byte-alignment shift
setup, a narrower-use variant of SSL/SSR), MUL16U/MUL16S/MULUH/MULSH
(16-bit and high-word multiply - only the 32x32->32-low MULL is
implemented), and MAC16 are still unimplemented. The rest of
`translate.c`'s opcode set (plus `cpu/fpu.ts`) remains open for Phase 2;
`cpu/exceptions.ts` as a separate module may or may not end up warranted -
this increment reinforces that the state (PS.EXCM/INTLEVEL/OWB, EPC/EPS by
level) is cohesive enough to keep living directly on `Cpu` rather than
needing its own file yet.

Phase 3 (started): `soc/bus.ts`'s `SystemBus` is the first thing in the
project backed by real bytes rather than a test double - one `Uint8Array`
per region in `MEMORY_MAP`, satisfying `cpu/cpu.ts`'s `Bus` interface
directly. `test/soc/bus.test.ts` proves the CPU can fetch and execute a
hand-assembled program placed at IRAM's real base address, not just against
`cpu.test.ts`'s flat scratch array - the first time Phase 1's memory map and
Phase 2's CPU have been exercised together.

Explicitly out of scope for `SystemBus` right now, and flagged rather than
half-built: every peripheral block in `PERIPHERAL_BASE` besides UART0 isn't
backed at all; DROM/IROM have no read-only enforcement; unmapped access
reads as 0 / silently no-ops on write instead of raising
LOAD_STORE_ERROR_CAUSE, because doing that properly needs an
EXCVADDR-carrying fault channel from `Bus` back to `Cpu` (analogous to
`HELPER(exception_cause_vaddr)` in `exc_helper.c`) that doesn't exist yet.

Still open for Phase 3: actually loading a firmware image (`SystemBus`
exposes `loadBytes()` for this, but nothing produces the bytes yet - no ELF
parsing or ESP32 image-header handling) and the boot sequence itself
(`soc/rtc_cntl.ts` for reset, `soc/dport.ts` for CPU/cache config) to get
from power-on to a loaded image's entry point.

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

Not implemented for UART0, and why: RX (`UART_FIFO` always reads back
0xEE, matching the reference's own "FIFO empty" case, since there's no
receive path yet); interrupt generation (`UART_INT_RAW`/`ST` would need
`esp32_uart_update_irq` - the interrupt matrix itself now exists, see
below, but nothing computes UART0's live interrupt condition to feed into
it yet); baud-rate timing (`UART_CLKDIV` is stored but nothing paces
against it, since this interpreter has no real-time clock to pace against
yet). UART1/UART2 remain fully open.

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

Not implemented for GPIO, and why: GPIO_STATUS and per-pin edge/level
interrupt generation (`gpio_pin[]`'s int_type field, GPIO_PCPU_INT/
ACPU_INT) - the interrupt matrix exists now (below), but nothing computes
a live per-pin interrupt condition to feed into it, since GPIO's own
`gpio_pin[]` int_type config isn't modeled; the IO_MUX-driven signal
routing matrix (GPIO_FUNCy_IN/OUT_SEL_CFG) real firmware uses to route a
GPIO to/from a peripheral (UART TXD, SPI, etc.) instead of raw digital I/O
- out of scope until IO_MUX itself exists.

`peripherals/timer.ts`'s `Timg` (TIMG0's registers + WDT unlock/feed) is
the third live peripheral, from `include/hw/esp32/esp32_timg.h`/`hw/esp32/
esp32_timg.c`. A scope decision here is worth restating plainly rather than
leaving implicit: the reference paces T0/T1's counters against real elapsed
wall-clock time (`qemu_clock_get_ns`, scaled by a configured divider) and
fires alarm interrupts via a `QEMUTimer` callback - this interpreter has no
notion of elapsed time at all (`Cpu.step()` executes one instruction with
no time cost attached), so there's nothing correct to scale a counter
against yet. Rather than invent an arbitrary "N ticks per step" model that
would look plausible but correspond to nothing in the reference, T0/T1's
counters are plain stored values, set only by `TxLOAD`/`LOADLO`/`LOADHI`
and never advancing on their own; `TxUPDATE` (which normally samples the
live count) is consequently a no-op. The watchdog's *unlock/lock/feed*
mechanism (`TIMG_WDTPROTECT`'s magic-word gate at `0x50D83AA1`,
`TIMG_WDTFEED`) has no such timing dependency and is exactly what real boot
firmware needs to interact with correctly (disable or feed the watchdog
early in `app_main`), so it's implemented faithfully even though the
watchdog itself never actually times out here. `test/soc/bus.test.ts`
includes a real "disable the watchdog" boot idiom test (unlock, clear
WDTCONFIG0's EN bit, re-lock) run through `S32I` end to end.

Not implemented for TIMG0: any interrupt ever actually firing
(`TIMG_INT_RAW` is never set by this peripheral - same root cause as the
counters); LACT (the legacy always-on RTC timer) and RTC calibration
registers; TIMG1 as a wired second instance (the `Timg` class itself is
instance-agnostic and works for either, only TIMG0 is connected to
`soc/bus.ts` so far).

`peripherals/intmatrix.ts`'s `IntMatrix` is the fourth live peripheral -
the real 69-entry-per-CPU register array from `hw/xtensa/esp32_intc.c`
(`esp32_intmatrix_read`/`_write`/`_irq_handler`), mapped at its real
address (`PERIPHERAL_BASE.dport + 0x104`, i.e. `A_DPORT_PRO_MAC_INTR_MAP` -
these registers really do live inside DPORT's own window, even though
`soc/dport.ts` doesn't exist yet). `IntMatrix.attach(cpu)` wires its output
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

Every other peripheral in `PERIPHERAL_BASE` (SAR ADC, IO_MUX) remains fully
open.
