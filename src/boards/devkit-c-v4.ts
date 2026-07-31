import { BOOT_STRAP_PINS, INPUT_ONLY_PINS, WROOM_FLASH_PINS } from './common.js';
import type { BoardDefinition } from './types.js';

/**
 * Espressif's official "ESP32-DevKitC V4", CP2102N USB-UART. Electrically
 * identical GPIO map to DevKit V1 - the difference is the USB-UART bridge
 * chip and silkscreen layout, not SoC wiring, so pin roles are the same.
 */
export const ESP32_DEVKIT_C_V4: BoardDefinition = {
  name: 'ESP32 DevKit C V4',
  module: 'ESP32-WROOM-32',
  hasPsram: false,
  hasUsbUart: true,
  pins: [
    ...BOOT_STRAP_PINS,
    ...WROOM_FLASH_PINS,
    ...INPUT_ONLY_PINS,
    { gpio: 1, role: 'usb-uart', note: 'TX0, shared with USB-UART bridge' },
    { gpio: 3, role: 'usb-uart', note: 'RX0, shared with USB-UART bridge' },
  ],
};
