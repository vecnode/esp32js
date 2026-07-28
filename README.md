# qemu-esp32

A trimmed QEMU checkout that builds exactly one thing:
`qemu-system-xtensa.exe`, running exactly one machine —
`-machine esp32-picsimlab` — for
[physicalsim](https://github.com/vecnode/physicalsim)'s ESP32 QEMU
adapter (`src/esp32_qemu_adapter.cpp`).

This is not a general-purpose QEMU build. Every guest CPU architecture
except xtensa, every xtensa board except `esp32`, every firmware/BIOS
blob except the ESP32 ROM images, and QEMU's own test suite/docs/UI
translations have all been removed — see the commit history for exactly
what and why. WiFi, ESP-NOW, ESP32-C3, ESP32-S3, and dynamic-library
builds (all present in earlier history this repo was originally forked
from) are gone; physicalsim's adapter never used any of them.

## What this builds

```
./configure --target-list=xtensa-softmmu --disable-werror --disable-docs --disable-tools --disable-fdt --disable-containers
ninja -C build qemu-system-xtensa.exe
```

See `.github/workflows/release.yml` for the exact toolchain (MSYS2
mingw64) and packaging steps used to build and publish the release
`physicalsim`'s own `CMakeLists.txt` (`BUNDLE_QEMU_XTENSA`) downloads.

## Releases

Every push to `main` rebuilds and republishes `qemu-esp32-win64.zip` to
the `qemu-esp32-win64-v1` release tag automatically — physicalsim's
build always resolves to whatever this repo's `main` most recently
produced.
