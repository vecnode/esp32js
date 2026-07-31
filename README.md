# esp32js

An ESP32 (Xtensa LX6) CPU and peripheral interpreter written in TypeScript, for running in the browser or Node for ESP32.

## Scope

A TypeScript/Node interpreter for the ESP32 (Xtensa LX6). It loads a real compiled `.elf` and runs it against a simulated Xtensa core (ALU, windowed calls, XEA2 interrupts/NMI, single-precision FPU) plus GPIO, IO_MUX, TIMG, UART, SAR ADC, and the interrupt matrix — no WiFi/Bluetooth, cache/MMU, crypto accelerators, or DSP extensions.

## Development

```
npm install
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE).
