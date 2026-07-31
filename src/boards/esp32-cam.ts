import { BOOT_STRAP_PINS, PSRAM_PINS, WROOM_FLASH_PINS } from './common.js';
import type { BoardDefinition } from './types.js';

/**
 * AI-Thinker ESP32-CAM. Pin roles below are the widely-used AI-Thinker
 * reference wiring (matches the `CAMERA_MODEL_AI_THINKER` pin table in
 * Espressif's esp32-camera driver). No onboard USB-UART bridge - programming
 * requires an external FTDI-style adapter wired to GPIO1/GPIO3.
 *
 * Some pins double up: GPIO0 is both a boot-strap pin and the camera XCLK
 * (this is exactly why ESP32-CAM needs the module fully powered and idle
 * during flashing); GPIO2/GPIO15 are both boot-strap pins and part of the
 * microSD bus. Each pin is listed once below under its primary role, with
 * the overlap called out in the note.
 */
export const ESP32_CAM: BoardDefinition = {
  name: 'ESP32-CAM (AI-Thinker)',
  module: 'ESP32-WROVER (or equivalent PSRAM-equipped module)',
  hasPsram: true,
  hasUsbUart: false,
  pins: [
    ...BOOT_STRAP_PINS.map((pin) => {
      switch (pin.gpio) {
        case 0:
          return { ...pin, note: `${pin.note}; also camera XCLK` };
        case 2:
          return { ...pin, note: `${pin.note}; also microSD D0` };
        case 5:
          return { ...pin, note: `${pin.note}; also camera Y2/D0` };
        case 15:
          return { ...pin, note: `${pin.note}; also microSD CMD` };
        default:
          return pin;
      }
    }),
    ...WROOM_FLASH_PINS,
    ...PSRAM_PINS,
    // GPIO34/35/36/39 (input-only) are all reused as camera data lines
    // below (Y8/Y9/Y7/Y6) - being input-only is exactly why they're a
    // natural fit for camera DATA inputs, so they're not repeated here.
    { gpio: 1, role: 'usb-uart', note: 'TX0 - requires external FTDI adapter, no onboard bridge' },
    { gpio: 3, role: 'usb-uart', note: 'RX0 - requires external FTDI adapter, no onboard bridge' },
    { gpio: 4, role: 'led', note: 'onboard flash LED; also camera Y2/D0 data line' },
    { gpio: 14, role: 'sd-card', note: 'microSD CLK' },
    { gpio: 32, role: 'camera', note: 'PWDN' },
    { gpio: 26, role: 'camera', note: 'SIOD (I2C SDA to OV2640)' },
    { gpio: 27, role: 'camera', note: 'SIOC (I2C SCL to OV2640)' },
    { gpio: 35, role: 'camera', note: 'Y9 / D7' },
    { gpio: 34, role: 'camera', note: 'Y8 / D6' },
    { gpio: 39, role: 'camera', note: 'Y7 / D5' },
    { gpio: 36, role: 'camera', note: 'Y6 / D4' },
    { gpio: 21, role: 'camera', note: 'Y5 / D3' },
    { gpio: 19, role: 'camera', note: 'Y4 / D2' },
    { gpio: 18, role: 'camera', note: 'Y3 / D1' },
    { gpio: 25, role: 'camera', note: 'VSYNC' },
    { gpio: 23, role: 'camera', note: 'HREF' },
    { gpio: 22, role: 'camera', note: 'PCLK' },
  ],
};
