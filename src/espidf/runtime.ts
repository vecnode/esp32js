// SPDX-License-Identifier: MIT
// Copyright (c) vecnode
//
// A CPU-independent, JS/TS-native ESP-IDF runtime: sketches call the
// real ESP-IDF C API's own function/constant names (gpio_config/
// gpio_set_level/gpio_get_level/vTaskDelay - see sketch-globals.ts)
// directly, no compiler, no Xtensa machine code, no esp32js CPU core
// involved at all. Mirrors avr8js/arduino's ArduinoRuntime and
// rp2040js/pico's PicoRuntime in shape and reasoning - see either for
// the fuller "why a parallel, lower-fidelity execution mode" rationale.
//
// Faithful to the real ESP-IDF API's own semantics (a pin's direction is
// whatever the most recent gpio_config() call covering it set - real
// hardware, not a simplified model; gpio_set_level()/gpio_get_level()
// work on any configured pin) - not a simplified or invented API shape.
//
// Uses Date.now() rather than avr8js/arduino's/rp2040js/pico's own
// performance.now() - this package's own tsconfig.json lib is ES2020
// only (no DOM/WebWorker lib), so `performance` isn't a known global
// here; millisecond resolution is more than enough for the ~4ms
// busy-wait slices delay() already uses.

export type PinDirection = 'input' | 'output';

export type PinChangeListener = (value: number) => void;

const DEFAULT_PIN_COUNT = 40; // GPIO0-GPIO39, the ESP32's real GPIO range

export interface EspIdfRuntimeOptions {
  pinCount?: number;
  /** Same purpose as avr8js/arduino's ArduinoRuntimeOptions.timeScale - see there. */
  timeScale?: number;
}

/** Thrown out of delay() (vTaskDelay's backing implementation) once requestStop() has been called - see avr8js/arduino's identical ArduinoRuntimeStoppedError for the full reasoning. */
export class EspIdfRuntimeStoppedError extends Error {
  constructor() {
    super('EspIdfRuntime: stop() requested while inside vTaskDelay()');
    this.name = 'EspIdfRuntimeStoppedError';
  }
}

export class EspIdfRuntime {
  private readonly pinCount: number;
  private readonly timeScale: number;

  // undefined-direction pins (never gpio_config()'d) read as 'input' by
  // default (this.directions' own array fill) - real ESP-IDF GPIOs reset
  // to input, matching every pin's real hardware default.
  private readonly directions: PinDirection[];
  private readonly values: number[];
  private readonly listeners: Array<Set<PinChangeListener>>;

  private readonly startTime: number;
  private stopRequested = false;

  constructor(options: EspIdfRuntimeOptions = {}) {
    this.pinCount = options.pinCount ?? DEFAULT_PIN_COUNT;
    this.timeScale = options.timeScale ?? 1;
    this.directions = new Array(this.pinCount).fill('input') as PinDirection[];
    this.values = new Array(this.pinCount).fill(0) as number[];
    this.listeners = Array.from({ length: this.pinCount }, () => new Set<PinChangeListener>());
    this.startTime = Date.now();
  }

  private checkPin(pin: number): void {
    if (pin < 0 || pin >= this.pinCount || !Number.isInteger(pin)) {
      throw new RangeError(`EspIdfRuntime: pin ${pin} is out of range`);
    }
  }

  private setValue(pin: number, value: number): void {
    if (this.values[pin] === value) return;
    this.values[pin] = value;
    for (const listener of this.listeners[pin]!) listener(value);
  }

  // ---- ESP-IDF API surface, called by the interpreted sketch ------------

  /**
   * gpio_config() - `pinBitMask` is the real gpio_config_t.pin_bit_mask
   * shape (bit N set means GPIO N is covered by this call), taken as a
   * bigint so pins up to 39 are representable without JS's 32-bit
   * bitwise-operator truncation (a plain `1 << 35` would silently wrap
   * in JS, unlike C's `1ULL << 35`).
   */
  gpioConfig(pinBitMask: bigint, mode: PinDirection): void {
    for (let pin = 0; pin < this.pinCount; pin++) {
      if ((pinBitMask & (1n << BigInt(pin))) !== 0n) {
        this.directions[pin] = mode;
      }
    }
  }

  gpioSetLevel(pin: number, value: 0 | 1 | boolean): void {
    this.checkPin(pin);
    this.setValue(pin, value ? 1 : 0);
  }

  gpioGetLevel(pin: number): 0 | 1 {
    this.checkPin(pin);
    return this.values[pin] ? 1 : 0;
  }

  /**
   * Backs vTaskDelay() (see sketch-globals.ts - real ESP-IDF ticks are
   * converted to ms via portTICK_PERIOD_MS before reaching here). Same
   * real, blocking busy-wait as avr8js/arduino's delay()/rp2040js/pico's
   * sleepMs() - see either's own doc comment for why (JS has no
   * synchronous yield) and for the stop()-latency trade-off this
   * implies.
   */
  delay(ms: number): void {
    const deadline = Date.now() + ms / this.timeScale;
    while (Date.now() < deadline) {
      if (this.stopRequested) {
        throw new EspIdfRuntimeStoppedError();
      }
      const remaining = deadline - Date.now();
      const slice = Math.min(remaining, 4);
      const sliceDeadline = Date.now() + slice;
      while (Date.now() < sliceDeadline) {
        /* busy-wait */
      }
    }
  }

  millis(): number {
    return Math.floor((Date.now() - this.startTime) * this.timeScale);
  }

  // ---- External drivers (adapter / placed components) -------------------

  setDigitalInput(pin: number, value: 0 | 1): void {
    this.checkPin(pin);
    this.setValue(pin, value ? 1 : 0);
  }

  readPinDirection(pin: number): PinDirection {
    this.checkPin(pin);
    return this.directions[pin]!;
  }

  readPin(pin: number): number {
    this.checkPin(pin);
    return this.values[pin]!;
  }

  onPinChange(pin: number, listener: PinChangeListener): () => void {
    this.checkPin(pin);
    this.listeners[pin]!.add(listener);
    return () => this.listeners[pin]!.delete(listener);
  }

  // ---- Lifecycle ----------------------------------------------------------

  requestStop(): void {
    this.stopRequested = true;
  }

  get stopped(): boolean {
    return this.stopRequested;
  }
}
