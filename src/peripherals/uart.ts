/**
 * ESP32 UART peripheral - TX path only.
 *
 * Register offsets, field layouts, and read/write semantics are taken from
 * this repo's own pre-rewrite QEMU source (recoverable from git history at
 * `cae84de99b^`): `include/hw/esp32/esp32_uart.h` for the register map,
 * `hw/esp32/esp32_uart.c`'s `uart_read`/`uart_write` for behavior. Note the
 * real file lives at `hw/esp32/esp32_uart.c`, not `hw/char/esp32_uart.c` as
 * an earlier revision of ARCHITECTURE.md said - corrected there too.
 *
 * Scope: writing UART_FIFO is the one thing implemented with real
 * side-effecting behavior (calling `onTx`), because in this fork's
 * simplified model (`uart_transmit`) a FIFO write drains synchronously -
 * there's no actual queueing to model, unlike real async serial hardware.
 * Every other register is either a fixed/computed read value taken directly
 * from `uart_read`'s switch cases (UART_STATUS, UART_LOWPULSE/HIGHPULSE,
 * UART_MEM_CONF, UART_MEM_RX_STATUS, UART_DATE) or plain read/write storage
 * with no behavior (UART_CLKDIV, UART_CONF0/1, UART_INT_ENA, etc. - matches
 * `uart_write`'s `default: s->reg[addr/4] = value` fallthrough).
 *
 * Explicitly NOT implemented (real hardware behavior that would require
 * more than register storage): RX (UART_FIFO always reads 0xEE, matching
 * `uart_read`'s own "FIFO empty" case - not a real receive path), interrupt
 * generation (UART_INT_RAW/ST would need `esp32_uart_update_irq` and a wired
 * interrupt matrix, which doesn't exist yet - Phase 4), and baud-rate
 * timing (UART_CLKDIV is stored but nothing reads it back to pace anything,
 * since this interpreter has no real-time notion to pace against).
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

export class Uart0 {
  private readonly regs = new Map<number, number>();

  /** Called with each byte written to UART_FIFO - the "transmitted" byte. */
  onTx?: (byte: number) => void;

  readWord(offset: number): number {
    switch (offset) {
      case UART_REG.FIFO:
        // Real hardware: reading an empty RX FIFO returns 0xEE and logs an
        // error (uart_read); RX is never populated here, so it's always empty.
        return 0xee;
      case UART_REG.STATUS:
        // RXFIFO_CNT and TXFIFO_CNT both 0: no RX, and TX drains synchronously.
        return 0;
      case UART_REG.LOWPULSE:
      case UART_REG.HIGHPULSE:
        return 337; // fixed placeholder value in the reference (APB-frequency-dependent, marked FIXME there too)
      case UART_REG.MEM_CONF:
        // RX_SIZE (bits[6:3]) and TX_SIZE (bits[10:7]) = UART_FIFO_LENGTH/128 = 1 each.
        return (1 << 3) | (1 << 7);
      case UART_REG.MEM_RX_STATUS:
        return 0; // WR_ADDR = 0 (no RX data buffered)
      case UART_REG.DATE:
        return 0x15122500;
      default:
        return this.regs.get(offset) ?? 0;
    }
  }

  writeWord(offset: number, value: number): void {
    switch (offset) {
      case UART_REG.FIFO:
        this.onTx?.(value & 0xff);
        break;
      case UART_REG.INT_RAW:
      case UART_REG.INT_ST:
      case UART_REG.STATUS:
        break; // no-op, matches uart_write's explicit cases
      case UART_REG.INT_CLR:
        this.regs.set(UART_REG.INT_ST, (this.regs.get(UART_REG.INT_ST) ?? 0) & ~value);
        this.regs.set(offset, value >>> 0);
        break;
      default:
        this.regs.set(offset, value >>> 0);
        break;
    }
  }
}
