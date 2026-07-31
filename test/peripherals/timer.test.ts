import { describe, expect, it } from 'vitest';
import { Timg, TIMG_REG } from '../../src/peripherals/timer.js';

describe('Timg', () => {
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

  it('INT_ENA/INT_RAW/INT_CLR/INT_ST behave as plain enable/raw/status registers', () => {
    const timg = new Timg();
    expect(timg.readWord(TIMG_REG.INT_RAW)).toBe(0); // nothing ever sets it - see module doc comment
    timg.writeWord(TIMG_REG.INT_ENA, 0b1111);
    expect(timg.readWord(TIMG_REG.INT_ENA)).toBe(0b1111);
    expect(timg.readWord(TIMG_REG.INT_ST)).toBe(0); // INT_ENA & INT_RAW, and RAW is always 0 here
  });
});
