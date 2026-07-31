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
    expect(gpio.readWord(0x88)).toBe(0); // GPIO_PINxx - not implemented
  });
});
