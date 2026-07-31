# esp32js

An ESP32 (Xtensa LX6) CPU and peripheral interpreter written in TypeScript, for running in the browser or Node — in the spirit of [avr8js](https://github.com/wokwi/avr8js), for ESP32 instead of AVR8.

## Scope

This is a from-scratch interpreter, not a port of QEMU. It targets exactly what a firmware simulator needs to run real ESP-IDF binaries against simulated GPIO/ADC/timer/UART peripherals:

- Xtensa LX6 core: ALU, load/store, branches, windowed register calls (`CALL4/8/12`, `ENTRY`/`RETW`), XEA2 exceptions and interrupts, single-precision FP
- Peripherals: GPIO (+ GPIO matrix), TIMG timers, UART, SAR ADC, interrupt matrix

**Explicitly out of scope:** WiFi/Bluetooth MAC/radio emulation, cache/MMU (ESP32 has no page-table MMU — it's identity-mapped, so none is needed), crypto accelerators (AES/RSA/SHA/HMAC), FLIX/HiFi/DSP instruction extensions. None of these are present in the target hardware config or are needed to run and drive firmware logic.

## Status

Early scaffold. The windowed register file (`src/cpu/registers.ts`) is the first piece, since register windowing is the one Xtensa-specific mechanic with no AVR equivalent and everything else in the core loop depends on it.

## Development

```
npm install
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
