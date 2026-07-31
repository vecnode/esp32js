/**
 * A minimal ELF32 loader: reads `PT_LOAD` program header segments out of a
 * compiled ESP-IDF/Xtensa binary and writes their bytes onto a `Bus` at
 * their real load addresses, plus the entry point to start execution at.
 *
 * Unlike every other module in this project, this one isn't ported from
 * this repo's QEMU C fork - ELF loading isn't ESP32-specific behavior (the
 * fork's own `hw/esp32/esp32_picsimlab.c` doesn't implement it either; real
 * QEMU loads ELF images through its generic, board-agnostic `load_elf()` in
 * `hw/core/loader.c`). This is a from-scratch implementation of the
 * standard ELF32 program-header format, deliberately generic enough for
 * any Xtensa ELF, not just ones this project's own toolchain produced.
 *
 * Why an ELF loader is the right level for "accept normal ESP32 code": a
 * `.elf` built by `xtensa-esp32-elf-gcc`/ESP-IDF already has `PT_LOAD`
 * segments placed at real IRAM/DRAM/DROM/IROM virtual addresses by the
 * toolchain's own linker script - the same addresses `soc/memmap.ts`
 * models. Loading those segments by address onto a real `SystemBus`
 * (rather than requiring a hand-assembled JS test program) is therefore
 * sufficient to run real compiled firmware, without needing to also model
 * esptool's separate flash-image container format (the `.bin` esptool
 * produces for flashing over serial) or SPI flash/MMU address translation -
 * neither of which is a CPU or peripheral behavior, and both of which sit
 * strictly *before* an ELF's segments ever reach the addresses this
 * project cares about being accurate at.
 *
 * `p_filesz < p_memsz` (a segment with an uninitialized-data/BSS tail) is
 * zero-filled for the difference, matching what a real loader/linker script
 * both expect: DRAM's uninitialized statics still need to read as zero on
 * first access, exactly as `SystemBus`'s own regions already do by virtue
 * of being freshly zeroed `Uint8Array`s - `loadElf` doesn't rely on that,
 * though, since a segment's target region may not always start pre-zeroed
 * (e.g. loading a second image after the first already ran).
 *
 * Not implemented: `PT_DYNAMIC`/relocations (ESP-IDF app images are
 * statically linked, position-dependent binaries - there is nothing to
 * relocate), section headers (`PT_LOAD` program headers alone are
 * sufficient to place every loadable byte; symbol/debug section parsing is
 * out of scope for an emulator, not a disassembler), and any non-ELF32/
 * non-little-endian input (real ESP32 toolchains never produce those, so
 * rejecting them here is a real validation of a real precondition, not
 * unnecessary defensiveness).
 */

/** e_ident bytes: the ELF magic number. */
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const; // "\x7fELF"
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1; // little-endian
const PT_LOAD = 1;

export interface ElfImage {
  /** e_entry - the address execution should start at. */
  readonly entry: number;
}

export interface ByteWritable {
  writeByte(addr: number, value: number): void;
}

/**
 * Parses `data` as an ELF32 little-endian file and writes every `PT_LOAD`
 * segment's bytes onto `bus` at its `p_vaddr` (zero-filling
 * `p_memsz - p_filesz` bytes of BSS beyond the segment's file contents).
 * Throws if `data` isn't a recognizable ELF32/little-endian file - a real
 * precondition violation, not a "can't happen" case.
 */
export function loadElf(bus: ByteWritable, data: Uint8Array): ElfImage {
  if (data.length < 52 || !ELF_MAGIC.every((byte, i) => data[i] === byte)) {
    throw new Error('loadElf: not an ELF file (bad magic)');
  }
  if (data[4] !== ELFCLASS32) {
    throw new Error('loadElf: not a 32-bit ELF (ELFCLASS32)');
  }
  if (data[5] !== ELFDATA2LSB) {
    throw new Error('loadElf: not a little-endian ELF (ELFDATA2LSB)');
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entry = view.getUint32(24, true) >>> 0;
  const phoff = view.getUint32(28, true);
  const phentsize = view.getUint16(42, true);
  const phnum = view.getUint16(44, true);

  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    const pType = view.getUint32(ph + 0, true);
    if (pType !== PT_LOAD) continue;

    const pOffset = view.getUint32(ph + 4, true);
    const pVaddr = view.getUint32(ph + 8, true) >>> 0;
    const pFilesz = view.getUint32(ph + 16, true);
    const pMemsz = view.getUint32(ph + 20, true);

    for (let b = 0; b < pFilesz; b++) {
      bus.writeByte((pVaddr + b) >>> 0, data[pOffset + b]!);
    }
    for (let b = pFilesz; b < pMemsz; b++) {
      bus.writeByte((pVaddr + b) >>> 0, 0);
    }
  }

  return { entry };
}
