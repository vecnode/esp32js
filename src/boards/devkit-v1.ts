import { BOOT_STRAP_PINS, INPUT_ONLY_PINS, WROOM_FLASH_PINS } from './common.js';
import type { BoardDefinition } from './types.js';

/** Widely-cloned "ESP32 DevKit V1" (aka DOIT ESP32 DevKit V1), CP2102 USB-UART. */
export const ESP32_DEVKIT_V1: BoardDefinition = {
  name: 'ESP32 DevKit V1',
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
