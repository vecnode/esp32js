import { describe, expect, it } from 'vitest';
import { Timg, TIMG_REG } from '../../src/peripherals/timer.js';

const T0_EN = 1 << 31;
const T0_INCREASE = 1 << 30;
const T0_AUTORELOAD = 1 << 29;
const T0_LEVEL_INT = 1 << 11;
const T0_ALARM = 1 << 10;
/** EN|INCREASE|AUTORELOAD|LEVEL_INT|ALARM, divider=1 (raw 1 -> real divider 2). */
const T0_CONFIG_RUNNING = T0_EN | T0_INCREASE | T0_AUTORELOAD | T0_LEVEL_INT | T0_ALARM | (1 << 13);

describe('Timg', () => {
  it('T0CONFIG resets to INCREASE|AUTORELOAD|DIVIDER=1 (esp32_timg_timer_reset), matching the real default', () => {
    const timg = new Timg();
    expect(timg.readWord(TIMG_REG.T0CONFIG)).toBe(T0_INCREASE | T0_AUTORELOAD | (1 << 13));
  });

  it('T0CONFIG round-trips a plain register value', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.T0CONFIG, 0xabcdef01);
    expect(timg.readWord(TIMG_REG.T0CONFIG)).toBe(0xabcdef01 >>> 0);
  });

  it('T0LOADLO/HI stage a 64-bit value, committed to T0LO/HI only by T0LOAD', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.T0LOADLO, 0x12345678);
    timg.writeWord(TIMG_REG.T0LOADHI, 0x9abcdef0);

    // Not committed yet - the live counter is untouched.
    expect(timg.readWord(TIMG_REG.T0LO)).toBe(0);
    expect(timg.readWord(TIMG_REG.T0HI)).toBe(0);

    timg.writeWord(TIMG_REG.T0LOAD, 0); // any value triggers the commit
    expect(timg.readWord(TIMG_REG.T0LO)).toBe(0x12345678);
    expect(timg.readWord(TIMG_REG.T0HI)).toBe(0x9abcdef0);
  });

  it('T0UPDATE is a no-op - there is no free-running clock to sample', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.T0LOADLO, 42);
    timg.writeWord(TIMG_REG.T0LOAD, 0);
    timg.writeWord(TIMG_REG.T0UPDATE, 0);
    expect(timg.readWord(TIMG_REG.T0LO)).toBe(42);
  });

  it('T1 is independent of T0', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.T0LOADLO, 1);
    timg.writeWord(TIMG_REG.T0LOAD, 0);
    timg.writeWord(TIMG_REG.T1LOADLO, 2);
    timg.writeWord(TIMG_REG.T1LOAD, 0);

    expect(timg.readWord(TIMG_REG.T0LO)).toBe(1);
    expect(timg.readWord(TIMG_REG.T1LO)).toBe(2);
  });

  it('T0ALARMLO/HI round-trip independently of the counter', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.T0ALARMLO, 0x1111);
    timg.writeWord(TIMG_REG.T0ALARMHI, 0x2222);
    expect(timg.readWord(TIMG_REG.T0ALARMLO)).toBe(0x1111);
    expect(timg.readWord(TIMG_REG.T0ALARMHI)).toBe(0x2222);
  });

  it('resets with the WDT reset defaults from esp32_timg_wdt_reset', () => {
    const timg = new Timg();
    expect(timg.readWord(TIMG_REG.WDTCONFIG0)).toBe(0x0004c000);
    expect(timg.readWord(TIMG_REG.WDTCONFIG1)).toBe(0x00010000);
    expect(timg.readWord(TIMG_REG.WDTCONFIG2)).toBe(0x018cba80);
    expect(timg.readWord(TIMG_REG.WDTCONFIG3)).toBe(0x07ffffff);
    expect(timg.readWord(TIMG_REG.WDTPROTECT)).toBe(0x50d83aa1);
  });

  it('WDT config writes are ignored while locked (protect != magic word)', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.WDTPROTECT, 0); // lock it (any non-magic value)
    timg.writeWord(TIMG_REG.WDTCONFIG0, 0xffffffff);
    expect(timg.readWord(TIMG_REG.WDTCONFIG0)).toBe(0x0004c000); // unchanged
  });

  it('WDT config writes succeed once unlocked with the magic word', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1); // unlock
    timg.writeWord(TIMG_REG.WDTCONFIG0, 0x11111111);
    expect(timg.readWord(TIMG_REG.WDTCONFIG0)).toBe(0x11111111);
  });

  it('WDTPROTECT itself is always writable regardless of lock state', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.WDTPROTECT, 0xdeadbeef);
    expect(timg.readWord(TIMG_REG.WDTPROTECT)).toBe(0xdeadbeef >>> 0);
    timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
    expect(timg.readWord(TIMG_REG.WDTPROTECT)).toBe(0x50d83aa1);
  });

  it('a common boot idiom - disabling the WDT via unlock + EN=0 - works end to end', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
    timg.writeWord(TIMG_REG.WDTCONFIG0, 0); // EN bit (31) cleared
    timg.writeWord(TIMG_REG.WDTPROTECT, 0); // re-lock
    expect(timg.readWord(TIMG_REG.WDTCONFIG0)).toBe(0);
    // Further writes are ignored again now that it's locked.
    timg.writeWord(TIMG_REG.WDTCONFIG0, 0xffffffff);
    expect(timg.readWord(TIMG_REG.WDTCONFIG0)).toBe(0);
  });

  it('INT_ENA/INT_ST reflect INT_RAW once a real interrupt condition exists (see advance() tests below)', () => {
    const timg = new Timg();
    timg.writeWord(TIMG_REG.INT_ENA, 0b1111);
    expect(timg.readWord(TIMG_REG.INT_ENA)).toBe(0b1111);
    expect(timg.readWord(TIMG_REG.INT_RAW)).toBe(0); // nothing has fired yet
    expect(timg.readWord(TIMG_REG.INT_ST)).toBe(0);
  });

  // advance() now takes real elapsed nanoseconds (see timer.ts's doc comment): at
  // the real 80MHz APB clock, one APB tick is 12.5ns. With DIVIDER raw=1 (real
  // divider 2, used throughout below), one counter tick is 25ns - so N ticks is
  // N*25 nanoseconds. The WDT tests use PRESCALE=8 (100ns/tick) for round numbers.
  describe('advance() - T0/T1 counters and alarms', () => {
    it('does not advance the counter while disabled (EN=0, the reset default)', () => {
      const timg = new Timg();
      timg.advance(1_000_000n);
      expect(timg.readWord(TIMG_REG.T0LO)).toBe(0);
    });

    it('advances the counter by real APB ticks (scaled by DIVIDER) once enabled', () => {
      const timg = new Timg();
      timg.writeWord(TIMG_REG.T0CONFIG, T0_EN | T0_INCREASE | (1 << 13)); // divider raw=1 -> real divider 2
      timg.advance(125n); // 125ns / 25ns-per-tick = 5 ticks
      expect(timg.readWord(TIMG_REG.T0LO)).toBe(5);
      timg.advance(30n); // 30ns -> 1 more tick (25ns), 5ns carried as remainder
      expect(timg.readWord(TIMG_REG.T0LO)).toBe(6);
    });

    it('fires the alarm and calls onInterruptChange when the counter reaches ALARM (level-int enabled)', () => {
      const timg = new Timg();
      const events: Array<[string, boolean]> = [];
      timg.onInterruptChange = (source, active) => events.push([source, active]);
      timg.writeWord(TIMG_REG.T0ALARMLO, 5);
      timg.writeWord(TIMG_REG.T0CONFIG, T0_CONFIG_RUNNING);
      timg.writeWord(TIMG_REG.INT_ENA, 0b1); // T0

      timg.advance(125n); // 5 ticks, counter reaches the alarm exactly
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b1).toBe(0b1);
      expect(events).toEqual([['T0', true]]);
    });

    it('does not fire without LEVEL_INT set, even if the counter reaches ALARM', () => {
      const timg = new Timg();
      timg.writeWord(TIMG_REG.T0ALARMLO, 5);
      timg.writeWord(TIMG_REG.T0CONFIG, T0_EN | T0_INCREASE | T0_AUTORELOAD | T0_ALARM | (1 << 13));
      timg.advance(125n);
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b1).toBe(0);
    });

    it('autoreload reloads the counter from TxLOAD on alarm, but ALARM self-clears (one-shot) until rearmed', () => {
      const timg = new Timg();
      timg.writeWord(TIMG_REG.T0LOADLO, 100);
      timg.writeWord(TIMG_REG.T0ALARMLO, 5);
      timg.writeWord(TIMG_REG.T0CONFIG, T0_CONFIG_RUNNING);
      timg.writeWord(TIMG_REG.INT_ENA, 0b1);

      timg.advance(125n); // reaches alarm(5) exactly, fires once
      expect(timg.readWord(TIMG_REG.T0LO)).toBe(100); // reloaded from TxLOAD
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b1).toBe(0b1);

      timg.writeWord(TIMG_REG.INT_CLR, 0b1);
      timg.advance(125n); // counter now well past 5 again, but ALARM never got rewritten -> no second fire
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b1).toBe(0);

      // Rearm: set a new alarm ahead of the counter's current position (105) and rewrite CONFIG with ALARM=1.
      timg.writeWord(TIMG_REG.T0ALARMLO, 110);
      timg.writeWord(TIMG_REG.T0CONFIG, T0_CONFIG_RUNNING);
      timg.advance(125n); // counter 105 -> 110, crosses the new alarm
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b1).toBe(0b1);
    });

    it('without autoreload, the counter keeps running past the alarm instead of reloading', () => {
      const timg = new Timg();
      timg.writeWord(TIMG_REG.T0ALARMLO, 5);
      timg.writeWord(TIMG_REG.T0CONFIG, T0_EN | T0_INCREASE | T0_LEVEL_INT | T0_ALARM | (1 << 13));
      timg.advance(125n); // 5 ticks
      expect(timg.readWord(TIMG_REG.T0LO)).toBe(5); // not reloaded - autoreload is off
    });

    it('T0 and T1 advance independently', () => {
      const timg = new Timg();
      timg.writeWord(TIMG_REG.T0CONFIG, T0_EN | T0_INCREASE | (1 << 13));
      timg.advance(125n);
      expect(timg.readWord(TIMG_REG.T0LO)).toBe(5);
      expect(timg.readWord(TIMG_REG.T1LO)).toBe(0); // T1 never enabled
    });
  });

  describe('advance() - WDT stage timeout pipeline', () => {
    it('does nothing while the WDT is disabled (EN=0, the reset default)', () => {
      const timg = new Timg();
      timg.advance(10_000_000_000n);
      // No observable state to check directly, but this must not throw and INT_RAW stays clear.
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b100).toBe(0);
    });

    it('fires an interrupt when stage 0 is configured as WDT_MODE_INT and times out', () => {
      const timg = new Timg();
      const events: Array<[string, boolean]> = [];
      timg.onInterruptChange = (source, active) => events.push([source, active]);
      timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
      timg.writeWord(TIMG_REG.WDTCONFIG2, 5); // stage 0 timeout = 5 ticks
      // EN | STG0=1 (interrupt) | LEVEL_INT
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (1 << 29) | (1 << 21));
      timg.writeWord(TIMG_REG.WDTCONFIG1, 8 << 16); // prescale=8 -> 100ns/tick
      timg.writeWord(TIMG_REG.INT_ENA, 0b100);

      timg.advance(500n); // 5 ticks
      expect(timg.readWord(TIMG_REG.INT_RAW) & 0b100).toBe(0b100);
      expect(events).toEqual([['WDT', true]]);
    });

    it('calls onWdtReset("cpu") when a stage is configured as WDT_MODE_CPURESET', () => {
      const timg = new Timg();
      let resetKind: string | undefined;
      timg.onWdtReset = (kind) => (resetKind = kind);
      timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
      timg.writeWord(TIMG_REG.WDTCONFIG2, 3);
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (2 << 29)); // EN | STG0=2 (cpu-reset)
      timg.writeWord(TIMG_REG.WDTCONFIG1, 8 << 16);

      timg.advance(300n); // 3 ticks
      expect(resetKind).toBe('cpu');
    });

    it('calls onWdtReset("system") when a stage is configured as WDT_MODE_SYSRESET', () => {
      const timg = new Timg();
      let resetKind: string | undefined;
      timg.onWdtReset = (kind) => (resetKind = kind);
      timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
      timg.writeWord(TIMG_REG.WDTCONFIG2, 3);
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (3 << 29)); // EN | STG0=3 (system-reset)
      timg.writeWord(TIMG_REG.WDTCONFIG1, 8 << 16);

      timg.advance(300n); // 3 ticks
      expect(resetKind).toBe('system');
    });

    it('advances to stage 1 after stage 0 times out', () => {
      const timg = new Timg();
      const events: Array<[string, boolean]> = [];
      timg.onInterruptChange = (source, active) => events.push([source, active]);
      timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
      timg.writeWord(TIMG_REG.WDTCONFIG2, 3); // stage 0 timeout
      timg.writeWord(TIMG_REG.WDTCONFIG3, 3); // stage 1 timeout
      // EN | STG0=1 (int) | STG1=1 (int) | LEVEL_INT
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (1 << 29) | (1 << 27) | (1 << 21));
      timg.writeWord(TIMG_REG.WDTCONFIG1, 8 << 16);
      timg.writeWord(TIMG_REG.INT_ENA, 0b100);

      timg.advance(300n); // stage 0 times out (3 ticks), fires
      expect(events).toEqual([['WDT', true]]);
      timg.writeWord(TIMG_REG.INT_CLR, 0b100);

      timg.advance(300n); // stage 1 times out too (counter reset to 0 after stage 0)
      expect(events).toEqual([
        ['WDT', true],
        ['WDT', false],
        ['WDT', true],
      ]);
    });

    it('WDTFEED resets the stage and counter back to 0', () => {
      const timg = new Timg();
      let fired = false;
      timg.onInterruptChange = () => (fired = true);
      timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
      timg.writeWord(TIMG_REG.WDTCONFIG2, 5);
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (1 << 29) | (1 << 21));
      timg.writeWord(TIMG_REG.WDTCONFIG1, 8 << 16);
      timg.writeWord(TIMG_REG.INT_ENA, 0b100);

      timg.advance(300n); // 3 of 5 ticks - most of the way to the stage-0 timeout
      timg.writeWord(TIMG_REG.WDTFEED, 1 << 31); // feed - resets the countdown

      timg.advance(300n); // would have timed out at 6 ticks without the feed
      expect(fired).toBe(false);
    });

    it('enabling the WDT (EN 0->1) resets stage and counter, matching esp32_timg_wdt_update_config', () => {
      const timg = new Timg();
      timg.writeWord(TIMG_REG.WDTPROTECT, 0x50d83aa1);
      timg.writeWord(TIMG_REG.WDTCONFIG2, 5);
      timg.writeWord(TIMG_REG.WDTCONFIG1, 8 << 16);

      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (1 << 29) | (1 << 21)); // enable
      timg.advance(300n);
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 29) | (1 << 21)); // disable (EN cleared)
      timg.writeWord(TIMG_REG.WDTCONFIG0, (1 << 31) | (1 << 29) | (1 << 21)); // re-enable - resets counter

      let fired = false;
      timg.onInterruptChange = () => (fired = true);
      timg.advance(300n); // only 3 more ticks since re-enable, not 6 - shouldn't reach the stage-0 timeout of 5
      expect(fired).toBe(false);
    });
  });
});
