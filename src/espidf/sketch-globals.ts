// SPDX-License-Identifier: MIT
// Copyright (c) vecnode
//
// Builds the global-scope object bag a JS-interpreted ESP-IDF sketch
// runs against - the real ESP-IDF C API's own names (gpio_config,
// gpio_set_level, GPIO_MODE_OUTPUT, vTaskDelay, portTICK_PERIOD_MS, ...),
// bound to one EspIdfRuntime instance. Mirrors avr8js/arduino's and
// rp2040js/pico's own sketch-globals.ts shape.
//
// setup()/loop() (JS-ergonomic, not real ESP-IDF's single app_main()
// with its own internal `while (1) { ...; vTaskDelay(...); }`) for the
// same reason rp2040js/pico's sketches use setup()/loop() instead of a
// literal pico-sdk main(): a real infinite loop written directly in the
// interpreted sketch can never return control to the adapter's own
// scheduler, so stop() could never take effect at all (a busy-wait
// vTaskDelay() blocks the whole Worker thread - see EspIdfRuntime.delay()'s
// own doc comment). Splitting one-time gpio_config() calls into setup()
// and the repeated body into loop() preserves every real function/
// constant name and semantic while keeping the same "stop takes effect
// between iterations" contract every other JS-native adapter already has.

import { EspIdfRuntime, type PinDirection } from './runtime.js';

// Real ESP-IDF gpio_mode_t enum values (esp-idf's own hal/gpio_types.h),
// not invented ones.
export const GPIO_MODE_DISABLE = 0;
export const GPIO_MODE_INPUT = 1;
export const GPIO_MODE_OUTPUT = 2;
export const GPIO_MODE_OUTPUT_OD = 3;
export const GPIO_MODE_INPUT_OUTPUT_OD = 5;
export const GPIO_MODE_INPUT_OUTPUT = 7;

// Real ESP-IDF default (esp-idf's own FreeRTOSConfig.h:
// configTICK_RATE_HZ=1000, so portTICK_PERIOD_MS = 1000/1000 = 1) - not
// an invented constant.
export const portTICK_PERIOD_MS = 1;

export interface GpioConfig {
  pin_bit_mask: bigint | number;
  mode: number;
}

export interface SketchGlobals {
  gpio_config: (conf: GpioConfig) => void;
  gpio_set_level: (pin: number, level: number | boolean) => void;
  gpio_get_level: (pin: number) => 0 | 1;
  vTaskDelay: (ticks: number) => void;
  portTICK_PERIOD_MS: number;
  GPIO_MODE_DISABLE: number;
  GPIO_MODE_INPUT: number;
  GPIO_MODE_OUTPUT: number;
  GPIO_MODE_OUTPUT_OD: number;
  GPIO_MODE_INPUT_OUTPUT_OD: number;
  GPIO_MODE_INPUT_OUTPUT: number;
}

// gpio_mode_t -> this runtime's own binary PinDirection - OUTPUT/
// OUTPUT_OD/INPUT_OUTPUT* all mean "the pin can be driven", matching the
// real hardware fact that every one of those modes enables the output
// driver; the OD (open-drain)/INPUT_OUTPUT distinctions have no separate
// electrical model here (see runtime.ts's own doc comment on this
// project's "no per-component circuit solver" scope).
function toPinDirection(mode: number): PinDirection {
  return mode === GPIO_MODE_OUTPUT || mode === GPIO_MODE_OUTPUT_OD || mode === GPIO_MODE_INPUT_OUTPUT_OD || mode === GPIO_MODE_INPUT_OUTPUT
    ? 'output'
    : 'input';
}

export function createSketchGlobals(runtime: EspIdfRuntime): SketchGlobals {
  return {
    gpio_config: (conf) => runtime.gpioConfig(BigInt(conf.pin_bit_mask), toPinDirection(conf.mode)),
    gpio_set_level: (pin, level) => runtime.gpioSetLevel(pin, level ? 1 : 0),
    gpio_get_level: (pin) => runtime.gpioGetLevel(pin),
    vTaskDelay: (ticks) => runtime.delay(ticks * portTICK_PERIOD_MS),
    portTICK_PERIOD_MS,
    GPIO_MODE_DISABLE,
    GPIO_MODE_INPUT,
    GPIO_MODE_OUTPUT,
    GPIO_MODE_OUTPUT_OD,
    GPIO_MODE_INPUT_OUTPUT_OD,
    GPIO_MODE_INPUT_OUTPUT,
  };
}

export interface CompiledSketch {
  setup: () => void;
  loop: () => void;
}

/**
 * Interprets sketch source text as a JS function body exposing `setup`
 * and `loop` - no compiler involved. Same shape/reasoning as
 * avr8js/arduino's and rp2040js/pico's own compileSketch().
 */
export function compileSketch(source: string, globals: SketchGlobals): CompiledSketch {
  const globalNames = Object.keys(globals);
  const globalValues = Object.values(globals);
  const factory = new Function(
    ...globalNames,
    `"use strict";\n${source}\nreturn { setup: typeof setup === 'function' ? setup : function(){}, loop: typeof loop === 'function' ? loop : function(){} };`,
  ) as (...args: unknown[]) => CompiledSketch;
  const compiled = factory(...globalValues);
  if (typeof compiled.setup !== 'function' || typeof compiled.loop !== 'function') {
    throw new Error('Sketch must define setup() and loop() functions');
  }
  return compiled;
}
