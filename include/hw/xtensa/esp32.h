#pragma once

#include "qemu/osdep.h"
#include "hw/hw.h"
#include "target/xtensa/cpu.h"
#include "hw/esp32/esp32_reg.h"
#include "hw/esp32/esp32_uart.h"
#include "hw/esp32/esp32_gpio.h"
#include "hw/esp32/esp32_dport.h"
#include "hw/esp32/esp32_rtc_cntl.h"
#include "hw/esp32/esp32_rng.h"
#include "hw/esp32/esp32_sha.h"
#include "hw/esp32/esp32_aes.h"
#include "hw/esp32/esp32_ledc.h"
#include "hw/esp32/esp32_rsa.h"
#include "hw/esp32/esp32_frc_timer.h"
#include "hw/esp32/esp32_timg.h"
#include "hw/esp32/esp32_crosscore_int.h"
#include "hw/esp32/esp32_spi.h"
#include "hw/esp32/esp32_sens.h"
#include "hw/esp32/esp32_ana.h"
#include "hw/esp32/esp32_rmt.h"
#include "hw/esp32/esp32_wifi.h"
#include "hw/esp32/esp32_fe.h"
#include "hw/esp32/esp32_phya.h"
#include "hw/esp32/esp32_i2c.h"
#include "hw/esp32/esp32_efuse.h"
#include "hw/xtensa/esp32_intc.h"
#include "hw/esp32/esp32_flash_enc.h"
#include "hw/esp32/esp32_twai.h"
#include "hw/sd/dwc_sdmmc.h"
#include "hw/esp32/esp32_iomux.h"
#include "hw/display/esp_rgb.h"

typedef struct Esp32SocState {
    /*< private >*/
    DeviceState parent_obj;

    /*< public >*/
    XtensaCPU cpu[ESP32_CPU_COUNT];
    Esp32DportState dport;
    Esp32IntMatrixState intmatrix;
    Esp32CrosscoreInt crosscore_int;
    Esp32TWAIState twai;
    ESP32UARTState uart[ESP32_UART_COUNT];
    Esp32GpioState gpio;
    Esp32RngState rng;
    Esp32RtcCntlState rtc_cntl;
    Esp32FrcTimerState frc_timer[ESP32_FRC_COUNT];
    Esp32TimgState timg[ESP32_TIMG_COUNT];
    Esp32SpiState spi[ESP32_SPI_COUNT];
    Esp32I2CState i2c[ESP32_I2C_COUNT];
    Esp32ShaState sha;
    Esp32AesState aes;
    Esp32RsaState rsa;
    Esp32LEDCState ledc;
    Esp32EfuseState efuse;
    Esp32SensState sens;
    Esp32AnaState ana;
    Esp32RmtState rmt;
    Esp32WifiState wifi;
    Esp32FeState fe;
    Esp32PhyaState phya;
    Esp32IomuxState iomux;

    Esp32FlashEncryptionState flash_enc;
    ESPRgbState rgb;

    DWCSDMMCState sdmmc;
    DeviceState *eth;
    DeviceState *wifi_dev;

    BusState rtc_bus;
    BusState periph_bus;

    MemoryRegion cpu_specific_mem[ESP32_CPU_COUNT];

    uint32_t requested_reset;
} Esp32SocState;
