i2c_ss = ss.source_set()
i2c_ss.add(when: 'CONFIG_I2C', if_true: files('core.c'))
i2c_ss.add(when: 'CONFIG_SMBUS', if_true: files('smbus_slave.c', 'smbus_master.c'))
i2c_ss.add(when: 'CONFIG_ACPI_SMBUS', if_true: files('pm_smbus.c'))
i2c_ss.add(when: 'CONFIG_ACPI_ICH9', if_true: files('smbus_ich9.c'))
i2c_ss.add(when: 'CONFIG_ASPEED_SOC', if_true: files('aspeed_i2c.c'))
i2c_ss.add(when: 'CONFIG_BITBANG_I2C', if_true: files('bitbang_i2c.c'))
i2c_ss.add(when: 'CONFIG_EXYNOS4', if_true: files('exynos4210_i2c.c'))
i2c_ss.add(when: 'CONFIG_IMX_I2C', if_true: files('imx_i2c.c'))
i2c_ss.add(when: 'CONFIG_MPC_I2C', if_true: files('mpc_i2c.c'))
i2c_ss.add(when: 'CONFIG_ALLWINNER_I2C', if_true: files('allwinner-i2c.c'))
i2c_ss.add(when: 'CONFIG_NRF51_SOC', if_true: files('microbit_i2c.c'))
i2c_ss.add(when: 'CONFIG_NPCM7XX', if_true: files('npcm7xx_smbus.c'))
i2c_ss.add(when: 'CONFIG_SMBUS_EEPROM', if_true: files('smbus_eeprom.c'))
i2c_ss.add(when: 'CONFIG_ARM_SBCON_I2C', if_true: files('arm_sbcon_i2c.c'))
i2c_ss.add(when: 'CONFIG_OMAP', if_true: files('omap_i2c.c'))
i2c_ss.add(when: 'CONFIG_PPC4XX', if_true: files('ppc4xx_i2c.c'))
# physicalsim: esp32_i2c.c moved to hw/esp32/meson.build (still added to
# this file's own i2c_ss - a global variable, safe to reference from
# there since hw/meson.build processes this subdir first).
i2c_ss.add(when: 'CONFIG_PCA954X', if_true: files('i2c_mux_pca954x.c'))
i2c_ss.add(when: 'CONFIG_PMBUS', if_true: files('pmbus_device.c'))
i2c_ss.add(when: 'CONFIG_BCM2835_I2C', if_true: files('bcm2835_i2c.c'))
# physicalsim: picsimlab_i2c.c removed - it only ever existed to relay
# I2C bus events to PICSimLab's own in-process callback API (see
# hw/xtensa/esp32.c's comment on why that whole mechanism is gone).
system_ss.add_all(when: 'CONFIG_I2C', if_true: i2c_ss)
