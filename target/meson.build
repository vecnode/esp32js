# physicalsim: trimmed to the one target this fork's downstream consumer
# (physicalsim's esp32_qemu_adapter.cpp) actually builds and ships -
# qemu-system-xtensa. Every other target/<arch> directory upstream QEMU
# ships (alpha/arm/avr/hexagon/hppa/i386/loongarch/m68k/microblaze/mips/
# openrisc/ppc/riscv/rx/s390x/sh4/sparc/tricore) has been removed outright
# rather than just left unconfigured - this fork only exists to publish one
# prebuilt qemu-system-xtensa.exe release, not to be a general-purpose QEMU
# checkout, so there is no reason to keep multi-hundred-MB of unrelated
# CPU-architecture source around. If this fork is ever repointed at
# upstream QEMU/espressif's qemu for a merge/rebase, this trim needs to be
# reapplied on top - it is not something upstream will preserve for you.
subdir('xtensa')
