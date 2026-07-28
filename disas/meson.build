# physicalsim: every other guest-architecture disassembler has been removed
# outright (see target/meson.build's own comment for why) - only xtensa.c
# is kept, plus the shared/host-agnostic disas-*.c infrastructure below.
common_ss.add(when: 'CONFIG_XTENSA_DIS', if_true: files('xtensa.c'))
common_ss.add(when: capstone, if_true: [files('capstone.c'), capstone])
common_ss.add(when: 'CONFIG_TCG', if_true: files(
    'disas-host.c',
    'disas-target.c',
    'objdump.c'
))
common_ss.add(files('disas-common.c'))
system_ss.add(files('disas-mon.c'))
specific_ss.add(capstone)
