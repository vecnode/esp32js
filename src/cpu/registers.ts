/**
 * Windowed register file for the Xtensa LX6 core used by ESP32.
 *
 * The core has NUM_AREGS (64) physical registers (`phys`), of which only a
 * 16-register "window" is visible to instructions at any time as a0-a15.
 * WINDOWBASE selects the window's offset into the physical file, in units
 * of 4 registers (0-15 for a 64-register file). WINDOWSTART is a bitmask,
 * one bit per possible WINDOWBASE value, marking which offsets currently
 * hold a live call frame - it drives window overflow/underflow exceptions
 * on CALLn/RETW.
 *
 * Semantics follow target/xtensa/win_helper.c in this repo's QEMU source
 * (used here only as a reference for behavior, not transliterated).
 */

const NUM_AREGS = 64;
const NUM_WINDOWS = NUM_AREGS / 4; // 16 possible WINDOWBASE positions

export class RegisterFile {
  /** Physical register file (AR0..AR63). */
  private readonly phys = new Uint32Array(NUM_AREGS);

  /** Currently visible window, a0..a15. */
  private readonly window = new Uint32Array(16);

  /** WINDOWBASE special register: 0..15. */
  private windowBase = 0;

  /** WINDOWSTART special register: 16-bit mask. */
  private windowStart = 1;

  private static bound(base: number): number {
    return ((base % NUM_WINDOWS) + NUM_WINDOWS) % NUM_WINDOWS;
  }

  private static startBit(base: number): number {
    return 1 << RegisterFile.bound(base);
  }

  /** a0-a15 read, relative to the current window. */
  get(index: number): number {
    return this.window[index & 0xf]!;
  }

  /** a0-a15 write, relative to the current window. */
  set(index: number, value: number): void {
    this.window[index & 0xf] = value >>> 0;
  }

  getWindowBase(): number {
    return this.windowBase;
  }

  getWindowStart(): number {
    return this.windowStart;
  }

  setWindowStart(mask: number): void {
    this.windowStart = mask & 0xffff;
  }

  private syncPhysFromWindow(): void {
    const base = this.windowBase * 4;
    for (let i = 0; i < 16; i++) {
      this.phys[(base + i) % NUM_AREGS] = this.window[i]!;
    }
  }

  private syncWindowFromPhys(): void {
    const base = this.windowBase * 4;
    for (let i = 0; i < 16; i++) {
      this.window[i] = this.phys[(base + i) % NUM_AREGS]!;
    }
  }

  private rotateAbs(position: number): void {
    this.syncPhysFromWindow();
    this.windowBase = RegisterFile.bound(position);
    this.syncWindowFromPhys();
  }

  /** Used by CALL4/8/12 and RETW: rotate the window by +/- n quads. */
  rotate(delta: number): void {
    this.rotateAbs(this.windowBase + delta);
  }

  /**
   * ENTRY: allocates a new call frame `callSize` quads ahead of the current
   * window and marks it live in WINDOWSTART. Does not rotate the window
   * itself - the preceding CALLn already did that.
   */
  markFrameLive(callSizeQuads: number): void {
    const next = this.windowBase + callSizeQuads;
    this.windowStart |= RegisterFile.startBit(next);
  }

  /**
   * True if the window `n` quads behind the current one is still marked
   * live - i.e. a CALLn is about to overwrite a frame that hasn't been
   * spilled to memory yet, which must raise a window overflow exception
   * before the call proceeds.
   */
  isFrameLive(quadsBack: number): boolean {
    return (this.windowStart & RegisterFile.startBit(this.windowBase - quadsBack)) !== 0;
  }

  clearFrameLive(quadsBack: number): void {
    this.windowStart &= ~RegisterFile.startBit(this.windowBase - quadsBack);
  }
}
