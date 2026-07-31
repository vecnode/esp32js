/**
 * ESP32 RTC_CNTL (RTC block controller) - reset cause tracking, software
 * reset triggers, scratch registers, and clock/stall configuration storage.
 *
 * Register offsets, field layouts, and behavior are taken from this repo's
 * own pre-rewrite QEMU source (recoverable from git history at
 * `cae84de99b^`): `include/hw/esp32/esp32_rtc_cntl.h` for the register map
 * and reset defaults, `hw/esp32/esp32_rtc_cntl.c`'s `esp32_rtc_cntl_read`/
 * `_write` for behavior.
 *
 * Notably absent from *this fork's* RTC_CNTL, and so absent here too: the
 * RTC watchdog. Real ESP32 has one that's active from power-on and must be
 * fed or disabled by the boot ROM within a timeout - but that's boot-ROM
 * business this project doesn't execute (no ROM image is loaded; Phase 3's
 * boot work starts a CPU directly at the reset vector with RAM/flash
 * regions already populated), and this reference doesn't model it either,
 * so there's nothing to port.
 *
 * Time (`RTC_CNTL_TIME0/1`) follows the same scope decision as
 * `peripherals/timer.ts`'s T0/T1: the reference paces it against real
 * elapsed wall-clock time, which this interpreter has no notion of, so it's
 * a static stored value. `RTC_CNTL_TIME_UPDATE` always reads back "valid"
 * (`R_RTC_CNTL_TIME_UPDATE_VALID_MASK` unconditionally, per the reference)
 * and a write to it is a no-op, since there's no elapsed time to sample.
 *
 * `onReset` is called for a software system/PROCPU reset
 * (`RTC_CNTL_OPTIONS0`'s SW_SYS_RESET/SW_PROCPU_RESET bits, matching
 * `esp_restart()`'s real mechanism) and for a watchdog-triggered reset
 * (`triggerWdtReset`, driven by `peripherals/timer.ts`'s `Timg.onWdtReset`
 * via `soc/bus.ts`) - this repo doesn't itself reset a `Cpu`/`RegisterFile`
 * (there's no defined "reset a running machine" flow yet), so this is
 * exposed as a hook for an embedder to act on rather than silently doing
 * nothing. The register-level bit self-clear and reset-cause tracking
 * (readable via `RTC_CNTL_RESET_STATE`, matching real `esp_reset_reason()`)
 * work regardless of whether anything is listening.
 *
 * Not implemented: SW_APPCPU_RESET's effect and the SW_CPU_STALL/
 * OPTIONS0 stall-magic-value mechanism's effect (both concern a second
 * CPU core this project doesn't emulate) - the registers still store and
 * read back correctly, they just don't stall or reset anything, since
 * there is no APPCPU here to affect.
 */

export const RTC_CNTL_REG = {
  OPTIONS0: 0x00,
  TIME_UPDATE: 0x0c,
  TIME0: 0x10,
  TIME1: 0x14,
  RESET_STATE: 0x34,
  STORE0: 0x4c,
  STORE1: 0x50,
  STORE2: 0x54,
  STORE3: 0x58,
  CLK_CONF: 0x70,
  SW_CPU_STALL: 0xac,
  STORE4: 0xb0,
  STORE5: 0xb4,
  STORE6: 0xb8,
  STORE7: 0xbc,
  DATE: 0x13c,
} as const;

/** Byte size of the register window (ESP32_RTC_CNTL_SIZE = A_RTC_CNTL_DATE + 4). */
export const RTC_CNTL_WINDOW_SIZE = RTC_CNTL_REG.DATE + 4;

/**
 * Esp32ResetCause values reachable from this peripheral's own writes, plus
 * the two real ESP32 reset causes attributed to TIMG's watchdog
 * (`ESP32_TG0WDT_SYS_RESET`/`ESP32_TGWDT_CPU_RESET`, `esp32_rtc_cntl.h`) -
 * `peripherals/timer.ts`'s `Timg.onWdtReset` triggers these via
 * `triggerWdtReset` below, wired up by `soc/bus.ts`.
 */
export const RESET_CAUSE = {
  POWERON_RESET: 1,
  SW_SYS_RESET: 3,
  TG0WDT_SYS_RESET: 7,
  TGWDT_CPU_RESET: 11,
  SW_CPU_RESET: 12,
} as const;

const OPT0_SW_SYS_RESET = 1 << 31;
const OPT0_SW_APPCPU_RESET = 1 << 4;
const OPT0_SW_PROCPU_RESET = 1 << 5;

const TIME_UPDATE_VALID = 1 << 30;

export class RtcCntl {
  private options0 = 0;
  private time = 0n; // RTC_CNTL_TIME0/1 - static, see module doc comment
  private readonly scratch = new Array<number>(8).fill(0); // STORE0-7
  private resetCauseProCpu: number = RESET_CAUSE.POWERON_RESET;
  private resetCauseAppCpu: number = RESET_CAUSE.POWERON_RESET;
  private statVectorSelProCpu = true;
  private statVectorSelAppCpu = true;
  // Reset defaults from esp32_rtc_cntl_init: slowclk=RC(0), fastclk=8M(1), socclk=XTAL(0).
  private socClkSel = 0;
  private fastClkSel = 1;
  private slowClkSel = 0;
  private swCpuStall = 0;

  /**
   * Fires on a software system or PROCPU reset (RTC_CNTL_OPTIONS0's
   * SW_SYS_RESET/SW_PROCPU_RESET bits), or on a watchdog-triggered reset
   * (`triggerWdtReset`, wired from `Timg.onWdtReset` by `soc/bus.ts`).
   */
  onReset?: (cause: 'sys' | 'procpu' | 'wdt-cpu' | 'wdt-sys') => void;

  /**
   * A timer group's watchdog reached a stage configured as CPU-reset or
   * system-reset (`Timg.onWdtReset`) - records the matching real reset
   * cause and fires `onReset`, the same as a software-triggered reset does.
   */
  triggerWdtReset(kind: 'cpu' | 'sys'): void {
    if (kind === 'cpu') {
      this.resetCauseProCpu = RESET_CAUSE.TGWDT_CPU_RESET;
      this.onReset?.('wdt-cpu');
    } else {
      this.resetCauseProCpu = RESET_CAUSE.TG0WDT_SYS_RESET;
      this.resetCauseAppCpu = RESET_CAUSE.TG0WDT_SYS_RESET;
      this.onReset?.('wdt-sys');
    }
  }

  readWord(offset: number): number {
    switch (offset) {
      case RTC_CNTL_REG.OPTIONS0:
        return this.options0 >>> 0;
      case RTC_CNTL_REG.TIME_UPDATE:
        return TIME_UPDATE_VALID;
      case RTC_CNTL_REG.TIME0:
        return Number(this.time & 0xffffffffn) >>> 0;
      case RTC_CNTL_REG.TIME1:
        return Number((this.time >> 32n) & 0xffffffffn) >>> 0;
      case RTC_CNTL_REG.RESET_STATE:
        return (
          ((this.statVectorSelProCpu ? 1 : 0) << 13) |
          ((this.statVectorSelAppCpu ? 1 : 0) << 12) |
          ((this.resetCauseAppCpu & 0x3f) << 6) |
          (this.resetCauseProCpu & 0x3f)
        );
      case RTC_CNTL_REG.STORE0:
      case RTC_CNTL_REG.STORE1:
      case RTC_CNTL_REG.STORE2:
      case RTC_CNTL_REG.STORE3:
        return this.scratch[(offset - RTC_CNTL_REG.STORE0) / 4]! >>> 0;
      case RTC_CNTL_REG.CLK_CONF:
        return (((this.slowClkSel & 0x3) << 30) | ((this.fastClkSel & 0x1) << 29) | ((this.socClkSel & 0x3) << 27)) >>> 0;
      case RTC_CNTL_REG.SW_CPU_STALL:
        return this.swCpuStall >>> 0;
      case RTC_CNTL_REG.STORE4:
      case RTC_CNTL_REG.STORE5:
      case RTC_CNTL_REG.STORE6:
      case RTC_CNTL_REG.STORE7:
        return this.scratch[(offset - RTC_CNTL_REG.STORE4) / 4 + 4]! >>> 0;
      default:
        return 0; // e.g. RTC_CNTL_DATE - unhandled in the reference too, reads as 0
    }
  }

  writeWord(offset: number, value: number): void {
    switch (offset) {
      case RTC_CNTL_REG.OPTIONS0: {
        let v = value >>> 0;
        if (v & OPT0_SW_SYS_RESET) {
          this.resetCauseProCpu = RESET_CAUSE.SW_SYS_RESET;
          this.resetCauseAppCpu = RESET_CAUSE.SW_SYS_RESET;
          this.onReset?.('sys');
          v &= ~OPT0_SW_SYS_RESET;
        }
        if (v & OPT0_SW_APPCPU_RESET) {
          this.resetCauseAppCpu = RESET_CAUSE.SW_CPU_RESET;
          v &= ~OPT0_SW_APPCPU_RESET;
        }
        if (v & OPT0_SW_PROCPU_RESET) {
          this.resetCauseProCpu = RESET_CAUSE.SW_CPU_RESET;
          this.onReset?.('procpu');
          v &= ~OPT0_SW_PROCPU_RESET;
        }
        this.options0 = v >>> 0;
        break;
      }
      case RTC_CNTL_REG.TIME_UPDATE:
        break; // no-op - see module doc comment
      case RTC_CNTL_REG.RESET_STATE:
        this.statVectorSelProCpu = ((value >>> 13) & 0x1) !== 0;
        this.statVectorSelAppCpu = ((value >>> 12) & 0x1) !== 0;
        break;
      case RTC_CNTL_REG.STORE0:
      case RTC_CNTL_REG.STORE1:
      case RTC_CNTL_REG.STORE2:
      case RTC_CNTL_REG.STORE3:
        this.scratch[(offset - RTC_CNTL_REG.STORE0) / 4] = value >>> 0;
        break;
      case RTC_CNTL_REG.CLK_CONF:
        this.socClkSel = (value >>> 27) & 0x3;
        this.fastClkSel = (value >>> 29) & 0x1;
        this.slowClkSel = (value >>> 30) & 0x3;
        break;
      case RTC_CNTL_REG.SW_CPU_STALL:
        this.swCpuStall = value >>> 0;
        break;
      case RTC_CNTL_REG.STORE4:
      case RTC_CNTL_REG.STORE5:
      case RTC_CNTL_REG.STORE6:
      case RTC_CNTL_REG.STORE7:
        this.scratch[(offset - RTC_CNTL_REG.STORE4) / 4 + 4] = value >>> 0;
        break;
      default:
        break;
    }
  }
}
