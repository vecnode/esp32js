/**
 * Board-level pin metadata. Unlike src/soc, none of this is sourced from
 * QEMU's C implementation - hw/xtensa/esp32_picsimlab.c models the ESP32
 * SoC only, not any specific board. This is standard, publicly documented
 * ESP32 module/board wiring (Espressif's ESP32 datasheet + AI-Thinker's
 * ESP32-CAM reference schematic), used to decide which GPIOs physicalsim
 * may safely drive on a given board.
 */

export type PinRole =
  | 'boot-strap' // sampled at reset; must be held/left as documented to boot
  | 'flash-spi' // wired to the module's integrated SPI flash, not user-usable
  | 'input-only' // GPIO34-39: no output driver, no internal pull-up/down
  | 'usb-uart' // routed to the onboard USB-UART bridge chip
  | 'camera' // OV2640 DVP interface (ESP32-CAM only)
  | 'sd-card' // microSD SPI/SDMMC interface (ESP32-CAM only)
  | 'led' // onboard LED, fixed function
  | 'general';

export interface PinAssignment {
  readonly gpio: number;
  readonly role: PinRole;
  readonly note: string;
}

export interface BoardDefinition {
  readonly name: string;
  /** Espressif module mounted on the board (determines flash-spi pins). */
  readonly module: string;
  readonly hasPsram: boolean;
  readonly hasUsbUart: boolean;
  readonly pins: readonly PinAssignment[];
}
