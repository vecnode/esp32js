// SPDX-License-Identifier: MIT
// Copyright (c) vecnode

import { describe, expect, it } from 'vitest';
import { EspIdfRuntime } from '../../src/espidf/runtime.js';
import { compileSketch, createSketchGlobals } from '../../src/espidf/sketch-globals.js';

describe('compileSketch (espidf)', () => {
  it('runs a real ESP-IDF-shaped GPIO blink sketch against the runtime', () => {
    const runtime = new EspIdfRuntime({ timeScale: 1_000_000 });
    const globals = createSketchGlobals(runtime);
    const sketch = compileSketch(
      `
      const GPIO_OUTPUT_IO_0 = 18;
      function setup() {
        const io_conf = {};
        io_conf.mode = GPIO_MODE_OUTPUT;
        io_conf.pin_bit_mask = (1 << GPIO_OUTPUT_IO_0);
        gpio_config(io_conf);
      }
      let cnt = 0;
      function loop() {
        vTaskDelay(1000 / portTICK_PERIOD_MS);
        gpio_set_level(GPIO_OUTPUT_IO_0, cnt % 2);
        cnt++;
      }
      `,
      globals,
    );

    sketch.setup();
    expect(runtime.readPinDirection(18)).toBe('output');

    sketch.loop();
    expect(runtime.readPin(18)).toBe(0); // cnt=0 -> level 0
    sketch.loop();
    expect(runtime.readPin(18)).toBe(1); // cnt=1 -> level 1
  });

  it('a button-mirrors-to-LED sketch (gpio_get_level feeding gpio_set_level) works', () => {
    const runtime = new EspIdfRuntime({ timeScale: 1_000_000 });
    const globals = createSketchGlobals(runtime);
    const sketch = compileSketch(
      `
      const BUTTON_PIN = 4;
      const LED_PIN = 5;
      function setup() {
        const input_conf = {};
        input_conf.mode = GPIO_MODE_INPUT;
        input_conf.pin_bit_mask = (1 << BUTTON_PIN);
        gpio_config(input_conf);

        const output_conf = {};
        output_conf.mode = GPIO_MODE_OUTPUT;
        output_conf.pin_bit_mask = (1 << LED_PIN);
        gpio_config(output_conf);
      }
      function loop() {
        gpio_set_level(LED_PIN, gpio_get_level(BUTTON_PIN));
        vTaskDelay(1);
      }
      `,
      globals,
    );
    sketch.setup();
    runtime.setDigitalInput(4, 1);
    sketch.loop();
    expect(runtime.readPin(5)).toBe(1);
    runtime.setDigitalInput(4, 0);
    sketch.loop();
    expect(runtime.readPin(5)).toBe(0);
  });

  it('throws when the sketch source has a syntax error', () => {
    const runtime = new EspIdfRuntime();
    const globals = createSketchGlobals(runtime);
    expect(() => compileSketch('this is not valid javascript {{{', globals)).toThrow();
  });
});
