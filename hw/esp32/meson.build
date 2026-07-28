# physicalsim: every ESP32 peripheral device model this fork actually
# needs, in one place - these files used to be scattered across nine
# different hw/ subsystem directories (char, gpio, i2c, misc, net/can,
# nvram, ssi, timer), grouped there only by generic device *category*
# (uart/gpio/i2c/timer/...), not by which chip they belong to. Since
# esp32 is the only machine this fork emulates, "which category of
# device" is a less useful grouping than "is this part of the ESP32" -
# this directory is that grouping. hw/xtensa/ keeps the xtensa-generic
# CPU/interrupt-controller/memory files (mx_pic.c, pic_cpu.c,
# xtensa_memory.c) and the machine/SoC top files (esp32.c, esp32_intc.c)
# - those aren't peripheral *devices*, they're the CPU and board itself,
# and QEMU convention keeps a board's own top-level file in its own arch
# directory.
system_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files(
  'esp32_uart.c',
  'esp32_gpio.c',
  'esp32_twai.c',
  'esp32_efuse.c',
  'esp32_spi.c',
  'esp32_rmt.c',
  'esp32_frc_timer.c',
  'esp32_timg.c',
  'esp32_crosscore_int.c',
  'esp32_dport.c',
  'esp32_rng.c',
  'esp32_rsa.c',
  'esp32_rtc_cntl.c',
  'esp32_sha.c',
  'esp32_aes.c',
  'esp32_ledc.c',
  'esp32_flash_enc.c',
  'ssi_psram.c',
  'esp32_sens.c',
  'esp32_ana.c',
  'esp32_wifi.c',
  'esp32_fe.c',
  'esp32_phya.c',
  'esp32_wifi_ap.c',
  'esp32_wlan_packet.c',
  'esp32_iomux.c',
))

# esp32_i2c.c is an I2C bus controller, not a generic system device -
# i2c_ss (declared in hw/i2c/meson.build, processed before this
# directory) is the source set every other I2C controller in the tree
# adds itself to, and esp32_i2c.c following that same convention is what
# lets other I2C-bus device models (hw/i2c/*) actually attach to it.
i2c_ss.add(when: 'CONFIG_XTENSA_ESP32', if_true: files('esp32_i2c.c'))

# esp32_rsa.c is deliberately added twice under two different conditions
# (unconditionally above, and gcrypt-gated here) - preserved exactly as
# it was before this directory existed, not something introduced by this
# move. Not investigated further; changing it is a behavior change this
# reorganization isn't meant to make.
if gcrypt.found()
  system_ss.add(when: [gcrypt, 'CONFIG_XTENSA_ESP32'], if_true: files(
    'esp32_rsa.c',
  ))
endif
