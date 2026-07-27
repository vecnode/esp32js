roms = []
# physicalsim: every edk2-*.fd.bz2 UEFI firmware blob (aarch64/arm/riscv/
# i386/x86_64/loongarch64 - none of it relevant to an xtensa/ESP32 target)
# has been removed outright, same "this fork only ships qemu-system-xtensa"
# reasoning target/meson.build's own comment gives - fds left empty rather
# than deleting this whole block so unpack_edk2_blobs staying true (an
# upstream default, not something physicalsim's build flips) still no-ops
# cleanly instead of failing on missing files.
if unpack_edk2_blobs
  fds = []

  foreach f : fds
    roms += custom_target(f,
                  build_by_default: have_system,
                  output: f,
                  input: files('@0@.bz2'.format(f)),
                  capture: true,
                  install: get_option('install_blobs'),
                  install_dir: qemu_datadir,
                  command: [ bzip2, '-dc', '@INPUT0@' ])
  endforeach
endif

# physicalsim: trimmed to the four blobs the esp32/esp32c3/esp32s3 machine
# models this fork actually emulates need (esp32_qemu_adapter.cpp's own
# QEMU_XTENSA_PCBIOS_DIR is exactly this directory) - every other machine's
# BIOS/VGA-BIOS/option-ROM/firmware blob upstream QEMU ships here (PC BIOS,
# OpenBIOS, PXE/EFI network ROMs, s390 CCW, SLOF, U-Boot, HPPA/OpenSBI/npcm7xx
# firmware, edk2 licenses, ...) has been removed outright, same reasoning as
# target/meson.build's own comment.
blobs = [
  'esp32-v3-rom.bin',
  'esp32-v3-rom-app.bin',
  'esp32c3-rom.bin',
  'esp32s3_rev0_rom.bin',
]

dtc = find_program('dtc', required: false)
foreach f : [
  'bamboo.dts',
  'canyonlands.dts',
  'petalogix-s3adsp1800.dts',
  'petalogix-ml605.dts',
]
  out = fs.replace_suffix(f, '.dtb')
  if dtc.found()
    custom_target(f,
        build_by_default: have_system,
        input: files(f),
        output: out,
        install: get_option('install_blobs'),
        install_dir: qemu_datadir,
        command: [ dtc, '-I', 'dts', '-O', 'dtb', '-o', '@OUTPUT@', '@INPUT0@' ])
  else
    blobs += out
  endif
endforeach

if get_option('install_blobs')
  install_data(blobs, install_dir: qemu_datadir)
endif

subdir('descriptors')
subdir('keymaps')
