system_ss.add(when: 'CONFIG_RC4030', if_true: files('rc4030.c'))
system_ss.add(when: 'CONFIG_PL080', if_true: files('pl080.c'))
system_ss.add(when: 'CONFIG_PL330', if_true: files('pl330.c'))
system_ss.add(when: 'CONFIG_I82374', if_true: files('i82374.c'))
system_ss.add(when: 'CONFIG_I8257', if_true: files('i8257.c'))
system_ss.add(when: 'CONFIG_XILINX_AXI', if_true: files('xilinx_axidma.c'))
system_ss.add(when: 'CONFIG_ZYNQ_DEVCFG', if_true: files('xlnx-zynq-devcfg.c'))
system_ss.add(when: 'CONFIG_STP2000', if_true: files('sparc32_dma.c'))
system_ss.add(when: 'CONFIG_XLNX_ZYNQMP_ARM', if_true: files('xlnx_dpdma.c'))
system_ss.add(when: 'CONFIG_XLNX_ZDMA', if_true: files('xlnx-zdma.c'))
system_ss.add(when: 'CONFIG_OMAP', if_true: files('omap_dma.c', 'soc_dma.c'))
system_ss.add(when: 'CONFIG_RASPI', if_true: files('bcm2835_dma.c'))
system_ss.add(when: 'CONFIG_SIFIVE_PDMA', if_true: files('sifive_pdma.c'))
system_ss.add(when: 'CONFIG_XLNX_CSU_DMA', if_true: files('xlnx_csu_dma.c'))
# physicalsim: GDMA (esp_gdma.c/esp32c3_gdma.c/esp32s3_gdma.c) is not
# used by the ESP32 (v3) chip esp32-picsimlab emulates at all - a newer
# peripheral introduced in the S2/S3/C3 chips, neither of which this fork
# still carries (see hw/xtensa/meson.build's own comment).
