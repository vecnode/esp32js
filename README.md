# esp32js

An ESP32 (Xtensa LX6) CPU and peripheral interpreter written in TypeScript, for running in the browser or Node for ESP32.

## Scope

This is a from-scratch interpreter, not a wrapper around QEMU. It loads a real compiled ESP32 binary directly — pass it the `.elf` your `xtensa-esp32-elf-gcc`/ESP-IDF toolchain already produces (`loadElf`, no JavaScript firmware or hand-assembled test program required) — and runs it against simulated peripherals:

- Xtensa LX6 core: ALU, load/store, branches, windowed register calls (`CALL4/8/12`, `ENTRY`/`RETW`), full XEA2 exception/interrupt model (levels 1-6 plus unmaskable NMI, RSIL/RFI/RFE), single-precision FPU
- Peripherals: GPIO + IO_MUX, TIMG timers, UART, SAR ADC, interrupt matrix

Because each peripheral and CPU feature is modeled against real ESP32 register addresses and behavior (not a black box), esp32js is meant to be embedded as the ESP32 emulator behind a larger simulation — standing in for one or many physical ESP32 boards — driven and observed through the same GPIO/ADC injection points real firmware would see on hardware.

**Explicitly out of scope:** WiFi/Bluetooth MAC/radio emulation, cache/MMU (ESP32 has no page-table MMU — it's identity-mapped, so none is needed), crypto accelerators (AES/RSA/SHA/HMAC), FLIX/HiFi/DSP instruction extensions, esptool's flash-image container format (only the `.elf` itself is loaded, not a flashable `.bin`). None of these are present in the target hardware config or are needed to run and drive firmware logic.

## Development

```
npm install
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
