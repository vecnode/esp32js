/**
 * ESP32 GPIO peripheral - digital I/O only (no interrupts, no IO_MUX pin
 * function select).
 *
 * Register offsets and behavior are taken from this repo's own pre-rewrite
 * QEMU source (recoverable from git history at `cae84de99b^`):
 * `include/hw/esp32/esp32_gpio.h` for the register map and reset state,
 * `hw/esp32/esp32_gpio.c`'s `esp32_gpio_read`/`esp32_gpio_write` for
 * behavior.
 *
 * The reference's write handler has a detail worth preserving exactly: this
 * fork has no separate simulated external circuit by default, so driving an
 * output pin high loops straight back into GPIO_IN/GPIO_IN1 for any pin
 * currently configured as output (`gpio_out ^ oldvalue` / `gpio_enable ^
 * oldenable` diff check in `esp32_gpio_write`) - reading back a pin you just
 * drove returns what you drove, not floating/undefined. That's exactly this
 * project's situation too (no external circuit model), so it's replicated
 * as-is rather than treated as a simplification to "fix".
 *
 * `setPin`/`getPin` model the reference's `set_gpio` callback - the
 * qemu_irq input line real hardware uses for an external signal (a button,
 * another chip) changing a pin's level. It only makes sense for pins NOT
 * currently driven as output by this chip (a real external driver and this
 * chip's own output would be a legitimate GPIO contention issue), but this
 * peripheral doesn't attempt to model or flag contention - it just writes
 * the bit, same as the reference does unconditionally.
 *
 * Explicitly out of scope (real hardware behavior this doesn't implement):
 * GPIO_STATUS and per-pin interrupt generation (`gpio_pin[]`'s int_type
 * field, edge/level triggering, GPIO_PCPU_INT/ACPU_INT) - needs a wired
 * interrupt matrix (`peripherals/intmatrix.ts`, not started) to mean
 * anything; the IO_MUX-driven signal routing matrix
 * (GPIO_FUNCy_IN/OUT_SEL_CFG, 0x130-0x5d0) - real firmware uses this to
 * route a GPIO to/from a peripheral (UART TXD, SPI, etc.) rather than raw
 * digital I/O, out of scope until IO_MUX itself exists.
 */

export const GPIO_REG = {
  OUT: 0x04,
  OUT_W1TS: 0x08,
  OUT_W1TC: 0x0c,
  ENABLE: 0x20,
  ENABLE_W1TS: 0x24,
  ENABLE_W1TC: 0x28,
  STRAP: 0x38,
  IN: 0x3c,
  IN1: 0x40,
} as const;

/** Byte size of the register window this peripheral occupies at its base address (real hardware: 0x1000). */
export const GPIO_WINDOW_SIZE = 0x1000;

/** GPIO_STRAP reset default: ESP32_STRAP_MODE_FLASH_BOOT. */
const STRAP_MODE_FLASH_BOOT = 0x12;

export class Gpio {
  private out = 0;
  private enable = 0;
  private strap = STRAP_MODE_FLASH_BOOT;
  /** GPIO0-31. Reset value 0x1, matching esp32_gpio_init. */
  private in0 = 0x1;
  /** GPIO32-39 (as bits 0-7). Reset value 0x8, matching esp32_gpio_init. */
  private in1 = 0x8;

  /** Read a single pin's current level (0 or 1), 0-39. For observing an output this chip is driving, or an externally-set input. */
  getPin(n: number): 0 | 1 {
    return n < 32 ? (((this.in0 >>> n) & 1) as 0 | 1) : (((this.in1 >>> (n - 32)) & 1) as 0 | 1);
  }

  /**
   * Drive pin `n` (0-39) from outside this chip - a button, another chip,
   * etc. Matches the reference's `set_gpio` callback: writes the bit
   * unconditionally, with no contention check against this chip's own
   * output drivers.
   */
  setPin(n: number, value: 0 | 1): void {
    if (n < 32) {
      this.in0 = value ? this.in0 | (1 << n) : this.in0 & ~(1 << n);
    } else {
      const n1 = n - 32;
      this.in1 = value ? this.in1 | (1 << n1) : this.in1 & ~(1 << n1);
    }
  }

  readWord(offset: number): number {
    switch (offset) {
      case GPIO_REG.OUT:
        return this.out >>> 0;
      case GPIO_REG.ENABLE:
        return this.enable >>> 0;
      case GPIO_REG.STRAP:
        return this.strap >>> 0;
      case GPIO_REG.IN:
        return this.in0 >>> 0;
      case GPIO_REG.IN1:
        return this.in1 >>> 0;
      default:
        return 0;
    }
  }

  writeWord(offset: number, value: number): void {
    const oldOut = this.out;
    const oldEnable = this.enable;

    switch (offset) {
      case GPIO_REG.OUT:
        this.out = value >>> 0;
        break;
      case GPIO_REG.OUT_W1TS:
        this.out = (this.out | value) >>> 0;
        break;
      case GPIO_REG.OUT_W1TC:
        this.out = (this.out & ~value) >>> 0;
        break;
      case GPIO_REG.ENABLE:
        this.enable = value >>> 0;
        break;
      case GPIO_REG.ENABLE_W1TS:
        this.enable = (this.enable | value) >>> 0;
        break;
      case GPIO_REG.ENABLE_W1TC:
        this.enable = (this.enable & ~value) >>> 0;
        break;
      case GPIO_REG.STRAP:
        this.strap = value >>> 0;
        break;
      default:
        break;
    }

    // Loop driven-output pins back into GPIO_IN (esp32_gpio_write's diff
    // check) - see the class doc comment for why.
    if (this.out !== oldOut || this.enable !== oldEnable) {
      const diff = (this.out ^ oldOut) | (this.enable ^ oldEnable);
      for (let i = 0; i < 32; i++) {
        if (diff & (1 << i) && this.enable & (1 << i)) {
          this.in0 = this.out & (1 << i) ? this.in0 | (1 << i) : this.in0 & ~(1 << i);
        }
      }
    }
  }
}
