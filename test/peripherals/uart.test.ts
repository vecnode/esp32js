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

  it('writing INT_RAW/INT_ST/STATUS never sticks - they always reflect live conditions, not the written value', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.INT_RAW, 0xffffffff);
    uart.writeWord(UART_REG.INT_ST, 0xffffffff);
    uart.writeWord(UART_REG.STATUS, 0xffffffff);

    // INT_ENA is still 0, so INT_ST (INT_RAW & INT_ENA) reads 0 regardless of INT_RAW's live value.
    expect(uart.readWord(UART_REG.INT_ST)).toBe(0);
    expect(uart.readWord(UART_REG.STATUS) & 0xff).toBe(0); // RXFIFO_CNT - no bytes pushed
  });

  it('INT_CLR stores its own written value (readable back via its own offset)', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.INT_CLR, 0b0011);
    expect(uart.readWord(UART_REG.INT_CLR)).toBe(0b0011);
  });
});

describe('Uart0 RX injection and interrupts', () => {
  const RXFIFO_FULL = 1 << 0;
  const TXFIFO_EMPTY = 1 << 1;
  const RXFIFO_TOUT = 1 << 8;
  const conf1 = (rxFullThrd: number, txEmptyThrd: number, toutThrd: number, toutEn: boolean) =>
    ((toutEn ? 1 << 31 : 0) | ((toutThrd & 0x7f) << 24) | ((txEmptyThrd & 0x7f) << 8) | (rxFullThrd & 0x7f)) >>> 0;

  it('pushRx feeds UART_FIFO reads and UART_STATUS RXFIFO_CNT, dropping bytes once the 128-byte FIFO is full', () => {
    const uart = new Uart0();
    uart.pushRx(0x48); // 'H'
    uart.pushRx(0x69); // 'i'
    expect(uart.readWord(UART_REG.STATUS) & 0xff).toBe(2);
    expect(uart.readWord(UART_REG.FIFO)).toBe(0x48);
    expect(uart.readWord(UART_REG.FIFO)).toBe(0x69);
    expect(uart.readWord(UART_REG.FIFO)).toBe(0xee); // empty again

    for (let i = 0; i < 200; i++) uart.pushRx(i & 0xff); // well past 128
    expect(uart.readWord(UART_REG.STATUS) & 0xff).toBe(128);
  });

  it('RXFIFO_FULL_THRD=0 (the reset default) means the RXFIFO_FULL condition is trivially always true', () => {
    // Matches the reference literally: fifo8_num_used >= 0 is always true.
    const uart = new Uart0();
    uart.writeWord(UART_REG.INT_ENA, RXFIFO_FULL);
    expect(uart.readWord(UART_REG.INT_ST) & RXFIFO_FULL).toBe(RXFIFO_FULL);
  });

  it('RXFIFO_FULL fires onInterruptChange once the RX FIFO reaches CONF1.RXFIFO_FULL_THRD', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.CONF1, conf1(2, 0, 0, false));
    uart.writeWord(UART_REG.INT_ENA, RXFIFO_FULL);
    const events: boolean[] = [];
    uart.onInterruptChange = (active) => events.push(active);

    uart.pushRx(1); // depth 1 < threshold 2
    expect(events).toEqual([]);
    uart.pushRx(2); // depth 2 >= threshold 2
    expect(events).toEqual([true]);
  });

  it('TXFIFO_EMPTY is always set (TX drains synchronously) - see class doc comment', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.FIFO, 0x41); // any write triggers a recompute, same as real hardware
    expect(uart.readWord(UART_REG.INT_RAW) & TXFIFO_EMPTY).toBe(TXFIFO_EMPTY);
  });

  it('a real "print a string, then check RX" idiom works end to end', () => {
    const uart = new Uart0();
    const output: number[] = [];
    uart.onTx = (b) => output.push(b);
    uart.writeWord(UART_REG.FIFO, 'O'.charCodeAt(0));
    uart.writeWord(UART_REG.FIFO, 'K'.charCodeAt(0));
    expect(output).toEqual([0x4f, 0x4b]);

    uart.pushRx('Y'.charCodeAt(0));
    expect(uart.readWord(UART_REG.FIFO)).toBe(0x59);
  });

  describe('advance() - RXFIFO_TOUT idle timeout', () => {
    it('does nothing while TOUT_EN is 0 (the reset default)', () => {
      const uart = new Uart0();
      uart.pushRx(1);
      uart.advance(1_000_000n);
      expect(uart.readWord(UART_REG.INT_RAW) & RXFIFO_TOUT).toBe(0);
    });

    // CLKDIV=2 (int part, frag=0) -> baudRate = 80MHz*16/(2*16) = 40MHz;
    // TOUT_THRD=1 -> rx_tout_thres=8 bits -> timeout = 8 * 1e9 / 40MHz = 200ns.
    it('fires RXFIFO_TOUT and onInterruptChange once the idle period elapses', () => {
      const uart = new Uart0();
      uart.writeWord(UART_REG.CLKDIV, 2);
      uart.writeWord(UART_REG.CONF1, conf1(0, 0, 1, true));
      uart.writeWord(UART_REG.INT_ENA, RXFIFO_TOUT);
      const events: boolean[] = [];
      uart.onInterruptChange = (active) => events.push(active);

      uart.pushRx(1); // arms a 200ns timeout
      uart.advance(199n);
      expect(events).toEqual([]);
      uart.advance(1n); // reaches 200ns
      expect(events).toEqual([true]);
      expect(uart.readWord(UART_REG.INT_RAW) & RXFIFO_TOUT).toBe(RXFIFO_TOUT);
    });

    it('a new pushRx re-arms (resets) the idle countdown', () => {
      const uart = new Uart0();
      uart.writeWord(UART_REG.CLKDIV, 2);
      uart.writeWord(UART_REG.CONF1, conf1(0, 0, 1, true));

      uart.pushRx(1); // arms a 200ns countdown
      uart.advance(199n);
      uart.pushRx(2); // re-arms - back to a fresh 200ns countdown
      uart.advance(199n);
      expect(uart.readWord(UART_REG.INT_RAW) & RXFIFO_TOUT).toBe(0);
    });

    it('INT_CLR with the RXFIFO_TOUT bit is the one write that actually clears it', () => {
      const uart = new Uart0();
      uart.writeWord(UART_REG.CLKDIV, 2);
      uart.writeWord(UART_REG.CONF1, conf1(0, 0, 1, true));
      uart.writeWord(UART_REG.INT_ENA, RXFIFO_TOUT);
      uart.pushRx(1);
      uart.advance(200n);
      expect(uart.readWord(UART_REG.INT_RAW) & RXFIFO_TOUT).toBe(RXFIFO_TOUT);

      const events: boolean[] = [];
      uart.onInterruptChange = (active) => events.push(active);
      uart.writeWord(UART_REG.INT_CLR, RXFIFO_TOUT);
      expect(events).toEqual([false]);
      expect(uart.readWord(UART_REG.INT_RAW) & RXFIFO_TOUT).toBe(0);
    });
  });
});
