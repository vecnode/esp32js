import { describe, expect, it } from 'vitest';
import { Uart0, UART_REG } from '../../src/peripherals/uart.js';

describe('Uart0', () => {
  it('calls onTx with each byte once its real transmit time elapses (TX pacing)', () => {
    const uart = new Uart0();
    const bytes: number[] = [];
    uart.onTx = (b) => bytes.push(b);

    uart.writeWord(UART_REG.FIFO, 0x48); // 'H'
    uart.writeWord(UART_REG.FIFO, 0x69); // 'i'
    expect(bytes).toEqual([]); // queued, not yet transmitted

    uart.advance(1_000_000n); // 1ms - comfortably more than two bytes at any real baud rate
    expect(bytes).toEqual([0x48, 0x69]);
  });

  it('masks UART_FIFO writes to a single byte', () => {
    const uart = new Uart0();
    let last = -1;
    uart.onTx = (b) => (last = b);

    uart.writeWord(UART_REG.FIFO, 0x1ff); // only the low byte should reach onTx
    uart.advance(1_000_000n);
    expect(last).toBe(0xff);
  });

  it('reads UART_FIFO as 0xEE (empty RX FIFO, matching the reference)', () => {
    const uart = new Uart0();
    expect(uart.readWord(UART_REG.FIFO)).toBe(0xee);
  });

  it('UART_STATUS reflects a queued TX byte, and drops back to 0 once it transmits', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.FIFO, 0x41);
    expect(uart.readWord(UART_REG.STATUS)).toBe(1 << 16); // TXFIFO_CNT=1, RXFIFO_CNT=0

    uart.advance(1_000_000n);
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

  it('TXFIFO_EMPTY clears while a byte is queued/in-flight, and sets again once it transmits', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.FIFO, 0x41);
    expect(uart.readWord(UART_REG.INT_RAW) & TXFIFO_EMPTY).toBe(0);

    uart.advance(1_000_000n);
    expect(uart.readWord(UART_REG.INT_RAW) & TXFIFO_EMPTY).toBe(TXFIFO_EMPTY);
  });

  it('a real "print a string, then check RX" idiom works end to end', () => {
    const uart = new Uart0();
    const output: number[] = [];
    uart.onTx = (b) => output.push(b);
    uart.writeWord(UART_REG.FIFO, 'O'.charCodeAt(0));
    uart.writeWord(UART_REG.FIFO, 'K'.charCodeAt(0));
    uart.advance(1_000_000n);
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

describe('Uart0 TX pacing', () => {
  const TX_DONE = 1 << 14;
  // CLKDIV=2 (int part, frag=0) -> baudRate = 80MHz*16/(2*16) = 40MHz. The
  // default CONF0 (8 data bits, 1 stop, no parity - esp32_uart_reset_hold's
  // real reset default) is 10 bits/frame -> 10 * 1e9 / 40MHz = 250ns/byte.
  const CONF0_5N1 = (1 << 27) | (1 << 4) | (0 << 2); // BIT_NUM=0 -> 5 data bits, STOP_BIT_NUM=1

  it('drains multiple queued bytes within a single advance() call that spans more than one frame time', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.CLKDIV, 2);
    const bytes: number[] = [];
    uart.onTx = (b) => bytes.push(b);

    uart.writeWord(UART_REG.FIFO, 1);
    uart.writeWord(UART_REG.FIFO, 2);
    uart.writeWord(UART_REG.FIFO, 3);
    expect(bytes).toEqual([]); // all still queued/in-flight

    uart.advance(750n); // 3 * 250ns - exactly enough for all three
    expect(bytes).toEqual([1, 2, 3]);
  });

  it('a byte\'s transmit time depends on real UART_CONF0 framing fields (data/stop/parity bits)', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.CLKDIV, 2);
    uart.writeWord(UART_REG.CONF0, CONF0_5N1); // 1+5+0+1 = 7 bits/frame -> 175ns
    let fired = false;
    uart.onTx = () => (fired = true);

    uart.writeWord(UART_REG.FIFO, 1);
    uart.advance(174n);
    expect(fired).toBe(false);
    uart.advance(1n); // reaches 175ns
    expect(fired).toBe(true);
  });

  it('UART_STATUS TXFIFO_CNT and TX_DONE reflect real queue depth while bytes are in flight', () => {
    const uart = new Uart0();
    uart.writeWord(UART_REG.CLKDIV, 2);
    uart.writeWord(UART_REG.INT_ENA, TX_DONE);
    uart.writeWord(UART_REG.FIFO, 1);
    uart.writeWord(UART_REG.FIFO, 2);

    expect((uart.readWord(UART_REG.STATUS) >>> 16) & 0xff).toBe(2);
    expect(uart.readWord(UART_REG.INT_RAW) & TX_DONE).toBe(TX_DONE);

    uart.advance(750n); // comfortably drains both
    expect((uart.readWord(UART_REG.STATUS) >>> 16) & 0xff).toBe(0);
    expect(uart.readWord(UART_REG.INT_RAW) & TX_DONE).toBe(0);
  });

  it('drops bytes once the 128-byte TX FIFO is full, matching fifo8_push\'s own free-space check', () => {
    const uart = new Uart0();
    for (let i = 0; i < 130; i++) uart.writeWord(UART_REG.FIFO, i & 0xff);
    expect((uart.readWord(UART_REG.STATUS) >>> 16) & 0xff).toBe(128);
  });
});
