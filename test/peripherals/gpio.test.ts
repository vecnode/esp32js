import { describe, expect, it } from 'vitest';
import { Gpio, GPIO_REG } from '../../src/peripherals/gpio.js';

describe('Gpio', () => {
  it('resets with GPIO_IN=0x1 and GPIO_IN1=0x8, matching esp32_gpio_init', () => {
    const gpio = new Gpio();
    expect(gpio.readWord(GPIO_REG.IN)).toBe(0x1);
    expect(gpio.readWord(GPIO_REG.IN1)).toBe(0x8);
    expect(gpio.readWord(GPIO_REG.STRAP)).toBe(0x12); // ESP32_STRAP_MODE_FLASH_BOOT
  });

  it('GPIO_OUT/GPIO_ENABLE round-trip via plain writes', () => {
    const gpio = new Gpio();
    gpio.writeWord(GPIO_REG.OUT, 0xdeadbeef);
    gpio.writeWord(GPIO_REG.ENABLE, 0xcafef00d);
    expect(gpio.readWord(GPIO_REG.OUT)).toBe(0xdeadbeef >>> 0);
    expect(gpio.readWord(GPIO_REG.ENABLE)).toBe(0xcafef00d >>> 0);
  });

  it('GPIO_OUT_W1TS sets bits without disturbing others', () => {
    const gpio = new Gpio();
    gpio.writeWord(GPIO_REG.OUT, 0b0001);
    gpio.writeWord(GPIO_REG.OUT_W1TS, 0b0100);
    expect(gpio.readWord(GPIO_REG.OUT)).toBe(0b0101);
  });

  it('GPIO_OUT_W1TC clears bits without disturbing others', () => {
    const gpio = new Gpio();
    gpio.writeWord(GPIO_REG.OUT, 0b0111);
    gpio.writeWord(GPIO_REG.OUT_W1TC, 0b0010);
    expect(gpio.readWord(GPIO_REG.OUT)).toBe(0b0101);
  });

  it('GPIO_ENABLE_W1TS/W1TC set/clear direction bits', () => {
    const gpio = new Gpio();
    gpio.writeWord(GPIO_REG.ENABLE_W1TS, 0b0011);
    expect(gpio.readWord(GPIO_REG.ENABLE)).toBe(0b0011);
    gpio.writeWord(GPIO_REG.ENABLE_W1TC, 0b0001);
    expect(gpio.readWord(GPIO_REG.ENABLE)).toBe(0b0010);
  });

  it('driving an output pin (enabled) loops back into GPIO_IN and getPin', () => {
    const gpio = new Gpio();
    gpio.writeWord(GPIO_REG.ENABLE_W1TS, 1 << 5); // pin 5 as output
    gpio.writeWord(GPIO_REG.OUT_W1TS, 1 << 5); // drive it high

    expect(gpio.getPin(5)).toBe(1);
    expect(gpio.readWord(GPIO_REG.IN) & (1 << 5)).toBe(1 << 5);

    gpio.writeWord(GPIO_REG.OUT_W1TC, 1 << 5); // drive it low
    expect(gpio.getPin(5)).toBe(0);
  });

  it('a pin not configured as output does not loop back into GPIO_IN', () => {
    const gpio = new Gpio();
    // Never enabled as output - writing GPIO_OUT for it should not affect GPIO_IN.
    gpio.writeWord(GPIO_REG.OUT_W1TS, 1 << 10);
    expect(gpio.getPin(10)).toBe(0);
  });

  it('setPin drives an input pin externally (0-31 via GPIO_IN)', () => {
    const gpio = new Gpio();
    gpio.setPin(7, 1);
    expect(gpio.getPin(7)).toBe(1);
    expect(gpio.readWord(GPIO_REG.IN) & (1 << 7)).toBe(1 << 7);

    gpio.setPin(7, 0);
    expect(gpio.getPin(7)).toBe(0);
  });

  it('setPin drives pins 32-39 via GPIO_IN1', () => {
    const gpio = new Gpio();
    gpio.setPin(35, 1); // bit 3 of GPIO_IN1, already 1 at reset
    expect(gpio.getPin(35)).toBe(1);
    gpio.setPin(35, 0);
    expect(gpio.getPin(35)).toBe(0);
    expect(gpio.readWord(GPIO_REG.IN1)).toBe(0);
  });

  it('unrecognized offsets read as 0', () => {
    const gpio = new Gpio();
    expect(gpio.readWord(0x90000)).toBe(0); // well outside any real register range
  });

  it('GPIO_PINn (pin 0 at 0x88) round-trips as plain storage, reset to 0', () => {
    const gpio = new Gpio();
    expect(gpio.readWord(0x88)).toBe(0);
    gpio.writeWord(0x88, 0x12345678);
    expect(gpio.readWord(0x88)).toBe(0x12345678);
    // pin 1 (0x8c) is independent
    expect(gpio.readWord(0x8c)).toBe(0);
  });
});

describe('Gpio interrupt generation', () => {
  const PIN0_REG = 0x88; // GPIO_PINn base, n=0
  const pinReg = (n: number) => PIN0_REG + n * 4;
  const intType = (type: number, proEnable = true) => (type << 7) | (proEnable ? 1 << 15 : 0);

  it('setPin on a rising-edge-configured pin (INT_TYPE=1) fires onInterruptChange and latches GPIO_PCPU_INT', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(1));
    const events: boolean[] = [];
    gpio.onInterruptChange = (active) => events.push(active);

    gpio.setPin(5, 0); // already 0 at reset (bit 5 of in0=0x1 is 0) - no edge, no fire
    expect(events).toEqual([]);
    gpio.setPin(5, 1); // 0 -> 1 rising edge
    expect(events).toEqual([true]);
    expect(gpio.readWord(0x68) & (1 << 5)).toBe(1 << 5); // GPIO_PCPU_INT
  });

  it('a falling-edge pin (INT_TYPE=2) does not fire on a rising edge', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(2));
    let fired = false;
    gpio.onInterruptChange = () => (fired = true);

    gpio.setPin(5, 1); // rising - not configured for this
    expect(fired).toBe(false);
    gpio.setPin(5, 0); // falling - matches
    expect(fired).toBe(true);
  });

  it('a level-triggered pin (INT_TYPE=5, high level) keeps firing every call while the level holds', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(5));
    const events: boolean[] = [];
    gpio.onInterruptChange = (active) => events.push(active);

    gpio.setPin(5, 1);
    gpio.setPin(5, 1); // still high - level type re-evaluates regardless of oldVal
    expect(events).toEqual([true]); // onInterruptChange only fires on a genuine active-state flip
    expect(gpio.readWord(0x68) & (1 << 5)).toBe(1 << 5);
  });

  it('neither PRO_CPU_INT_ENABLE nor APP_CPU_INT_ENABLE set means a triggered edge does nothing', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), 1 << 7); // INT_TYPE=1 (rising), no enable bits
    let fired = false;
    gpio.onInterruptChange = () => (fired = true);
    gpio.setPin(5, 1);
    expect(fired).toBe(false);
    expect(gpio.readWord(0x68)).toBe(0);
  });

  it('APP_CPU_INT_ENABLE alone latches GPIO_ACPU_INT and drives the same combined interrupt', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), (1 << 7) | (1 << 13)); // INT_TYPE=1, app-cpu enable only
    let fired = false;
    gpio.onInterruptChange = () => (fired = true);
    gpio.setPin(5, 1);
    expect(fired).toBe(true);
    expect(gpio.readWord(0x60) & (1 << 5)).toBe(1 << 5); // GPIO_ACPU_INT
    expect(gpio.readWord(0x68)).toBe(0); // GPIO_PCPU_INT untouched
  });

  it('output-loopback writes (GPIO_OUT) never evaluate interrupts, only setPin does', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(1)); // rising, pro-cpu enabled
    let fired = false;
    gpio.onInterruptChange = () => (fired = true);

    gpio.writeWord(0x24, 1 << 5); // ENABLE_W1TS - pin 5 as output
    gpio.writeWord(0x08, 1 << 5); // OUT_W1TS - drive it high, loops back into GPIO_IN
    expect(gpio.getPin(5)).toBe(1); // loopback did happen
    expect(fired).toBe(false); // but no interrupt was evaluated for it
  });

  it('GPIO_STATUS_W1TC refuses to clear a still-active level condition (INT_TYPE=5, still high)', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(5));
    gpio.setPin(5, 1); // fires, still high
    gpio.writeWord(0x4c, 1 << 5); // GPIO_STATUS_W1TC
    expect(gpio.readWord(0x68) & (1 << 5)).toBe(1 << 5); // GPIO_PCPU_INT NOT cleared - level still active
  });

  it('GPIO_STATUS_W1TC clears once the level condition is gone, and calls onInterruptChange(false)', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(5));
    gpio.setPin(5, 1);
    gpio.setPin(5, 0); // level condition (high) is gone now
    const events: boolean[] = [];
    gpio.onInterruptChange = (active) => events.push(active);

    gpio.writeWord(0x4c, 1 << 5);
    expect(events).toEqual([false]);
    expect(gpio.readWord(0x68) & (1 << 5)).toBe(0);
  });

  it("GPIO_STATUS_W1TC unconditionally lowers the combined line, even if pins 32-39's interrupt is still pending (a real reference quirk)", () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(1)); // pin 5 (0-31 half), rising edge
    gpio.writeWord(pinReg(32), intType(1)); // pin 32 (32-39 half, bit 0 of IN1, default 0), rising edge
    gpio.setPin(5, 1);
    gpio.setPin(32, 1);
    expect(gpio.readWord(0x68) & (1 << 5)).toBe(1 << 5);
    expect(gpio.readWord(0x7c) & 1).toBe(1); // GPIO_PCPU_INT1, bit 0 = pin 32

    const events: boolean[] = [];
    gpio.onInterruptChange = (active) => events.push(active);
    gpio.writeWord(0x4c, 1 << 5); // clear only pin 5's half
    expect(events).toEqual([false]); // combined line dropped anyway
    expect(gpio.readWord(0x7c) & 1).toBe(1); // pin 32's latch is untouched by this write
  });

  it('STATUS1_W1TC mirrors STATUS_W1TC for pins 32-39', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(32), intType(1)); // bit 0 of IN1, default 0
    gpio.setPin(32, 1);
    expect(gpio.readWord(0x7c) & 1).toBe(1);

    gpio.writeWord(0x58, 1); // GPIO_STATUS1_W1TC
    expect(gpio.readWord(0x7c) & 1).toBe(0);
  });

  it('GPIO_STATUS/STATUS1 are plain read/write storage, untouched by setPin (vestigial in the reference)', () => {
    const gpio = new Gpio();
    gpio.writeWord(pinReg(5), intType(1));
    gpio.setPin(5, 1); // fires a real interrupt via PCPU_INT, but GPIO_STATUS itself...
    expect(gpio.readWord(0x44)).toBe(0); // ...was never touched

    gpio.writeWord(0x44, 0xabc);
    expect(gpio.readWord(0x44)).toBe(0xabc);
  });
});
