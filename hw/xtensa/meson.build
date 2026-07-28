# physicalsim: every xtensa board except esp32 has been removed outright
# (sim/virt/xtfpga - generic Xtensa dev boards/emulators, never used by
# physicalsim's own qemu-system-xtensa invocation - and esp32s3, a chip
# physicalsim's adapter never selects; see esp32_qemu_adapter.cpp's
# "-machine esp32"), same reasoning target/meson.build's own comment
# gives for the rest of this fork's trim. The matching Kconfig entries
# (hw/xtensa/Kconfig) were removed alongside these.
#
# esp32_picsimlab.c - a second, near-duplicate machine (-machine
# esp32-picsimlab) this fork used to also carry - is gone too: everything
# it added beyond esp32.c's own plain "esp32" machine was audited and
# either ported into esp32.c (the two physicalsim HMP monitor commands,
# a WiFi-MAC-from-efuse improvement, an unimplemented-device stub for the
# bluetooth MMIO region - see esp32.c's own comments at each) or dropped
# as PICSimLab's own in-process callback API, which physicalsim never
# used (it spawns qemu-system-xtensa.exe as a subprocess and only talks
# to it over the GDB RSP connection, never linked in as a library the way
# PICSimLab itself is). One ESP32 machine now, named plainly "esp32".
xtensa_ss = ss.source_set()
xtensa_ss.add(files(
  'mx_pic.c',
  'pic_cpu.c',
  'xtensa_memory.c',
))
xtensa_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('esp32.c', 'esp32_intc.c'))

hw_arch += {'xtensa': xtensa_ss}
