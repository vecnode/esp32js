import { describe, expect, it } from 'vitest';
import { loadElf } from '../../src/loader/elf.js';

const EHDR_SIZE = 52;
const PHDR_SIZE = 32;
const PT_LOAD = 1;
const PT_NOTE = 4; // any non-PT_LOAD type, to prove it's skipped

interface Segment {
  type: number;
  vaddr: number;
  data: Uint8Array;
  memsz?: number; // defaults to data.length; larger means a BSS tail
}

/** Hand-assembles a minimal, valid ELF32-LE file with one program header per segment. */
function buildElf(entry: number, segments: Segment[]): Uint8Array {
  const phoff = EHDR_SIZE;
  let fileOffset = phoff + segments.length * PHDR_SIZE;
  const segmentOffsets = segments.map((seg) => {
    const offset = fileOffset;
    fileOffset += seg.data.length;
    return offset;
  });

  const buf = new Uint8Array(fileOffset);
  const view = new DataView(buf.buffer);

  buf[0] = 0x7f;
  buf[1] = 0x45; // 'E'
  buf[2] = 0x4c; // 'L'
  buf[3] = 0x46; // 'F'
  buf[4] = 1; // ELFCLASS32
  buf[5] = 1; // ELFDATA2LSB
  view.setUint32(24, entry >>> 0, true); // e_entry
  view.setUint32(28, phoff, true); // e_phoff
  view.setUint16(42, PHDR_SIZE, true); // e_phentsize
  view.setUint16(44, segments.length, true); // e_phnum

  segments.forEach((seg, i) => {
    const ph = phoff + i * PHDR_SIZE;
    view.setUint32(ph + 0, seg.type, true); // p_type
    view.setUint32(ph + 4, segmentOffsets[i]!, true); // p_offset
    view.setUint32(ph + 8, seg.vaddr >>> 0, true); // p_vaddr
    view.setUint32(ph + 16, seg.data.length, true); // p_filesz
    view.setUint32(ph + 20, seg.memsz ?? seg.data.length, true); // p_memsz
    buf.set(seg.data, segmentOffsets[i]!);
  });

  return buf;
}

class RecordingBus {
  readonly written = new Map<number, number>();
  writeByte(addr: number, value: number): void {
    this.written.set(addr >>> 0, value & 0xff);
  }
}

describe('loadElf', () => {
  it('writes a PT_LOAD segment onto the bus at p_vaddr and returns e_entry', () => {
    const bus = new RecordingBus();
    const data = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const elf = buildElf(0x40080123, [{ type: PT_LOAD, vaddr: 0x40080000, data }]);

    const image = loadElf(bus, elf);

    expect(image.entry).toBe(0x40080123);
    expect(bus.written.get(0x40080000)).toBe(0x11);
    expect(bus.written.get(0x40080001)).toBe(0x22);
    expect(bus.written.get(0x40080002)).toBe(0x33);
    expect(bus.written.get(0x40080003)).toBe(0x44);
  });

  it('zero-fills a BSS tail when p_memsz exceeds p_filesz', () => {
    const bus = new RecordingBus();
    const data = new Uint8Array([0xaa, 0xbb]);
    const elf = buildElf(0, [{ type: PT_LOAD, vaddr: 0x3ffb0000, data, memsz: 5 }]);

    loadElf(bus, elf);

    expect(bus.written.get(0x3ffb0000)).toBe(0xaa);
    expect(bus.written.get(0x3ffb0001)).toBe(0xbb);
    expect(bus.written.get(0x3ffb0002)).toBe(0);
    expect(bus.written.get(0x3ffb0003)).toBe(0);
    expect(bus.written.get(0x3ffb0004)).toBe(0);
  });

  it('loads multiple PT_LOAD segments at their own addresses without colliding', () => {
    const bus = new RecordingBus();
    const elf = buildElf(0, [
      { type: PT_LOAD, vaddr: 0x40080000, data: new Uint8Array([1, 2]) },
      { type: PT_LOAD, vaddr: 0x3ffae000, data: new Uint8Array([3, 4]) },
    ]);

    loadElf(bus, elf);

    expect(bus.written.get(0x40080000)).toBe(1);
    expect(bus.written.get(0x40080001)).toBe(2);
    expect(bus.written.get(0x3ffae000)).toBe(3);
    expect(bus.written.get(0x3ffae001)).toBe(4);
  });

  it('skips program headers that are not PT_LOAD', () => {
    const bus = new RecordingBus();
    const elf = buildElf(0, [{ type: PT_NOTE, vaddr: 0x40080000, data: new Uint8Array([0xff]) }]);

    loadElf(bus, elf);

    expect(bus.written.size).toBe(0);
  });

  it('throws on a file with a bad magic number', () => {
    const bus = new RecordingBus();
    const notElf = new Uint8Array(64);
    expect(() => loadElf(bus, notElf)).toThrow(/bad magic/);
  });

  it('throws on a 64-bit ELF (ELFCLASS64)', () => {
    const bus = new RecordingBus();
    const elf = buildElf(0, [{ type: PT_LOAD, vaddr: 0, data: new Uint8Array([1]) }]);
    elf[4] = 2; // ELFCLASS64
    expect(() => loadElf(bus, elf)).toThrow(/32-bit/);
  });

  it('throws on a big-endian ELF (ELFDATA2MSB)', () => {
    const bus = new RecordingBus();
    const elf = buildElf(0, [{ type: PT_LOAD, vaddr: 0, data: new Uint8Array([1]) }]);
    elf[5] = 2; // ELFDATA2MSB
    expect(() => loadElf(bus, elf)).toThrow(/little-endian/);
  });
});
