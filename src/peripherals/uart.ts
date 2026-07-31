/**
 * ESP32 UART peripheral - a real, baud-paced TX FIFO plus a real RX FIFO
 * (external byte injection) and real interrupt generation.
 *
 * Register offsets, field layouts, and read/write semantics are taken from
 * this repo's own pre-rewrite QEMU source (recoverable from git history at
 * `cae84de99b^`): `include/hw/esp32/esp32_uart.h` for the register map,
 * `hw/esp32/esp32_uart.c`'s `uart_read`/`uart_write`/`esp32_uart_update_irq`/
 * `uart_receive`/`esp32_uart_set_rx_timeout` for behavior.
 *
 * TX pacing is a deliberate departure from the reference, not an oversight -
 * worth being explicit about since this project otherwise matches the
 * reference's behavior exactly, quirks included. `uart_transmit` drains the
 * entire TX FIFO synchronously in one call, writing to the real chardev
 * backend with no timing delay at all - the reference's own source still
 * carries commented-out retry logic for a real async, non-blocking write
 * path that was evidently never finished. Rather than replicate that
 * known-incomplete stub, `advance(nanos)` (once `Cpu`/`SystemBus` started
 * providing real elapsed time - see `cpu/cpu.ts`'s `cpuFreqHz`) drains the
 * TX FIFO byte by byte over real time instead, using ordinary, universally
 * documented serial-frame timing (`frameNanos`, below) - not an Xtensa- or
 * ESP32-specific invention. `TXFIFO_EMPTY`/`TX_DONE`/`UART_STATUS`'s
 * `TXFIFO_CNT` now reflect this real queue depth and in-flight state,
 * rather than being hardcoded "always empty/never done" to match the
 * reference's own stub. `onTx` fires once a byte's transmit time has
 * actually elapsed, not synchronously at write time.
 *
 * RX is real now: `pushRx(byte)` (the external-stimulus entry point, same
 * shape as `Gpio.setPin`) feeds a FIFO (capped at the real `UART_FIFO_
 * LENGTH`=128) that `UART_FIFO` reads pop from - falling back to the
 * existing `0xEE` "empty" behavior only when the queue is empty, matching
 * `uart_read`'s own case; `UART_STATUS`'s `RXFIFO_CNT` reflects real depth.
 * Bytes beyond FIFO capacity are dropped, matching `uart_receive`'s own
 * `fifo8_num_free > 0` loop condition (no backpressure/"throttle" delay
 * modeling - that's about pacing a simulated external sender, meaningless
 * for a direct injection API where the caller already controls how many
 * bytes to push per call).
 *
 * `esp32_uart_update_irq`'s interrupt condition, ported directly:
 * `RXFIFO_FULL` (RX FIFO depth >= `UART_CONF1`'s `RXFIFO_FULL_THRD`),
 * `TXFIFO_EMPTY` (TX FIFO depth <= `TXFIFO_EMPTY_THRD`), `TX_DONE` (TX FIFO
 * depth != 0 - real now, see above), and `RXFIFO_TOUT` (an
 * idle-since-last-RX-event timeout - see below). All four combine into
 * `UART_INT_RAW`, `& UART_INT_ENA` into
 * `UART_INT_ST`, and the *combined* result (not per-bit) is this class's
 * `onInterruptChange` - matching the reference's single `qemu_irq irq`
 * output. A genuinely surprising reference quirk preserved rather than
 * "fixed": writing `UART_INT_CLR` only has one real effect - clearing the
 * `RXFIFO_TOUT` condition if that bit is set in the write - because
 * `uart_write` calls `esp32_uart_update_irq` unconditionally after *every*
 * register write, which immediately recomputes `INT_RAW`/`INT_ST` from the
 * live conditions above and overwrites whatever `INT_CLR`'s own direct
 * `INT_ST &= ~value` just did. A level-driven condition like `RXFIFO_FULL`
 * cannot actually be "cleared" by software while it's still true - only
 * reading more of the FIFO (lowering it below the threshold) does that.
 *
 * `RXFIFO_TOUT`'s idle timeout (`esp32_uart_set_rx_timeout`/
 * `uart_rx_timeout_timer_cb`) is real-time-based in the reference (an
 * absolute-ns `QEMUTimer`, armed for `rx_tout_thres` bit-times from now,
 * scaled by the configured baud rate) - and now that `Cpu`/`SystemBus` give
 * every peripheral real elapsed nanoseconds (`cpu/cpu.ts`'s `cpuFreqHz`/
 * `lastStepNanos`, `soc/bus.ts`'s `tick`), `advance(nanos)` can compute it
 * exactly the same way: `ns = rxToutThresBits * 1e9 / baudRate`, with
 * `baudRate` derived from `UART_CLKDIV`'s fixed-point divider exactly as
 * `uart_calc_baud` does (assuming the `TICK_REF_ALWAYS_ON`/80MHz-APB clock
 * path - the `REF_TICK` (1MHz) alternative `UART_CONF0` can select isn't
 * modeled). The timer is armed unconditionally by `pushRx` (matching
 * `uart_receive`'s own unconditional `esp32_uart_set_rx_timeout` call) and
 * by a `UART_CONF1` write - real hardware doesn't require the FIFO to
 * actually hold unread data for this timeout to eventually fire, a quirk
 * preserved here too.
 *
 * `frameNanos` (TX pacing's per-byte transmit time) reads `UART_CONF0`'s
 * real fields: `BIT_NUM` (data bits, 0-3 -> 5-8), `STOP_BIT_NUM` (1=1 stop
 * bit, 2=1.5, 3=2 - 1.5 is approximated as 1 here, a minor simplification
 * since fractional-bit timing isn't meaningful at this level of accuracy),
 * and `PARITY_EN` (an extra bit if set) - `1 start bit + data + parity +
 * stop` bits, divided by the real baud rate (`baudRate()`, above). Reset
 * defaults for these fields now match the reference's own
 * `esp32_uart_reset_hold` (`STOP_BIT_NUM=1`, `BIT_NUM=3` i.e. 8 data bits) -
 * previously untracked, since nothing read them before TX pacing existed.
 */

export const UART_REG = {
  FIFO: 0x00,
  INT_RAW: 0x04,
  INT_ST: 0x08,
  INT_ENA: 0x0c,
  INT_CLR: 0x10,
  CLKDIV: 0x14,
  AUTOBAUD: 0x18,
  STATUS: 0x1c,
  CONF0: 0x20,
  CONF1: 0x24,
  LOWPULSE: 0x28,
  HIGHPULSE: 0x2c,
  RXD_CNT: 0x30,
  MEM_CONF: 0x58,
  MEM_RX_STATUS: 0x60,
  DATE: 0x78,
} as const;

/** Byte size of the register window this peripheral occupies at its base address. */
export const UART_WINDOW_SIZE = 0x400;

/** UART_FIFO_LENGTH - the real RX/TX FIFO depth. */
const FIFO_LENGTH = 128;

const RXFIFO_FULL_BIT = 1 << 0;
const TXFIFO_EMPTY_BIT = 1 << 1;
const RXFIFO_TOUT_BIT = 1 << 8;
const TX_DONE_BIT = 1 << 14;

/** ESP32's real, fixed APB peripheral-bus clock - the TICK_REF_ALWAYS_ON path uart_calc_baud assumes (see class doc comment). */
const APB_FREQ_HZ = 80_000_000n;
const NANOS_PER_SECOND = 1_000_000_000n;

/** UART_CONF0 reset default (esp32_uart_reset_hold): TICK_REF_ALWAYS_ON=1, STOP_BIT_NUM=1, BIT_NUM=3 (8 data bits). */
const CONF0_RESET = (1 << 27) | (1 << 4) | (3 << 2);

export class Uart0 {
  private readonly regs = new Map<number, number>();
  private readonly rxFifo: number[] = [];
  /** TX FIFO - index 0 is the byte currently "in flight" (counting down `txBusyNanos`) once transmission has started. */
  private readonly txFifo: number[] = [];
  /** Real nanoseconds remaining to transmit `txFifo[0]`, or null if nothing is currently transmitting - see class doc comment. */
  private txBusyNanos: bigint | null = null;

  private intEna = 0;
  private intRaw = 0;
  private active = false;

  private txEmptyThreshold = 0;
  private rxFullThreshold = 0;
  private rxToutThresBits = 0; // esp32_uart_write's rx_tout_thres = 8 * TOUT_THRD, already pre-multiplied
  private rxToutEna = false;
  private rxfifoTout = false;
  /** Real nanoseconds remaining until the RX idle timeout fires, or null if not armed - see class doc comment. */
  private rxTimeoutNanos: bigint | null = null;

  private clkdivInt = 0x2b6; // reset default (esp32_uart_reset_hold)
  private clkdivFrag = 0;

  /** Called once a byte written to UART_FIFO actually finishes transmitting - see class doc comment on TX pacing. */
  onTx?: (byte: number) => void;
  /** Fires when the combined RXFIFO_FULL/TXFIFO_EMPTY/TX_DONE/RXFIFO_TOUT `& INT_ENA` condition changes. */
  onInterruptChange?: (active: boolean) => void;

  constructor() {
    this.regs.set(UART_REG.CONF0, CONF0_RESET);
  }

  /** Feed an externally-received byte into the RX FIFO (uart_receive) - dropped if the FIFO is already full. */
  pushRx(byte: number): void {
    if (this.rxFifo.length < FIFO_LENGTH) this.rxFifo.push(byte & 0xff);
    this.armRxTimeout(); // unconditional, matching uart_receive's own call - see class doc comment
    this.updateIrq();
  }

  /** Advance the RX idle-timeout countdown and TX pacing by `nanos` real elapsed nanoseconds - see class doc comment. */
  advance(nanos: bigint): void {
    if (this.rxTimeoutNanos !== null) {
      this.rxTimeoutNanos -= nanos;
      if (this.rxTimeoutNanos <= 0n) {
        this.rxTimeoutNanos = null;
        this.rxfifoTout = true;
      }
    }

    if (this.txBusyNanos !== null) {
      this.txBusyNanos -= nanos;
      // A loop, not a single check: one `advance()` call can span more than
      // one byte's transmit time (e.g. a caller batching several Cpu.step()s
      // worth of elapsed time into one call), so every byte that has
      // genuinely finished by now must fire onTx, not just the first.
      while (this.txBusyNanos !== null && this.txBusyNanos <= 0n) {
        const overshoot: bigint = -this.txBusyNanos;
        const byte = this.txFifo.shift();
        if (byte !== undefined) this.onTx?.(byte);
        this.txBusyNanos = this.txFifo.length > 0 ? this.frameNanos() - overshoot : null;
      }
    }

    this.updateIrq();
  }

  /** uart_calc_baud, TICK_REF_ALWAYS_ON path only (see class doc comment). */
  private baudRate(): bigint {
    const clkdivX16 = BigInt(this.clkdivInt) * 16n + BigInt(this.clkdivFrag);
    if (clkdivX16 === 0n) return 115_200n; // reset default, matches the reference's own clkdiv===0 fallback
    return (APB_FREQ_HZ * 16n) / clkdivX16;
  }

  /** Real transmit time for one byte, from UART_CONF0's framing fields and the real baud rate - see class doc comment. */
  private frameNanos(): bigint {
    const conf0 = this.regs.get(UART_REG.CONF0) ?? 0;
    const dataBits = [5, 6, 7, 8][(conf0 >>> 2) & 0x3]!;
    const stopBitNum = (conf0 >>> 4) & 0x3;
    const stopBits = stopBitNum === 3 ? 2 : 1; // 1.5 (raw=2) approximated as 1 - see class doc comment
    const parityBits = (conf0 & (1 << 1)) !== 0 ? 1 : 0;
    const bitsPerFrame = BigInt(1 + dataBits + parityBits + stopBits); // 1 start bit + frame
    return (bitsPerFrame * NANOS_PER_SECOND) / this.baudRate();
  }

  private armRxTimeout(): void {
    if (!this.rxToutEna) {
      this.rxTimeoutNanos = null;
      this.rxfifoTout = false;
      return;
    }
    // esp32_uart_set_rx_timeout: ns = rx_tout_thres bit-times / baud rate.
    this.rxTimeoutNanos = (BigInt(this.rxToutThresBits) * NANOS_PER_SECOND) / this.baudRate();
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.onInterruptChange?.(active);
  }

  private updateIrq(): void {
    let raw = 0;
    if (this.rxFifo.length >= this.rxFullThreshold) raw |= RXFIFO_FULL_BIT;
    if (this.txFifo.length <= this.txEmptyThreshold) raw |= TXFIFO_EMPTY_BIT;
    if (this.txFifo.length !== 0) raw |= TX_DONE_BIT;
    if (this.rxfifoTout) raw |= RXFIFO_TOUT_BIT;
    this.intRaw = raw;
    this.setActive((this.intRaw & this.intEna) !== 0);
  }

  private applyConf1(value: number): void {
    // RXFIFO_FULL_THRD @ bits[6:0], TXFIFO_EMPTY_THRD @ bits[14:8], TOUT_THRD @ bits[30:24], TOUT_EN @ bit31.
    this.rxFullThreshold = value & 0x7f;
    this.txEmptyThreshold = (value >>> 8) & 0x7f;
    this.rxToutThresBits = 8 * ((value >>> 24) & 0x7f);
    this.rxToutEna = (value & (1 << 31)) !== 0;
    this.armRxTimeout();
  }

  private applyClkdiv(value: number): void {
    this.clkdivInt = value & 0xfffff;
    this.clkdivFrag = (value >>> 20) & 0xf;
  }

  readWord(offset: number): number {
    switch (offset) {
      case UART_REG.FIFO:
        // Real hardware: reading an empty RX FIFO returns 0xEE and logs an
        // error (uart_read); here it pops the next real received byte.
        if (this.rxFifo.length === 0) return 0xee;
        return this.rxFifo.shift()!;
      case UART_REG.INT_RAW:
        return this.intRaw >>> 0;
      case UART_REG.INT_ST:
        return (this.intRaw & this.intEna) >>> 0;
      case UART_REG.INT_ENA:
        return this.intEna >>> 0;
      case UART_REG.STATUS:
        // RXFIFO_CNT (bits[7:0]) and TXFIFO_CNT (bits[23:16]) both reflect real depth now.
        return (this.rxFifo.length & 0xff) | ((this.txFifo.length & 0xff) << 16);
      case UART_REG.LOWPULSE:
      case UART_REG.HIGHPULSE:
        return 337; // fixed placeholder value in the reference (APB-frequency-dependent, marked FIXME there too)
      case UART_REG.MEM_CONF:
        // RX_SIZE (bits[6:3]) and TX_SIZE (bits[10:7]) = UART_FIFO_LENGTH/128 = 1 each.
        return (1 << 3) | (1 << 7);
      case UART_REG.MEM_RX_STATUS:
        // WR_ADDR (bits[23:13]) = RX FIFO depth, RD_ADDR (bits[12:2]) = 0 - "software only cares about the difference."
        return (this.rxFifo.length & 0x7ff) << 13;
      case UART_REG.DATE:
        return 0x15122500;
      default:
        return this.regs.get(offset) ?? 0;
    }
  }

  writeWord(offset: number, value: number): void {
    switch (offset) {
      case UART_REG.FIFO:
        // fifo8_push's own free-space check - dropped (not queued) once the 128-byte TX FIFO is full.
        if (this.txFifo.length < FIFO_LENGTH) {
          this.txFifo.push(value & 0xff);
          if (this.txBusyNanos === null) this.txBusyNanos = this.frameNanos(); // idle -> this byte starts transmitting now
        }
        break;
      case UART_REG.INT_ENA:
        this.intEna = value >>> 0;
        this.regs.set(offset, value >>> 0);
        break;
      case UART_REG.INT_CLR:
        // Only RXFIFO_TOUT's flag is really clearable - see class doc comment.
        if (value & RXFIFO_TOUT_BIT) this.rxfifoTout = false;
        this.regs.set(offset, value >>> 0);
        break;
      case UART_REG.INT_RAW:
      case UART_REG.STATUS:
        break; // no-op, matches uart_write's explicit cases
      case UART_REG.CONF1:
        this.regs.set(offset, value >>> 0);
        this.applyConf1(value >>> 0);
        break;
      case UART_REG.CLKDIV:
        this.regs.set(offset, value >>> 0);
        this.applyClkdiv(value >>> 0);
        break;
      default:
        this.regs.set(offset, value >>> 0);
        break;
    }
    this.updateIrq(); // unconditional after every write, matching uart_write's own trailing call
  }
}
