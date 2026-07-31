/**
 * ESP32 GPIO peripheral - digital I/O plus real per-pin edge/level
 * interrupt generation (no IO_MUX pin function select - see `iomux.ts`).
 *
 * Register offsets and behavior are taken from this repo's own pre-rewrite
 * QEMU source (recoverable from git history at `cae84de99b^`):
 * `include/hw/esp32/esp32_gpio.h` for the register map and reset state,
 * `hw/esp32/esp32_gpio.c`'s `esp32_gpio_read`/`_write`/`set_gpio`/
 * `get_triggering` for behavior.
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
 * Per-pin interrupt generation (`GPIO_PINn`'s `INT_TYPE` field, bits[9:7]:
 * 0=disabled, 1=rising, 2=falling, 3=any edge, 4=low level, 5=high level -
 * `get_triggering`) is evaluated **only** on the `setPin` external-stimulus
 * path, exactly as the reference does: `set_gpio` is the one place
 * `get_triggering` is called, while the output-loopback path above (a
 * `Gpio_out` write reflecting into `Gpio_in`) updates `gpio_in` directly
 * without ever touching interrupt state. A chip driving its own output does
 * not self-interrupt on that pin; only an external toggle can. Two enable
 * bits gate whether a triggered condition actually latches anything -
 * `PRO_CPU_INT_ENABLE` (bit 15) and `APP_CPU_INT_ENABLE` (bit 13,
 * real hardware's naming, even though this repo has no second CPU core to
 * distinguish) - both routing to the *same* single combined interrupt
 * condition this class exposes (`onInterruptChange`), matching the
 * reference's own single `qemu_irq irq` output regardless of which enable
 * bit fired.
 *
 * `GPIO_STATUS`/`GPIO_STATUS1` are preserved as genuinely vestigial
 * registers - plain read/write storage, never touched by `set_gpio`'s
 * trigger logic at all in the reference (only `GPIO_PCPU_INT`/
 * `GPIO_ACPU_INT` and their `_1` counterparts are the real interrupt
 * latches). `GPIO_STATUS_W1TC`/`STATUS1_W1TC` still clear all three
 * registers together when they succeed, and still gate on whether any bit
 * being cleared corresponds to a still-active *level*-type condition
 * (`int_type` 4/5 checked against the pin's current live level) - clearing
 * is refused for those, matching real level-triggered hardware needing the
 * condition to actually go away, not just be acknowledged. A second,
 * genuinely surprising reference quirk preserved deliberately rather than
 * "fixed": each `STATUS_W1TC`/`STATUS1_W1TC` path unconditionally lowers
 * the *combined* interrupt line to inactive when it succeeds, without
 * checking whether the *other* 32-bit half (pins 32-39 vs. 0-31) still has
 * a pending condition - so clearing one half's interrupts can spuriously
 * silence a still-pending interrupt from the other half. Real, sourced,
 * and worth knowing about rather than quietly "improved."
 *
 * Not implemented (real hardware behavior this doesn't implement): the
 * IO_MUX-driven signal routing matrix (`GPIO_FUNCy_IN/OUT_SEL_CFG`, real
 * firmware uses this to route a GPIO to/from a peripheral instead of raw
 * digital I/O) - `peripherals/iomux.ts` now backs IO_MUX's own per-pin
 * register storage, but nothing connects a pin's stored function-select
 * value back into this class's behavior yet, so `Gpio` still always behaves
 * as raw digital I/O regardless of what's written there.
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
  STATUS: 0x44,
  STATUS_W1TS: 0x48,
  STATUS_W1TC: 0x4c,
  STATUS1: 0x50,
  STATUS1_W1TS: 0x54,
  STATUS1_W1TC: 0x58,
  ACPU_INT: 0x60,
  PCPU_INT: 0x68,
  ACPU_INT1: 0x74,
  PCPU_INT1: 0x7c,
} as const;

/** Byte size of the register window this peripheral occupies at its base address (real hardware: 0x1000). */
export const GPIO_WINDOW_SIZE = 0x1000;

/** GPIO_STRAP reset default: ESP32_STRAP_MODE_FLASH_BOOT. */
const STRAP_MODE_FLASH_BOOT = 0x12;

/** GPIO_PINn's byte offset range (GPIO_PINXX_REG, 40 pins, 4 bytes each). */
const PIN_REG_BASE = 0x88;
const PIN_REG_COUNT = 40;

const PRO_CPU_INT_ENABLE = 1 << 15;
const APP_CPU_INT_ENABLE = 1 << 13;

/** get_triggering: whether this pin's configured INT_TYPE fires for oldVal -> val. */
function getTriggering(intType: number, oldVal: 0 | 1, val: 0 | 1): boolean {
  switch (intType) {
    case 1:
      return val > oldVal; // rising edge
    case 2:
      return val < oldVal; // falling edge
    case 3:
      return val !== oldVal; // any edge
    case 4:
      return val === 0; // low level
    case 5:
      return val === 1; // high level
    default:
      return false; // 0 (and 6/7, unused) - disabled
  }
}

export class Gpio {
  private out = 0;
  private enable = 0;
  private strap = STRAP_MODE_FLASH_BOOT;
  /** GPIO0-31. Reset value 0x1, matching esp32_gpio_init. */
  private in0 = 0x1;
  /** GPIO32-39 (as bits 0-7). Reset value 0x8, matching esp32_gpio_init. */
  private in1 = 0x8;

  /** GPIO_PINn - only INT_TYPE (bits[9:7]) and the two int-enable bits are interpreted; the rest round-trips as plain storage. */
  private readonly pin = new Array<number>(PIN_REG_COUNT).fill(0);
  private status = 0; // vestigial - see class doc comment
  private status1 = 0;
  private pcpuInt = 0;
  private acpuInt = 0;
  private pcpuInt1 = 0;
  private acpuInt1 = 0;
  private active = false;

  /** Fires when the single combined GPIO interrupt condition changes - see class doc comment for why it's just one line. */
  onInterruptChange?: (active: boolean) => void;

  /** Read a single pin's current level (0 or 1), 0-39. For observing an output this chip is driving, or an externally-set input. */
  getPin(n: number): 0 | 1 {
    return n < 32 ? (((this.in0 >>> n) & 1) as 0 | 1) : (((this.in1 >>> (n - 32)) & 1) as 0 | 1);
  }

  /**
   * Drive pin `n` (0-39) from outside this chip - a button, another chip,
   * etc. Matches the reference's `set_gpio` callback: writes the bit
   * unconditionally, with no contention check against this chip's own
   * output drivers, then evaluates that pin's configured interrupt trigger
   * (see class doc comment) - the one path that does, unlike the plain
   * output-loopback write path below.
   */
  setPin(n: number, value: 0 | 1): void {
    const oldVal = this.getPin(n);
    if (n < 32) {
      this.in0 = value ? this.in0 | (1 << n) : this.in0 & ~(1 << n);
    } else {
      const n1 = n - 32;
      this.in1 = value ? this.in1 | (1 << n1) : this.in1 & ~(1 << n1);
    }
    this.evaluateInterrupt(n, oldVal, value);
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.onInterruptChange?.(active);
  }

  private evaluateInterrupt(n: number, oldVal: 0 | 1, value: 0 | 1): void {
    const reg = this.pin[n]!;
    const intType = (reg >>> 7) & 0x7;
    if (!getTriggering(intType, oldVal, value)) return;

    const proEnable = (reg & PRO_CPU_INT_ENABLE) !== 0;
    const appEnable = (reg & APP_CPU_INT_ENABLE) !== 0;
    if (!proEnable && !appEnable) return;

    if (n < 32) {
      if (proEnable) this.pcpuInt |= 1 << n;
      if (appEnable) this.acpuInt |= 1 << n;
    } else {
      const n1 = n - 32;
      if (proEnable) this.pcpuInt1 |= 1 << n1;
      if (appEnable) this.acpuInt1 |= 1 << n1;
    }
    this.setActive(true);
  }

  readWord(offset: number): number {
    if (offset >= PIN_REG_BASE && offset < PIN_REG_BASE + PIN_REG_COUNT * 4) {
      return this.pin[(offset - PIN_REG_BASE) / 4]! >>> 0;
    }
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
      case GPIO_REG.STATUS:
        return this.status >>> 0;
      case GPIO_REG.STATUS1:
        return this.status1 >>> 0;
      case GPIO_REG.ACPU_INT:
        return this.acpuInt >>> 0;
      case GPIO_REG.PCPU_INT:
        return this.pcpuInt >>> 0;
      case GPIO_REG.ACPU_INT1:
        return this.acpuInt1 >>> 0;
      case GPIO_REG.PCPU_INT1:
        return this.pcpuInt1 >>> 0;
      default:
        return 0;
    }
  }

  writeWord(offset: number, value: number): void {
    if (offset >= PIN_REG_BASE && offset < PIN_REG_BASE + PIN_REG_COUNT * 4) {
      this.pin[(offset - PIN_REG_BASE) / 4] = value >>> 0;
      return;
    }

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
      case GPIO_REG.STATUS:
        this.status = value >>> 0;
        break;
      case GPIO_REG.STATUS_W1TS:
        this.status = (this.status | value) >>> 0;
        break;
      case GPIO_REG.STATUS_W1TC: {
        let clearirq = true;
        for (let i = 0; i < 32; i++) {
          if (value & (1 << i)) {
            const intType = (this.pin[i]! >>> 7) & 0x7;
            if ((intType === 4 && !(this.in0 & (1 << i))) || (intType === 5 && (this.in0 & (1 << i)) !== 0)) clearirq = false;
          }
        }
        if (clearirq) {
          this.status = (this.status & ~value) >>> 0;
          this.pcpuInt = (this.pcpuInt & ~value) >>> 0;
          this.acpuInt = (this.acpuInt & ~value) >>> 0;
          this.setActive(false); // unconditional - see class doc comment
        }
        break;
      }
      case GPIO_REG.STATUS1:
        this.status1 = value >>> 0;
        break;
      case GPIO_REG.STATUS1_W1TS:
        this.status1 = (this.status1 | value) >>> 0;
        break;
      case GPIO_REG.STATUS1_W1TC: {
        let clearirq = true;
        for (let i = 0; i < 32; i++) {
          if (value & (1 << i)) {
            const intType = (this.pin[i + 32]! >>> 7) & 0x7;
            if ((intType === 4 && !(this.in1 & (1 << i))) || (intType === 5 && (this.in1 & (1 << i)) !== 0)) clearirq = false;
          }
        }
        if (clearirq) {
          this.status1 = (this.status1 & ~value) >>> 0;
          this.pcpuInt1 = (this.pcpuInt1 & ~value) >>> 0;
          this.acpuInt1 = (this.acpuInt1 & ~value) >>> 0;
          this.setActive(false); // unconditional - see class doc comment
        }
        break;
      }
      default:
        break;
    }

    // Loop driven-output pins back into GPIO_IN (esp32_gpio_write's diff
    // check) - see the class doc comment for why. Deliberately does not
    // evaluate interrupts (unlike setPin) - matches the reference exactly.
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
