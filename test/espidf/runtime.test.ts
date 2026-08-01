// SPDX-License-Identifier: MIT
// Copyright (c) vecnode

import { describe, expect, it, vi } from 'vitest';
import { EspIdfRuntime, EspIdfRuntimeStoppedError } from '../../src/espidf/runtime.js';

describe('EspIdfRuntime', () => {
  it('gpioConfig sets direction for every pin covered by the bit mask', () => {
    const runtime = new EspIdfRuntime();
    runtime.gpioConfig((1n << 18n) | (1n << 19n), 'output');
    expect(runtime.readPinDirection(18)).toBe('output');
    expect(runtime.readPinDirection(19)).toBe('output');
    expect(runtime.readPinDirection(4)).toBe('input'); // untouched, real hardware default
  });

  it('gpioSetLevel/gpioGetLevel round-trip after gpioConfig(output)', () => {
    const runtime = new EspIdfRuntime();
    runtime.gpioConfig(1n << 18n, 'output');
    runtime.gpioSetLevel(18, 1);
    expect(runtime.gpioGetLevel(18)).toBe(1);
    runtime.gpioSetLevel(18, 0);
    expect(runtime.gpioGetLevel(18)).toBe(0);
  });

  it('onPinChange only fires on an actual value change', () => {
    const runtime = new EspIdfRuntime();
    runtime.gpioConfig(1n << 18n, 'output');
    const listener = vi.fn();
    runtime.onPinChange(18, listener);
    runtime.gpioSetLevel(18, 0); // already 0
    expect(listener).not.toHaveBeenCalled();
    runtime.gpioSetLevel(18, 1);
    expect(listener).toHaveBeenCalledWith(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setDigitalInput drives an external value, readable via readPin', () => {
    const runtime = new EspIdfRuntime();
    runtime.gpioConfig(1n << 4n, 'input');
    expect(runtime.readPin(4)).toBe(0);
    runtime.setDigitalInput(4, 1);
    expect(runtime.readPin(4)).toBe(1);
  });

  it('delay() throws EspIdfRuntimeStoppedError once requestStop() has been called', () => {
    const runtime = new EspIdfRuntime({ timeScale: 1 });
    runtime.requestStop();
    expect(() => runtime.delay(50)).toThrow(EspIdfRuntimeStoppedError);
  });

  it('rejects an out-of-range pin', () => {
    const runtime = new EspIdfRuntime();
    expect(() => runtime.gpioSetLevel(99, 1)).toThrow(RangeError);
  });

  it('supports GPIO pins up to 39 without 32-bit bitmask truncation', () => {
    const runtime = new EspIdfRuntime();
    runtime.gpioConfig(1n << 39n, 'output');
    expect(runtime.readPinDirection(39)).toBe('output');
    runtime.gpioSetLevel(39, 1);
    expect(runtime.gpioGetLevel(39)).toBe(1);
  });
});
