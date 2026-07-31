import { describe, expect, it } from 'vitest';
import { RegisterFile } from '../../src/cpu/registers.js';

describe('RegisterFile windowing', () => {
  it('reads and writes within the current window', () => {
    const regs = new RegisterFile();
    regs.set(2, 0x1234);
    expect(regs.get(2)).toBe(0x1234);
  });

  it('rotates the window and preserves the prior frame in phys storage', () => {
    const regs = new RegisterFile();
    regs.set(0, 0xaaaa); // a0 in window 0
    regs.rotate(1); // simulate ENTRY after CALL4: window advances by one quad
    expect(regs.getWindowBase()).toBe(1);

    regs.set(0, 0xbbbb); // a0 in window 1 is a different physical register
    regs.rotate(-1); // simulate RETW
    expect(regs.getWindowBase()).toBe(0);
    expect(regs.get(0)).toBe(0xaaaa); // original frame's a0 is back
  });

  it('wraps WINDOWBASE modulo 16 physical quads', () => {
    const regs = new RegisterFile();
    regs.rotate(20); // 20 mod 16 == 4
    expect(regs.getWindowBase()).toBe(4);
  });

  it('tracks live frames in WINDOWSTART for overflow detection', () => {
    const regs = new RegisterFile();
    expect(regs.isFrameLive(1)).toBe(false);
    regs.markFrameLive(1); // ENTRY after a CALL4
    regs.rotate(1);
    expect(regs.isFrameLive(1)).toBe(true);
  });
});
