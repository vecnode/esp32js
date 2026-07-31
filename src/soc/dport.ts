/**
 * ESP32 DPORT - the small slice relevant to a single-core boot sequence:
 * APPCPU control, CPU frequency selection, and cache-enable storage.
 *
 * Register offsets are taken from this repo's own pre-rewrite QEMU source
 * (recoverable from git history at `cae84de99b^`):
 * `include/hw/esp32/esp32_dport.h` for the register map,
 * `hw/esp32/esp32_dport.c`'s `esp32_dport_read`/`_write` for behavior.
 *
 * Real DPORT is large (flash-cache MMU tables, illegal-access traps, a
 * second CPU core's reset/clock/runstall control, flash encryption) - only
 * the part that matters without a second CPU or a real flash cache is
 * implemented here:
 *   - APPCPU_RESET/CLK/RUNSTALL/BOOT_ADDR: plain storage. Real hardware
 *     uses these to hold the second core in reset/stall until firmware
 *     explicitly starts it (`esp_cpu_start` writes BOOT_ADDR then clears
 *     RUNSTALL and RESET) - this project has no second `Cpu` to start, so
 *     these just store whatever firmware writes without acting on it. A
 *     real boot sequence for THIS chip (single core, as modeled) never
 *     needs to touch these at all; they're here so code that
 *     unconditionally pokes them (checking `#core count` first, or just
 *     always initializing both cores) doesn't fail for lack of a backing
 *     register.
 *   - CPU_PER_CONF: plain storage (CPU frequency select) - nothing in this
 *     interpreter paces execution against a clock frequency yet.
 *   - PRO/APP_CACHE_CTRL and CACHE_CTRL1: plain storage only, no MMU table,
 *     no illegal-access trap simulation. `ARCHITECTURE.md` already notes
 *     the CPU itself needs no MMU (ESP32 is identity-mapped); this is a
 *     *different* thing - the flash *cache's* address-translation table -
 *     but is equally out of scope until real flash + an ELF/image loader
 *     exist for it to translate accesses to (Phase 3, still open).
 *
 * Not implemented: the flash-cache MMU table registers themselves (a large
 * range of per-page entries - meaningless without a real cache/flash
 * model), illegal-access-trap registers, `DPORT_SLAVE_SPI_CONFIG`
 * (flash encryption enable) - none of these have anything real to attach
 * to yet.
 */

export const DPORT_REG = {
  APPCPU_RESET: 0x2c,
  APPCPU_CLK: 0x30,
  APPCPU_RUNSTALL: 0x34,
  APPCPU_BOOT_ADDR: 0x38,
  CPU_PER_CONF: 0x3c,
  PRO_CACHE_CTRL: 0x40,
  PRO_CACHE_CTRL1: 0x44,
  APP_CACHE_CTRL: 0x58,
  APP_CACHE_CTRL1: 0x5c,
} as const;

/** Byte size of the register window this peripheral occupies at its base address. */
export const DPORT_WINDOW_SIZE = 0x100;

export class Dport {
  private appcpuReset = 0;
  private appcpuClk = 0;
  private appcpuRunstall = 0;
  private appcpuBootAddr = 0;
  private cpuPerConf = 0;
  private proCacheCtrl = 0;
  private proCacheCtrl1 = 0;
  private appCacheCtrl = 0;
  private appCacheCtrl1 = 0;

  readWord(offset: number): number {
    switch (offset) {
      case DPORT_REG.APPCPU_RESET:
        return this.appcpuReset >>> 0;
      case DPORT_REG.APPCPU_CLK:
        return this.appcpuClk >>> 0;
      case DPORT_REG.APPCPU_RUNSTALL:
        return this.appcpuRunstall >>> 0;
      case DPORT_REG.APPCPU_BOOT_ADDR:
        return this.appcpuBootAddr >>> 0;
      case DPORT_REG.CPU_PER_CONF:
        return this.cpuPerConf >>> 0;
      case DPORT_REG.PRO_CACHE_CTRL:
        return this.proCacheCtrl >>> 0;
      case DPORT_REG.PRO_CACHE_CTRL1:
        return this.proCacheCtrl1 >>> 0;
      case DPORT_REG.APP_CACHE_CTRL:
        return this.appCacheCtrl >>> 0;
      case DPORT_REG.APP_CACHE_CTRL1:
        return this.appCacheCtrl1 >>> 0;
      default:
        return 0;
    }
  }

  writeWord(offset: number, value: number): void {
    switch (offset) {
      case DPORT_REG.APPCPU_RESET:
        this.appcpuReset = value & 1;
        break;
      case DPORT_REG.APPCPU_CLK:
        this.appcpuClk = value & 1;
        break;
      case DPORT_REG.APPCPU_RUNSTALL:
        this.appcpuRunstall = value & 1;
        break;
      case DPORT_REG.APPCPU_BOOT_ADDR:
        this.appcpuBootAddr = value >>> 0;
        break;
      case DPORT_REG.CPU_PER_CONF:
        this.cpuPerConf = value >>> 0;
        break;
      case DPORT_REG.PRO_CACHE_CTRL:
        this.proCacheCtrl = value >>> 0;
        break;
      case DPORT_REG.PRO_CACHE_CTRL1:
        this.proCacheCtrl1 = value >>> 0;
        break;
      case DPORT_REG.APP_CACHE_CTRL:
        this.appCacheCtrl = value >>> 0;
        break;
      case DPORT_REG.APP_CACHE_CTRL1:
        this.appCacheCtrl1 = value >>> 0;
        break;
      default:
        break;
    }
  }
}
