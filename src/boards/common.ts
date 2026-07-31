import type { PinAssignment } from './types.js';

/**
 * Pin reservations shared by every ESP32-WROOM/WROVER-based board: the
 * module's integrated SPI flash bus (GPIO6-11), the four input-only pins
 * (GPIO34-39, no output driver or pull resistors), and the boot-strapping
 * pins sampled at reset (GPIO0/2/5/12/15). Source: Espressif ESP32
 * datasheet, "Pin Definitions" / "Strapping Pins" sections.
 */
export const WROOM_FLASH_PINS: readonly PinAssignment[] = [
  { gpio: 6, role: 'flash-spi', note: 'SD_CLK - integrated flash, not usable' },
  { gpio: 7, role: 'flash-spi', note: 'SD_DATA0 - integrated flash, not usable' },
  { gpio: 8, role: 'flash-spi', note: 'SD_DATA1 - integrated flash, not usable' },
  { gpio: 9, role: 'flash-spi', note: 'SD_DATA2 - integrated flash, not usable' },
  { gpio: 10, role: 'flash-spi', note: 'SD_DATA3 - integrated flash, not usable' },
  { gpio: 11, role: 'flash-spi', note: 'SD_CMD - integrated flash, not usable' },
];

export const INPUT_ONLY_PINS: readonly PinAssignment[] = [34, 35, 36, 39].map((gpio) => ({
  gpio,
  role: 'input-only',
  note: 'no output driver, no internal pull-up/down',
}));

/**
 * GPIO16/17 (HSPI CS/CLK) are dedicated to the PSRAM chip on
 * ESP32-WROVER-class modules - internal to the module, same as the flash
 * pins above, just for a second chip. Only relevant to boards with PSRAM.
 */
export const PSRAM_PINS: readonly PinAssignment[] = [
  { gpio: 16, role: 'flash-spi', note: 'PSRAM CS (WROVER-class module), not usable' },
  { gpio: 17, role: 'flash-spi', note: 'PSRAM CLK (WROVER-class module), not usable' },
];

export const BOOT_STRAP_PINS: readonly PinAssignment[] = [
  { gpio: 0, role: 'boot-strap', note: 'low at reset = download mode' },
  { gpio: 2, role: 'boot-strap', note: 'must be floating or low at reset' },
  { gpio: 5, role: 'boot-strap', note: 'VSPI CS0 / timing strap' },
  { gpio: 12, role: 'boot-strap', note: 'MTDI - flash voltage select, avoid pull-up' },
  { gpio: 15, role: 'boot-strap', note: 'MTDO - must be low to avoid boot log silence' },
];
