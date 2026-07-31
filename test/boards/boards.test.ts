import { describe, expect, it } from 'vitest';
import { ESP32_CAM, ESP32_DEVKIT_C_V4, ESP32_DEVKIT_V1 } from '../../src/boards/index.js';
import type { BoardDefinition } from '../../src/boards/types.js';

const boards: readonly BoardDefinition[] = [ESP32_DEVKIT_V1, ESP32_DEVKIT_C_V4, ESP32_CAM];

describe.each(boards)('$name', (board) => {
  it('assigns each GPIO number at most once', () => {
    const seen = new Set<number>();
    for (const pin of board.pins) {
      expect(seen.has(pin.gpio), `GPIO${pin.gpio} assigned more than once`).toBe(false);
      seen.add(pin.gpio);
    }
  });

  it('uses only valid ESP32 GPIO numbers (0-39)', () => {
    for (const pin of board.pins) {
      expect(pin.gpio).toBeGreaterThanOrEqual(0);
      expect(pin.gpio).toBeLessThanOrEqual(39);
    }
  });

  it('never assigns an input-only pin (34, 35, 36, 39) an output-driven role', () => {
    // Input-only GPIOs have no output driver, so they can only ever be
    // 'input-only' or a role that is itself input-driven (e.g. camera data
    // lines, which are inputs to the SoC) - never anything requiring the
    // SoC to drive the pin, like usb-uart, led, or boot-strap.
    const inputOnly = new Set([34, 35, 36, 39]);
    const outputRoles = new Set(['usb-uart', 'led', 'boot-strap', 'general']);
    for (const pin of board.pins) {
      if (inputOnly.has(pin.gpio)) {
        expect(outputRoles.has(pin.role)).toBe(false);
      }
    }
  });
});

describe('board differences match their datasheets', () => {
  it('only ESP32-CAM has PSRAM', () => {
    expect(ESP32_DEVKIT_V1.hasPsram).toBe(false);
    expect(ESP32_DEVKIT_C_V4.hasPsram).toBe(false);
    expect(ESP32_CAM.hasPsram).toBe(true);
  });

  it('only ESP32-CAM lacks an onboard USB-UART bridge', () => {
    expect(ESP32_DEVKIT_V1.hasUsbUart).toBe(true);
    expect(ESP32_DEVKIT_C_V4.hasUsbUart).toBe(true);
    expect(ESP32_CAM.hasUsbUart).toBe(false);
  });

  it('DevKit V1 and DevKit C V4 share the same electrical pin map', () => {
    const strip = (b: BoardDefinition) => b.pins.map((p) => [p.gpio, p.role]);
    expect(strip(ESP32_DEVKIT_V1)).toEqual(strip(ESP32_DEVKIT_C_V4));
  });
});
