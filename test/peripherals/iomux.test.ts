import { describe, expect, it } from 'vitest';
import { IoMux } from '../../src/peripherals/iomux.js';

describe('IoMux', () => {
  it('resets every documented pin register to 0x800 (esp32_iomux_reset_enter)', () => {
    const iomux = new IoMux();
    for (const pin of [0, 5, 12, 24, 27, 32, 39]) {
      const offset = IoMux.offsetForPin(pin)!;
      expect(iomux.readWord(offset)).toBe(0x800);
    }
  });

  it('round-trips a write/read at pin 0 (offset 0x44)', () => {
    const iomux = new IoMux();
    iomux.writeWord(0x44, 0x123);
    expect(iomux.readWord(0x44)).toBe(0x123);
    // untouched pins remain at reset default
    expect(iomux.readWord(IoMux.offsetForPin(1)!)).toBe(0x800);
  });

  it('round-trips every documented pin at its own offset independently', () => {
    const iomux = new IoMux();
    for (const pin of [2, 9, 14, 25, 33, 36]) {
      const offset = IoMux.offsetForPin(pin)!;
      iomux.writeWord(offset, 0x1000 | pin);
    }
    for (const pin of [2, 9, 14, 25, 33, 36]) {
      const offset = IoMux.offsetForPin(pin)!;
      expect(iomux.readWord(offset)).toBe(0x1000 | pin);
    }
  });

  it('offsetForPin returns undefined for the undocumented 28-31 range and out-of-range pins', () => {
    expect(IoMux.offsetForPin(28)).toBeUndefined();
    expect(IoMux.offsetForPin(31)).toBeUndefined();
    expect(IoMux.offsetForPin(40)).toBeUndefined();
    expect(IoMux.offsetForPin(-1)).toBeUndefined();
  });

  it('unmapped offsets read as 0 and ignore writes', () => {
    const iomux = new IoMux();
    expect(iomux.readWord(0xfff)).toBe(0);
    iomux.writeWord(0xfff, 0xdeadbeef);
    expect(iomux.readWord(0xfff)).toBe(0);
  });
});
