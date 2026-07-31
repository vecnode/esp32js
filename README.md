# esp32js

An ESP32 (Xtensa LX6) CPU and peripheral interpreter written in TypeScript, for running in the browser or Node for ESP32.

## Scope

esp32js emulates the ESP32 (Xtensa LX6) CPU core and its GPIO, IO_MUX, TIMG, UART, SAR ADC, and interrupt matrix peripherals. It loads and runs compiled `.elf` firmware directly in Node or the browser. Not supported: WiFi/Bluetooth, cache/MMU, crypto accelerators, and DSP extensions.

## Development

```
npm install
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
