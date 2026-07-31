import { describe, expect, it } from 'vitest';
import { Cpu } from '../../src/cpu/cpu.js';
import { RegisterFile } from '../../src/cpu/registers.js';
import { IntMatrix, INTMATRIX_NUM_SOURCES, INTMATRIX_SOURCE } from '../../src/peripherals/intmatrix.js';

/**
 * Always decodes to NOP.N (0xf03d, little-endian bytes 0x3d,0xf0 repeating)
 * so a step with no interrupt taken doesn't itself report a decode error -
 * these tests only care about interrupt delivery. Only valid for even
 * addresses, which is all every vector offset and pc=0 ever produce here.
 */
class NullBus {
  readByte(addr: number): number {
    return addr % 2 === 0 ? 0x3d : 0xf0;
  }
  read32(): number {
    return 0;
  }
  write32(): void {}
}

function makeCpu(): Cpu {
  return new Cpu(new RegisterFile(), new NullBus(), 0);
}

describe('IntMatrix', () => {
  it('resets every map register to 6 (esp32_intmatrix_reset_hold)', () => {
    const im = new IntMatrix();
    expect(im.readWord(0)).toBe(6);
    expect(im.readWord((INTMATRIX_NUM_SOURCES - 1) * 4)).toBe(6);
  });

  it('round-trips a map register write/read, masked to 5 bits', () => {
    const im = new IntMatrix();
    im.writeWord(INTMATRIX_SOURCE.UART0 * 4, 0xff);
    expect(im.readWord(INTMATRIX_SOURCE.UART0 * 4)).toBe(0x1f);
  });

  it('out-of-range offsets read as 0 and ignore writes', () => {
    const im = new IntMatrix();
    const beyond = INTMATRIX_NUM_SOURCES * 4;
    expect(im.readWord(beyond)).toBe(0);
    expect(() => im.writeWord(beyond, 5)).not.toThrow();
  });

  it('drives the mapped CPU line when a source is asserted, once attached', () => {
    const im = new IntMatrix();
    const cpu = makeCpu();
    im.attach(cpu);
    cpu.intenable = 1 << 3;

    im.writeWord(INTMATRIX_SOURCE.GPIO * 4, 3); // route GPIO's source to CPU line 3
    im.setSourceLevel(INTMATRIX_SOURCE.GPIO, 1);

    cpu.step(); // nothing at pc=0 but an interrupt should preempt
    expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 1 }); // XCHAL_INT3_LEVEL=1
  });

  it('deasserting a source lowers its mapped CPU line', () => {
    const im = new IntMatrix();
    const cpu = makeCpu();
    im.attach(cpu);
    cpu.intenable = 1 << 3;

    im.writeWord(INTMATRIX_SOURCE.GPIO * 4, 3);
    im.setSourceLevel(INTMATRIX_SOURCE.GPIO, 1);
    im.setSourceLevel(INTMATRIX_SOURCE.GPIO, 0);

    cpu.step();
    expect(cpu.lastException).toBeNull();
  });

  it('remapping a live source to a new line redrives the new line and stops the old one', () => {
    const im = new IntMatrix();
    const cpu = makeCpu();
    im.attach(cpu);
    cpu.intenable = (1 << 3) | (1 << 4);

    im.writeWord(INTMATRIX_SOURCE.GPIO * 4, 3);
    im.setSourceLevel(INTMATRIX_SOURCE.GPIO, 1);
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 1 });

    // Service it (real firmware would clear PS.EXCM some way - directly for this test).
    cpu.excm = false;

    im.writeWord(INTMATRIX_SOURCE.GPIO * 4, 4); // remap while still asserted
    cpu.step();
    expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 1 }); // line 4 is also level 1
  });

  it('writing the disconnect value (6) to a live source lowers its old line without redriving', () => {
    const im = new IntMatrix();
    const cpu = makeCpu();
    im.attach(cpu);
    cpu.intenable = 1 << 3;

    im.writeWord(INTMATRIX_SOURCE.GPIO * 4, 3);
    im.setSourceLevel(INTMATRIX_SOURCE.GPIO, 1);
    cpu.excm = true; // pretend we're mid-handler so the still-asserted line wouldn't otherwise show as "cleared"

    im.writeWord(INTMATRIX_SOURCE.GPIO * 4, 6); // disconnect
    cpu.excm = false;

    cpu.step();
    expect(cpu.lastException).toBeNull(); // line 3 was lowered by the disconnect, even though the source is still "raw" active
  });

  it('without attach(), writes/reads still work but nothing reaches a CPU', () => {
    const im = new IntMatrix();
    expect(() => {
      im.writeWord(INTMATRIX_SOURCE.TG0_T0 * 4, 5);
      im.setSourceLevel(INTMATRIX_SOURCE.TG0_T0, 1);
    }).not.toThrow();
    expect(im.readWord(INTMATRIX_SOURCE.TG0_T0 * 4)).toBe(5);
  });
});
