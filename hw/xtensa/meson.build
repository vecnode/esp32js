# physicalsim: every xtensa board except esp32/esp32-picsimlab has been
# removed outright (sim/virt/xtfpga - generic Xtensa dev boards/emulators,
# never used by physicalsim's own qemu-system-xtensa invocation - and
# esp32s3, a chip physicalsim's adapter never selects; see
# esp32_qemu_adapter.cpp's hardcoded "-machine esp32-picsimlab"), same
# reasoning target/meson.build's own comment gives for the rest of this
# fork's trim. The matching Kconfig entries (hw/xtensa/Kconfig) were
# removed alongside these.
xtensa_ss = ss.source_set()
xtensa_ss.add(files(
  'mx_pic.c',
  'pic_cpu.c',
  'xtensa_memory.c',
))
xtensa_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('esp32.c', 'esp32_intc.c','esp32_picsimlab.c'))

hw_arch += {'xtensa': xtensa_ss}
