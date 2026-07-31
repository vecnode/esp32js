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
| `cpu/exceptions.ts` | `target/xtensa/exc_helper.c`, `cpu.h` (XEA2) | PS register, vector table, interrupt levels |
| `cpu/fpu.ts` | `target/xtensa/fpu_helper.c` | single-precision only (`XCHAL_HAVE_DFP=0`) |
| `soc/memmap.ts` | `hw/xtensa/esp32_picsimlab.c:73-84` (`esp32_memmap[]`) | see table below |
| `soc/registers.ts` (base addrs) | `include/hw/misc/esp32_reg.h` (`DR_REG_*_BASE`) | see table below |
| `peripherals/gpio.ts` | `hw/gpio/esp32_gpio.c` | + IO_MUX (`hw/misc/esp32_iomux.c`) for pin function select |
| `peripherals/timer.ts` | `hw/timer/esp32_timg.c` | TIMG0/TIMG1, each with a watchdog |
| `peripherals/uart.ts` | `hw/char/esp32_uart.c` | 3 instances (UART0/1/2) |
| `peripherals/adc.ts` | `hw/misc/esp32_sens.c`, `esp32_ana.c` | SAR ADC1/ADC2 |
| `peripherals/intmatrix.ts` | `hw/xtensa/esp32.c` interrupt source enum | peripheral IRQ → CPU interrupt line |
| `soc/rtc_cntl.ts` | `hw/misc/esp32_rtc_cntl.c` | needed for reset/boot, not just deep-sleep |
| `soc/dport.ts` | `hw/misc/esp32_dport.c` | CPU control, cache config, PSRAM enable |

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

Phase 1 (this change): SoC memory map (`soc/memmap.ts`) and the three board
definitions (`boards/`), both pure data validated against the addresses
above. CPU decode/execute and peripheral behavior are separate, larger
follow-on phases per the reference table.
