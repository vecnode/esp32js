import { describe, expect, it } from 'vitest';
import { Dport, DPORT_REG } from '../../src/soc/dport.js';

describe('Dport', () => {
  it('APPCPU_RESET/CLK/RUNSTALL are masked to a single bit', () => {
    const dport = new Dport();
    dport.writeWord(DPORT_REG.APPCPU_RESET, 0xff);
    dport.writeWord(DPORT_REG.APPCPU_CLK, 0xff);
    dport.writeWord(DPORT_REG.APPCPU_RUNSTALL, 0xff);

    expect(dport.readWord(DPORT_REG.APPCPU_RESET)).toBe(1);
    expect(dport.readWord(DPORT_REG.APPCPU_CLK)).toBe(1);
    expect(dport.readWord(DPORT_REG.APPCPU_RUNSTALL)).toBe(1);
  });

  it('APPCPU_BOOT_ADDR round-trips a full 32-bit address', () => {
    const dport = new Dport();
    dport.writeWord(DPORT_REG.APPCPU_BOOT_ADDR, 0x40080000);
    expect(dport.readWord(DPORT_REG.APPCPU_BOOT_ADDR)).toBe(0x40080000);
  });

  it('CPU_PER_CONF round-trips as plain storage', () => {
    const dport = new Dport();
    dport.writeWord(DPORT_REG.CPU_PER_CONF, 0x2);
    expect(dport.readWord(DPORT_REG.CPU_PER_CONF)).toBe(0x2);
  });

  it('PRO/APP cache control registers round-trip as plain storage', () => {
    const dport = new Dport();
    dport.writeWord(DPORT_REG.PRO_CACHE_CTRL, 0x1);
    dport.writeWord(DPORT_REG.PRO_CACHE_CTRL1, 0xffffffff);
    dport.writeWord(DPORT_REG.APP_CACHE_CTRL, 0x1);
    dport.writeWord(DPORT_REG.APP_CACHE_CTRL1, 0xffffffff);

    expect(dport.readWord(DPORT_REG.PRO_CACHE_CTRL)).toBe(0x1);
    expect(dport.readWord(DPORT_REG.PRO_CACHE_CTRL1)).toBe(0xffffffff >>> 0);
    expect(dport.readWord(DPORT_REG.APP_CACHE_CTRL)).toBe(0x1);
    expect(dport.readWord(DPORT_REG.APP_CACHE_CTRL1)).toBe(0xffffffff >>> 0);
  });

  it('unrecognized offsets read as 0 and ignore writes', () => {
    const dport = new Dport();
    expect(dport.readWord(0xf00)).toBe(0);
    expect(() => dport.writeWord(0xf00, 1)).not.toThrow();
  });
});
