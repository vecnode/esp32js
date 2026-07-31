import { describe, expect, it } from 'vitest';
import { Uart0, UART_REG } from '../../src/peripherals/uart.js';

describe('Uart0', () => {
  it('calls onTx with each byte written to UART_FIFO', () => {
    const uart = new Uart0();
    const bytes: number[] = [];
    uart.onTx = (b) => bytes.push(b);

    uart.writeWord(UART_REG.FIFO, 0x48); // 'H'
    uart.writeWord(UART_REG.FIFO, 0x69); // 'i'

    expect(bytes).toEqual([0x48, 0x69]);
  });

  it('masks UART_FIFO writes to a single byte', () => {
    const uart = new Uart0();
    let last = -1;
    uart.onTx = (b) => (last = b);

    uart.writeWord(UART_REG.FIFO, 0x1ff); // only the low byte should reach onTx
    expect(last).toBe(0xff);
  });

  it('reads UART_FIFO as 0xEE (empty RX FIFO, matching the reference)', () => {
    const uart = new Uart0();
    expect(uart.readWord(UART_REG.FIFO)).toBe(0xee);
  });

  it('reads UART_STATUS as 0 (no RX, TX drains synchronously)', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.FIFO, 0x41);
    expect(uart.readWord(UART_REG.STATUS)).toBe(0);
  });

  it('reads fixed values for LOWPULSE/HIGHPULSE/MEM_CONF/MEM_RX_STATUS/DATE', () => {
    const uart = new Uart0();
    expect(uart.readWord(UART_REG.LOWPULSE)).toBe(337);
    expect(uart.readWord(UART_REG.HIGHPULSE)).toBe(337);
    expect(uart.readWord(UART_REG.MEM_CONF)).toBe((1 << 3) | (1 << 7));
    expect(uart.readWord(UART_REG.MEM_RX_STATUS)).toBe(0);
    expect(uart.readWord(UART_REG.DATE)).toBe(0x15122500);
  });

  it('round-trips plain storage registers like CONF0/CLKDIV', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.CONF0, 0x12345678);
    uart.writeWord(UART_REG.CLKDIV, 0xabcdef);

    expect(uart.readWord(UART_REG.CONF0)).toBe(0x12345678);
    expect(uart.readWord(UART_REG.CLKDIV)).toBe(0xabcdef);
  });

  it('INT_RAW/INT_ST/STATUS writes are no-ops', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.INT_RAW, 0xffffffff);
    uart.writeWord(UART_REG.INT_ST, 0xffffffff);
    uart.writeWord(UART_REG.STATUS, 0xffffffff);

    expect(uart.readWord(UART_REG.INT_RAW)).toBe(0);
    expect(uart.readWord(UART_REG.INT_ST)).toBe(0);
    expect(uart.readWord(UART_REG.STATUS)).toBe(0);
  });

  it('INT_CLR stores its own written value (readable back via its own offset)', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.INT_CLR, 0b0011);
    expect(uart.readWord(UART_REG.INT_CLR)).toBe(0b0011);
  });
});
