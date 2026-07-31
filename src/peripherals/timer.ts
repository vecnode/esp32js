/**
 * ESP32 "Timer Group" (TIMG) peripheral - register storage and the WDT
 * unlock/feed/disable mechanism, but no free-running clock.
 *
 * Register offsets, field layouts, and behavior are taken from this repo's
 * own pre-rewrite QEMU source (recoverable from git history at
 * `cae84de99b^`): `include/hw/esp32/esp32_timg.h` for the register map and
 * reset defaults, `hw/esp32/esp32_timg.c`'s `esp32_timg_read`/`_write` for
 * behavior.
 *
 * Scope decision worth explaining rather than leaving implicit: the
 * reference paces T0/T1's counters against `qemu_clock_get_ns` (real
 * elapsed wall-clock time, scaled by the configured divider) and fires
 * alarm interrupts via a `QEMUTimer` callback. This interpreter has no
 * notion of elapsed time at all - `Cpu.step()` executes one instruction
 * with no time cost attached - so there is nothing correct to scale
 * against yet. Rather than invent an arbitrary "N ticks per step" model
 * that would look plausible but not correspond to anything from the
 * reference, T0/T1's counters here are plain stored values: they hold
 * whatever was last written via `TxLOAD`/`TxLOADLO`/`TxLOADHI` and don't
 * advance on their own. `TxUPDATE` (which normally samples the live count)
 * is consequently a no-op - there's nothing to sample. Once a real time
 * source exists, this is exactly where it plugs in.
 *
 * The watchdog (WDT) is different: its *unlock/lock/feed/disable*
 * mechanism (`TIMG_WDTPROTECT`'s magic-word gate, `TIMG_WDTFEED`) is
 * pure register logic with no timing dependency, and is exactly what real
 * boot firmware needs to interact with correctly (disable or feed the
 * watchdog early in `app_main`) - so it's implemented faithfully, even
 * though (for the same reason as T0/T1) the watchdog never actually times
 * out and resets anything here.
 *
 * Not implemented: T0/T1/WDT alarm and timeout interrupts (`TIMG_INT_RAW`
 * is never set by this peripheral - nothing here has a clock to expire
 * against, and there's no interrupt matrix to deliver through yet either);
 * LACT (the legacy always-on RTC timer) and RTC calibration
 * (`TIMG_RTCCALICFG`/`CFG1`) - lower-priority than T0/T1/WDT for a first
 * cut; TIMG1 as a second instance (only TIMG0 is wired into `soc/bus.ts` so
 * far, though this class itself is instance-agnostic and works for either).
 */

export const TIMG_REG = {
  T0CONFIG: 0x00,
  T0LO: 0x04,
  T0HI: 0x08,
  T0UPDATE: 0x0c,
  T0ALARMLO: 0x10,
  T0ALARMHI: 0x14,
  T0LOADLO: 0x18,
  T0LOADHI: 0x1c,
  T0LOAD: 0x20,
  T1CONFIG: 0x24,
  T1LO: 0x28,
  T1HI: 0x2c,
  T1UPDATE: 0x30,
  T1ALARMLO: 0x34,
  T1ALARMHI: 0x38,
  T1LOADLO: 0x3c,
  T1LOADHI: 0x40,
  T1LOAD: 0x44,
  WDTCONFIG0: 0x48,
  WDTCONFIG1: 0x4c,
  WDTCONFIG2: 0x50,
  WDTCONFIG3: 0x54,
  WDTCONFIG4: 0x58,
  WDTCONFIG5: 0x5c,
  WDTFEED: 0x60,
  WDTPROTECT: 0x64,
  INT_ENA: 0x98,
  INT_RAW: 0x9c,
  INT_ST: 0xa0,
  INT_CLR: 0xa4,
} as const;

/** Byte size of the register window this peripheral occupies (TIMG_REGFILE_SIZE in the reference). */
export const TIMG_WINDOW_SIZE = 0x100;

/** ESP32_TIMG_WDT_PROTECT_WORD - writing this to TIMG_WDTPROTECT unlocks WDT config registers. */
const WDT_PROTECT_WORD = 0x50d83aa1;

const U32 = 0xffffffffn;

/** A general-purpose 64-bit up/down counter (T0 or T1) - see the module doc comment for why it doesn't free-run. */
class GpTimer {
  config = 0;
  counter = 0n;
  alarm = 0n;
  load = 0n;

  loLo(): number {
    return Number(this.counter & U32) >>> 0;
  }
  loHi(): number {
    return Number((this.counter >> 32n) & U32) >>> 0;
  }
  alarmLo(): number {
    return Number(this.alarm & U32) >>> 0;
  }
  alarmHi(): number {
    return Number((this.alarm >> 32n) & U32) >>> 0;
  }
  loadLo(): number {
    return Number(this.load & U32) >>> 0;
  }
  loadHi(): number {
    return Number((this.load >> 32n) & U32) >>> 0;
  }

  setLoadLo(v: number): void {
    this.load = (this.load & (U32 << 32n)) | BigInt(v >>> 0);
  }
  setLoadHi(v: number): void {
    this.load = (this.load & U32) | (BigInt(v >>> 0) << 32n);
  }
  setAlarmLo(v: number): void {
    this.alarm = (this.alarm & (U32 << 32n)) | BigInt(v >>> 0);
  }
  setAlarmHi(v: number): void {
    this.alarm = (this.alarm & U32) | (BigInt(v >>> 0) << 32n);
  }

  /** TxLOAD: commit the staged load value into the live counter. */
  commitLoad(): void {
    this.counter = this.load;
  }
}

export class Timg {
  private readonly t0 = new GpTimer();
  private readonly t1 = new GpTimer();

  // WDT reset defaults, from esp32_timg_wdt_reset.
  private wdtConfig0 = 0x0004c000;
  private wdtConfig1 = 0x00010000;
  private readonly wdtTimeout = [0x018cba80, 0x07ffffff, 0x000fffff, 0x000fffff];
  private wdtProtect = WDT_PROTECT_WORD;

  private intEna = 0;
  private intRaw = 0;

  private wdtLocked(): boolean {
    return this.wdtProtect !== WDT_PROTECT_WORD;
  }

  private timerFor(offset: number): GpTimer | undefined {
    if (offset >= TIMG_REG.T0CONFIG && offset <= TIMG_REG.T0LOAD) return this.t0;
    if (offset >= TIMG_REG.T1CONFIG && offset <= TIMG_REG.T1LOAD) return this.t1;
    return undefined;
  }

  readWord(offset: number): number {
    const t = this.timerFor(offset);
    if (t !== undefined) {
      switch (offset) {
        case TIMG_REG.T0CONFIG:
        case TIMG_REG.T1CONFIG:
          return t.config >>> 0;
        case TIMG_REG.T0LO:
        case TIMG_REG.T1LO:
          return t.loLo();
        case TIMG_REG.T0HI:
        case TIMG_REG.T1HI:
          return t.loHi();
        case TIMG_REG.T0ALARMLO:
        case TIMG_REG.T1ALARMLO:
          return t.alarmLo();
        case TIMG_REG.T0ALARMHI:
        case TIMG_REG.T1ALARMHI:
          return t.alarmHi();
        case TIMG_REG.T0LOADLO:
        case TIMG_REG.T1LOADLO:
          return t.loadLo();
        case TIMG_REG.T0LOADHI:
        case TIMG_REG.T1LOADHI:
          return t.loadHi();
        default:
          return 0;
      }
    }
    switch (offset) {
      case TIMG_REG.WDTCONFIG0:
        return this.wdtConfig0 >>> 0;
      case TIMG_REG.WDTCONFIG1:
        return this.wdtConfig1 >>> 0;
      case TIMG_REG.WDTCONFIG2:
      case TIMG_REG.WDTCONFIG3:
      case TIMG_REG.WDTCONFIG4:
      case TIMG_REG.WDTCONFIG5:
        return this.wdtTimeout[(offset - TIMG_REG.WDTCONFIG2) / 4]! >>> 0;
      case TIMG_REG.WDTPROTECT:
        return this.wdtProtect >>> 0;
      case TIMG_REG.INT_ENA:
        return this.intEna >>> 0;
      case TIMG_REG.INT_RAW:
        return this.intRaw >>> 0;
      case TIMG_REG.INT_ST:
        return (this.intEna & this.intRaw) >>> 0;
      default:
        return 0;
    }
  }

  writeWord(offset: number, value: number): void {
    const t = this.timerFor(offset);
    if (t !== undefined) {
      switch (offset) {
        case TIMG_REG.T0CONFIG:
        case TIMG_REG.T1CONFIG:
          t.config = value >>> 0;
          break;
        case TIMG_REG.T0UPDATE:
        case TIMG_REG.T1UPDATE:
          break; // no-op: nothing to sample without a real clock, see module doc comment
        case TIMG_REG.T0LOADLO:
        case TIMG_REG.T1LOADLO:
          t.setLoadLo(value);
          break;
        case TIMG_REG.T0LOADHI:
        case TIMG_REG.T1LOADHI:
          t.setLoadHi(value);
          break;
        case TIMG_REG.T0LOAD:
        case TIMG_REG.T1LOAD:
          t.commitLoad();
          break;
        case TIMG_REG.T0ALARMLO:
        case TIMG_REG.T1ALARMLO:
          t.setAlarmLo(value);
          break;
        case TIMG_REG.T0ALARMHI:
        case TIMG_REG.T1ALARMHI:
          t.setAlarmHi(value);
          break;
        default:
          break;
      }
      return;
    }

    switch (offset) {
      case TIMG_REG.WDTCONFIG0:
        if (!this.wdtLocked()) this.wdtConfig0 = value >>> 0;
        break;
      case TIMG_REG.WDTCONFIG1:
        if (!this.wdtLocked()) this.wdtConfig1 = value >>> 0;
        break;
      case TIMG_REG.WDTCONFIG2:
      case TIMG_REG.WDTCONFIG3:
      case TIMG_REG.WDTCONFIG4:
      case TIMG_REG.WDTCONFIG5:
        if (!this.wdtLocked()) this.wdtTimeout[(offset - TIMG_REG.WDTCONFIG2) / 4] = value >>> 0;
        break;
      case TIMG_REG.WDTFEED:
        // Feeding just resets the (nonexistent) countdown state here - see
        // module doc comment. Still gated by the lock, matching the reference.
        break;
      case TIMG_REG.WDTPROTECT:
        this.wdtProtect = value >>> 0; // always writable, regardless of lock state
        break;
      case TIMG_REG.INT_ENA:
        this.intEna = value >>> 0;
        break;
      case TIMG_REG.INT_CLR:
        this.intRaw = (this.intRaw & ~value) >>> 0;
        break;
      default:
        break;
    }
  }
}
