/**
 * ESP32 IO_MUX - per-pin function-select register storage.
 *
 * Register offsets and behavior are taken from this repo's own pre-rewrite
 * QEMU source (recoverable from git history at `cae84de99b^`):
 * `include/hw/esp32/esp32_iomux.h` for the register array shape,
 * `hw/esp32/esp32_iomux.c`'s `esp32_iomux_read`/`_write` for behavior.
 *
 * Real hardware's offset-to-pin mapping is genuinely irregular (it follows
 * the physical pin/pad layout, not GPIO number order) - `OFFSET_TO_PIN`
 * below is transcribed directly from the reference's per-case switch
 * statement, not derived from a formula. GPIO28-31 are commented out in
 * the reference itself ("Not documented") and are omitted here too.
 *
 * Writing a pin's register calls `qemu_set_irq(s->iomux_sync[0], 0x4000 |
 * pin)` in the reference - notifying `Gpio` that this pin's routed
 * function changed, since real IO_MUX determines whether a GPIO pin is
 * doing raw digital I/O or carrying a peripheral signal (UART TXD, SPI,
 * etc). This repo's `Gpio` doesn't model function-select-dependent
 * behavior at all (it's unconditionally raw digital I/O - see its own doc
 * comment), so there's nothing for that notification to usefully drive
 * yet; only the register storage itself is implemented.
 */

/** Real hardware's byte-offset-per-pin table (hw/esp32/esp32_iomux.c's read/write switch), pin 0-39 excluding the undocumented 28-31. */
const OFFSET_TO_PIN: readonly (readonly [offset: number, pin: number])[] = [
  [0x44, 0],
  [0x88, 1],
  [0x40, 2],
  [0x84, 3],
  [0x48, 4],
  [0x6c, 5],
  [0x60, 6],
  [0x64, 7],
  [0x68, 8],
  [0x54, 9],
  [0x58, 10],
  [0x5c, 11],
  [0x34, 12],
  [0x38, 13],
  [0x30, 14],
  [0x3c, 15],
  [0x4c, 16],
  [0x50, 17],
  [0x70, 18],
  [0x74, 19],
  [0x78, 20],
  [0x7c, 21],
  [0x80, 22],
  [0x8c, 23],
  [0x90, 24],
  [0x24, 25],
  [0x28, 26],
  [0x2c, 27],
  [0x1c, 32],
  [0x20, 33],
  [0x14, 34],
  [0x18, 35],
  [0x04, 36],
  [0x08, 37],
  [0x0c, 38],
  [0x10, 39],
];

const PIN_TO_OFFSET = new Map<number, number>(OFFSET_TO_PIN.map(([offset, pin]) => [pin, offset]));
const OFFSET_TO_PIN_MAP = new Map<number, number>(OFFSET_TO_PIN);

/** Byte size of the register window this peripheral occupies at its base address. */
export const IOMUX_WINDOW_SIZE = 0x1000;

/** Reset default for every pin's MUX_GPIOn register (esp32_iomux_reset_enter). */
const RESET_VALUE = 0x00000800;

export class IoMux {
  private readonly regs = new Array<number>(40).fill(RESET_VALUE);

  /** The MMIO byte offset (within this peripheral's window) for a given GPIO pin's MUX register, or undefined if that pin has no IO_MUX register (28-31, or out of range). */
  static offsetForPin(pin: number): number | undefined {
    return PIN_TO_OFFSET.get(pin);
  }

  readWord(offset: number): number {
    const pin = OFFSET_TO_PIN_MAP.get(offset);
    return pin === undefined ? 0 : (this.regs[pin]! >>> 0);
  }

  writeWord(offset: number, value: number): void {
    const pin = OFFSET_TO_PIN_MAP.get(offset);
    if (pin === undefined) return;
    this.regs[pin] = value >>> 0;
  }
}
