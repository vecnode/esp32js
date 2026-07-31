import { describe, expect, it } from 'vitest';
import { Board } from '../../src/boards/board.js';
import { ESP32_CAM, ESP32_DEVKIT_C_V4, ESP32_DEVKIT_V1 } from '../../src/boards/index.js';
import type { BoardDefinition } from '../../src/boards/types.js';
import { INTMATRIX_SOURCE } from '../../src/peripherals/intmatrix.js';
import { MEMORY_MAP, PERIPHERAL_BASE } from '../../src/soc/memmap.js';

const boards: readonly BoardDefinition[] = [ESP32_DEVKIT_V1, ESP32_DEVKIT_C_V4, ESP32_CAM];

const EHDR_SIZE = 52;
const PHDR_SIZE = 32;

/** Builds a minimal, valid ELF32-LE file with one PT_LOAD segment - see test/loader/elf.test.ts for the format. */
function buildElf(entry: number, vaddr: number, data: Uint8Array): Uint8Array {
  const offset = EHDR_SIZE + PHDR_SIZE;
  const buf = new Uint8Array(offset + data.length);
  const view = new DataView(buf.buffer);

  buf[0] = 0x7f;
  buf[1] = 0x45; // 'E'
  buf[2] = 0x4c; // 'L'
  buf[3] = 0x46; // 'F'
  buf[4] = 1; // ELFCLASS32
  buf[5] = 1; // ELFDATA2LSB
  view.setUint32(24, entry >>> 0, true); // e_entry
  view.setUint32(28, EHDR_SIZE, true); // e_phoff
  view.setUint16(42, PHDR_SIZE, true); // e_phentsize
  view.setUint16(44, 1, true); // e_phnum

  view.setUint32(EHDR_SIZE + 0, 1, true); // p_type = PT_LOAD
  view.setUint32(EHDR_SIZE + 4, offset, true); // p_offset
  view.setUint32(EHDR_SIZE + 8, vaddr >>> 0, true); // p_vaddr
  view.setUint32(EHDR_SIZE + 16, data.length, true); // p_filesz
  view.setUint32(EHDR_SIZE + 20, data.length, true); // p_memsz
  buf.set(data, offset);

  return buf;
}

const MOVI = (dest: number, imm: number) => {
  const raw12 = imm & 0xfff;
  const s = (raw12 >> 8) & 0xf;
  const imm8 = raw12 & 0xff;
  return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
};
const ADD = (dest: number, s1: number, s2: number) => (0x8 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);

function packInsns(words: number[]): Uint8Array {
  const bytes = new Uint8Array(words.length * 3);
  words.forEach((word, i) => {
    bytes[i * 3] = word & 0xff;
    bytes[i * 3 + 1] = (word >>> 8) & 0xff;
    bytes[i * 3 + 2] = (word >>> 16) & 0xff;
  });
  return bytes;
}

describe.each(boards)('Board($name)', (definition) => {
  it('constructs a working Cpu/SystemBus pair with the interrupt matrix attached', () => {
    const board = new Board(definition);
    expect(board.definition).toBe(definition);
    expect(board.cpu.pc).toBeTypeOf('number');
    // Prove intmatrix.attach(cpu) really happened: a real interrupt should reach this Cpu.
    board.cpu.intenable = 1 << 3;
    const intmatrixBase = PERIPHERAL_BASE.dport + 0x104;
    board.bus.write32(intmatrixBase + INTMATRIX_SOURCE.GPIO * 4, 3); // route GPIO's source to CPU line 3
    board.bus.intmatrix.setSourceLevel(INTMATRIX_SOURCE.GPIO, 1);
    board.step();
    expect(board.cpu.lastException).toEqual({ kind: 'interrupt', level: 1 });
  });

  it('loadFirmware loads a real ELF and starts execution at its entry point', () => {
    const board = new Board(definition);
    const base = MEMORY_MAP.iram.base;
    const text = packInsns([MOVI(2, 5), MOVI(3, 7), ADD(4, 2, 3)]);
    const elf = buildElf(base, base, text);

    board.loadFirmware(elf);
    expect(board.cpu.pc).toBe(base);

    board.run(3);
    expect(board.cpu.regs.get(4)).toBe(12);
  });
});

describe('Board pin/serial/ADC passthroughs', () => {
  it('setPin/getPin drive and read bus.gpio directly', () => {
    const board = new Board(ESP32_DEVKIT_V1);
    board.setPin(21, 1); // GPIO21 is a plain 'general' pin on DevKit V1
    expect(board.getPin(21)).toBe(1);
    expect(board.bus.gpio.getPin(21)).toBe(1);
  });

  it('setPin on a reserved pin (boot-strap) still works but calls onReservedPinWarning', () => {
    const board = new Board(ESP32_DEVKIT_V1);
    const warnings: Array<[number, string]> = [];
    board.onReservedPinWarning = (pin, role) => warnings.push([pin, role]);

    board.setPin(0, 1); // GPIO0 is a boot-strap pin on every board here
    expect(board.getPin(0)).toBe(1); // still actually drives the pin
    expect(warnings).toEqual([[0, 'boot-strap']]);
  });

  it('setPin on an unlisted pin does not warn', () => {
    const board = new Board(ESP32_DEVKIT_V1);
    let warned = false;
    board.onReservedPinWarning = () => (warned = true);
    board.setPin(21, 1); // not in DevKit V1's reserved lists
    expect(warned).toBe(false);
  });

  it('onSerialOut receives bytes written to UART0, and serialIn feeds bus.uart0.pushRx', () => {
    const board = new Board(ESP32_DEVKIT_V1);
    const out: number[] = [];
    board.onSerialOut = (b) => out.push(b);
    board.bus.uart0.writeWord(0x00, 0x48); // UART_FIFO offset
    expect(out).toEqual([0x48]);

    board.serialIn(0x69);
    expect(board.bus.uart0.readWord(0x00)).toBe(0x69);
  });

  it('setAdcChannel/getAdcChannel inject and read back a simulated analog value', () => {
    const board = new Board(ESP32_CAM);
    board.setAdcChannel(3, 2048);
    expect(board.getAdcChannel(3)).toBe(2048);
  });

  it('step() advances cycle-driven peripherals too, not just the Cpu', () => {
    const board = new Board(ESP32_DEVKIT_V1);
    // Enable T0 with a small divider and confirm it actually ticks via board.step(), not just cpu.step().
    board.bus.timg0.writeWord(0x00, (1 << 31) | (1 << 30) | (1 << 13)); // T0CONFIG: EN|INCREASE, divider raw=1 -> 2
    board.cpu.pc = MEMORY_MAP.iram.base;
    for (let i = 0; i < 10; i++) board.step(); // 10 NOP-like steps, ~1 cycle each by default
    expect(board.bus.timg0.readWord(0x04)).toBeGreaterThan(0); // T0LO
  });
});
