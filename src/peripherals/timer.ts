/**
 * ESP32 "Timer Group" (TIMG) peripheral - T0/T1 general-purpose counters
 * with real alarm interrupts, and the watchdog's full unlock/feed/stage-
 * timeout/action pipeline.
 *
 * Register offsets, field layouts, and behavior are taken from this repo's
 * own pre-rewrite QEMU source (recoverable from git history at
 * `cae84de99b^`): `include/hw/esp32/esp32_timg.h` for the register/field map
 * and reset defaults, `hw/esp32/esp32_timg.c`'s `esp32_timg_read`/`_write`
 * and the `esp32_timg_timer_*`/`esp32_timg_wdt_*` helpers for behavior.
 *
 * The reference paces everything against `qemu_clock_get_ns` (real elapsed
 * wall-clock time) and fires alarms/timeouts via `QEMUTimer` callbacks at a
 * precomputed absolute time. This interpreter has no wall clock - instead,
 * `advance(cycles)` is a *polled* model: a driver (see `soc/bus.ts`'s
 * `tick()`) calls it once per `Cpu.step()` with that step's approximated
 * cycle cost (`cpu/cpu.ts`'s `Cpu.cycles`/`CYCLE_COST` - itself an honest
 * approximation, not real silicon timing). One "cycle" here is treated as
 * one APB clock cycle for the purposes of the reference's `apb_freq_hz`-
 * based tick formula (`ticks = elapsed / divider`) - a documented
 * assumption, not a fact about real hardware, since this interpreter has no
 * actual notion of CPU-clock-vs-APB-clock ratio.
 *
 * `T0CONFIG`/`T1CONFIG`'s `DIVIDER` field maps to a real divider value via
 * `esp32_timg_timer_div_from_reg` exactly as in the reference: raw 0 means
 * 65536, raw 1 or 2 both mean 2, anything else is used as-is. A genuinely
 * surprising reference detail worth flagging rather than "fixing": the
 * `ALARM` config bit is a one-shot "arm" flag that self-clears the moment
 * the alarm fires - `AUTORELOAD` reloads the *counter* value from
 * `TxLOAD`, but does **not** by itself keep the alarm re-armed for the next
 * cycle (`esp32_timg_timer_cb` sets its local `alarm` flag false before
 * reloading, and `esp32_timg_timer_update_alarm` bails immediately when
 * that flag is false) - so real firmware using autoreload must rewrite
 * `TxCONFIG` with `ALARM=1` again after each interrupt to keep receiving
 * them. Replicated here exactly via `alarmArmed`.
 *
 * WDT: `esp32_timg_wdt_update_config`'s stage-timeout pipeline is
 * implemented for real now - `advance()` counts WDT ticks (scaled by
 * `WDTCONFIG1`'s `PRESCALE`) against the current stage's configured
 * timeout (`WDTCONFIG2-5`); on timeout it performs that stage's configured
 * action (`off`/`interrupt`/`cpu-reset`/`system-reset`, `WDTCONFIG0`'s
 * `STG0-3` fields) and advances to the next stage (wrapping after 4),
 * matching `esp32_timg_wdt_cb`. `WDTFEED` resets the stage and counter back
 * to 0 (`esp32_timg_wdt_feed`) - no longer a no-op. Enabling the watchdog
 * (`WDTCONFIG0.EN` 0->1) resets stage/counter, matching
 * `esp32_timg_wdt_update_config`'s `en && !old_en` branch.
 *
 * `onInterruptChange?(source, active)` reports each of T0/T1/WDT's live
 * `INT_ENA & INT_RAW` condition, mirroring `esp32_timg_int_update` - called
 * only when a source's active state actually flips, the same shape
 * `peripherals/uart.ts`'s `onTx`/`soc/rtc_cntl.ts`'s `onReset` already use.
 * `soc/bus.ts` wires this to `IntMatrix.setSourceLevel` at the matching
 * `INTMATRIX_SOURCE.TG0_{T0,T1,WDT}` index.
 *
 * Not implemented: LACT (the legacy always-on RTC timer) and RTC
 * calibration registers; edge-triggered interrupts (`EDGE_INT` config bits
 * are decoded but ignored) - this repo's interrupt matrix only models
 * level-type lines for every peripheral so far (see `cpu/cpu.ts`'s own doc
 * comment on interrupt *type*), so only `LEVEL_INT`-gated behavior is
 * replicated; `WDTCONFIG0.FLASHBOOT_MODE_EN` (ties the watchdog to a
 * board-level "flash boot mode" flag this repo doesn't track); TIMG1 as a
 * second instance (only TIMG0 is wired into `soc/bus.ts` so far, though
 * this class itself is instance-agnostic and works for either); firing
 * more than once per `advance()` call when a single call's cycle delta is
 * large enough to cross an alarm/timeout more than once - harmless for the
 * intended one-`Cpu.step()`-at-a-time driving pattern, where each call's
 * cycle delta is tiny, but worth flagging for a caller batching many steps
 * into one `tick()`.
 */

/** Real reset default for T0CONFIG/T1CONFIG (esp32_timg_timer_reset): INCREASE|AUTORELOAD|DIVIDER=1. */
const TIMER_CONFIG_RESET = (1 << 30) | (1 << 29) | (1 << 13);

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
const U64 = (1n << 64n) - 1n;

/** WDTCONFIG0's per-stage STGn mode field values (Esp32TimgWdtStageMode). */
const WDT_MODE_OFF = 0;
const WDT_MODE_INT = 1;
const WDT_MODE_CPURESET = 2;
const WDT_MODE_SYSRESET = 3;

/** esp32_timg_timer_div_from_reg: the raw DIVIDER field's real divider value. */
function dividerFromReg(raw: number): number {
  if (raw === 0) return 65536;
  if (raw === 1 || raw === 2) return 2;
  return raw;
}

/** A general-purpose 64-bit up/down counter (T0 or T1) with a real alarm interrupt condition. */
class GpTimer {
  config = TIMER_CONFIG_RESET;
  counter = 0n;
  alarm = 0n;
  load = 0n;

  private enabled = false;
  private increase = true;
  private autoreload = true;
  private levelIntEn = false;
  /** The ALARM config bit's "armed" state - self-clears the instant the alarm fires, see this file's doc comment. */
  private alarmArmed = false;
  private divider = 2;
  /** Cycles left over from the last `advance()` that didn't add up to a whole tick yet. */
  private tickRemainder = 0n;

  constructor() {
    this.applyConfig();
  }

  private applyConfig(): void {
    this.enabled = (this.config & (1 << 31)) !== 0;
    this.increase = (this.config & (1 << 30)) !== 0;
    this.autoreload = (this.config & (1 << 29)) !== 0;
    this.divider = dividerFromReg((this.config >>> 13) & 0xffff);
    this.levelIntEn = (this.config & (1 << 11)) !== 0;
    this.alarmArmed = (this.config & (1 << 10)) !== 0;
  }

  /** TxCONFIG write: stores the raw register and re-derives every behavior field (esp32_timg_timer_update_config). */
  setConfig(value: number): void {
    this.config = value >>> 0;
    this.applyConfig();
  }

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

  /**
   * Advance the counter by `cycles` (scaled by the configured divider) and
   * report whether the alarm fired this call. Returns false without doing
   * anything if the timer isn't enabled - matches
   * `esp32_timg_timer_direction`'s `!en -> 0` case.
   */
  advance(cycles: bigint): boolean {
    if (!this.enabled) return false;

    const div = BigInt(this.divider);
    const total = this.tickRemainder + cycles;
    const ticks = total / div;
    this.tickRemainder = total % div;
    if (ticks === 0n) return false;

    const before = this.counter;
    const delta = this.increase ? ticks : -ticks;
    this.counter = (this.counter + delta) & U64;

    if (!this.alarmArmed) return false;
    const crossed = this.increase ? before < this.alarm && this.counter >= this.alarm : before > this.alarm && this.counter <= this.alarm;
    if (!crossed) return false;

    if (this.autoreload) this.counter = this.load;
    this.alarmArmed = false; // one-shot - see this file's doc comment
    return this.levelIntEn;
  }
}

/** WDTCONFIG0's four STGn (stage mode) fields, and WDTCONFIG2-5's four per-stage timeouts, indexed together. */
type WdtAction = 'off' | 'interrupt' | 'cpu-reset' | 'system-reset';

function wdtAction(mode: number): WdtAction {
  switch (mode) {
    case WDT_MODE_INT:
      return 'interrupt';
    case WDT_MODE_CPURESET:
      return 'cpu-reset';
    case WDT_MODE_SYSRESET:
      return 'system-reset';
    default:
      return 'off';
  }
}

export type TimgInterruptSource = 'T0' | 'T1' | 'WDT';

export class Timg {
  private readonly t0 = new GpTimer();
  private readonly t1 = new GpTimer();

  // WDT reset defaults, from esp32_timg_wdt_reset.
  private wdtConfig0 = 0x0004c000;
  private wdtConfig1 = 0x00010000;
  private readonly wdtTimeout = [0x018cba80, 0x07ffffff, 0x000fffff, 0x000fffff];
  private wdtProtect = WDT_PROTECT_WORD;

  private wdtEnabled = false;
  private wdtLevelIntEn = false;
  private wdtPrescale = 1;
  private wdtStage = 0;
  private wdtCounter = 0n;
  private wdtTickRemainder = 0n;

  private intEna = 0;
  private intRaw = 0;
  private readonly lastActive: Record<TimgInterruptSource, boolean> = { T0: false, T1: false, WDT: false };

  /** Called when T0/T1/WDT's live `INT_ENA & INT_RAW` condition changes - see this file's doc comment. */
  onInterruptChange?: (source: TimgInterruptSource, active: boolean) => void;
  /** Called when the WDT times out with STGn configured as CPU-reset or system-reset. */
  onWdtReset?: (kind: 'cpu' | 'system') => void;

  private wdtLocked(): boolean {
    return this.wdtProtect !== WDT_PROTECT_WORD;
  }

  private timerFor(offset: number): GpTimer | undefined {
    if (offset >= TIMG_REG.T0CONFIG && offset <= TIMG_REG.T0LOAD) return this.t0;
    if (offset >= TIMG_REG.T1CONFIG && offset <= TIMG_REG.T1LOAD) return this.t1;
    return undefined;
  }

  /** WDTCONFIG0/1 write: re-derive enabled/prescale, resetting stage/counter on a 0->1 EN transition (esp32_timg_wdt_update_config). */
  private applyWdtConfig(): void {
    const wasEnabled = this.wdtEnabled;
    this.wdtEnabled = (this.wdtConfig0 & (1 << 31)) !== 0;
    this.wdtLevelIntEn = (this.wdtConfig0 & (1 << 21)) !== 0;
    this.wdtPrescale = Math.max((this.wdtConfig1 >>> 16) & 0xffff, 1);

    if (this.wdtEnabled && !wasEnabled) {
      this.wdtStage = 0;
      this.wdtCounter = 0n;
    } else if (!this.wdtEnabled && wasEnabled) {
      this.setActive('WDT', false);
    }
  }

  private wdtStageMode(stage: number): number {
    return (this.wdtConfig0 >>> (29 - stage * 2)) & 0x3;
  }

  private setActive(source: TimgInterruptSource, active: boolean): void {
    if (this.lastActive[source] === active) return;
    this.lastActive[source] = active;
    this.onInterruptChange?.(source, active);
  }

  private setIntRaw(bit: number, source: TimgInterruptSource): void {
    this.intRaw |= bit;
    this.setActive(source, (this.intEna & bit) !== 0);
  }

  /** Advance T0/T1's counters and the WDT's stage countdown by `cycles` - see this file's doc comment. */
  advance(cycles: bigint): void {
    if (this.t0.advance(cycles)) this.setIntRaw(1 << 0, 'T0');
    if (this.t1.advance(cycles)) this.setIntRaw(1 << 1, 'T1');

    if (!this.wdtEnabled) return;
    const prescale = BigInt(this.wdtPrescale);
    const total = this.wdtTickRemainder + cycles;
    const ticks = total / prescale;
    this.wdtTickRemainder = total % prescale;
    if (ticks === 0n) return;

    this.wdtCounter += ticks;
    const timeout = BigInt(this.wdtTimeout[this.wdtStage]! >>> 0);
    if (this.wdtCounter < timeout) return;

    const action = wdtAction(this.wdtStageMode(this.wdtStage));
    if (action === 'interrupt' && this.wdtLevelIntEn) this.setIntRaw(1 << 2, 'WDT');
    else if (action === 'cpu-reset') this.onWdtReset?.('cpu');
    else if (action === 'system-reset') this.onWdtReset?.('system');

    this.wdtCounter = 0n;
    this.wdtStage = (this.wdtStage + 1) % this.wdtTimeout.length;
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
          t.setConfig(value);
          break;
        case TIMG_REG.T0UPDATE:
        case TIMG_REG.T1UPDATE:
          break; // no-op: TxLO/HI already reflect the live counter on every read
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
        if (!this.wdtLocked()) {
          this.wdtConfig0 = value >>> 0;
          this.applyWdtConfig();
        }
        break;
      case TIMG_REG.WDTCONFIG1:
        if (!this.wdtLocked()) {
          this.wdtConfig1 = value >>> 0;
          this.applyWdtConfig();
        }
        break;
      case TIMG_REG.WDTCONFIG2:
      case TIMG_REG.WDTCONFIG3:
      case TIMG_REG.WDTCONFIG4:
      case TIMG_REG.WDTCONFIG5:
        if (!this.wdtLocked()) this.wdtTimeout[(offset - TIMG_REG.WDTCONFIG2) / 4] = value >>> 0;
        break;
      case TIMG_REG.WDTFEED:
        // esp32_timg_wdt_feed: reset back to stage 0, no longer a no-op now that the WDT actually counts.
        if (!this.wdtLocked()) {
          this.wdtStage = 0;
          this.wdtCounter = 0n;
        }
        break;
      case TIMG_REG.WDTPROTECT:
        this.wdtProtect = value >>> 0; // always writable, regardless of lock state
        break;
      case TIMG_REG.INT_ENA:
        this.intEna = value >>> 0;
        this.setActive('T0', (this.intEna & this.intRaw & (1 << 0)) !== 0);
        this.setActive('T1', (this.intEna & this.intRaw & (1 << 1)) !== 0);
        this.setActive('WDT', (this.intEna & this.intRaw & (1 << 2)) !== 0);
        break;
      case TIMG_REG.INT_CLR:
        this.intRaw = (this.intRaw & ~value) >>> 0;
        this.setActive('T0', (this.intEna & this.intRaw & (1 << 0)) !== 0);
        this.setActive('T1', (this.intEna & this.intRaw & (1 << 1)) !== 0);
        this.setActive('WDT', (this.intEna & this.intRaw & (1 << 2)) !== 0);
        break;
      default:
        break;
    }
  }
}
