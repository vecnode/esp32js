/**
 * ESP32 interrupt matrix - routes any of the SoC's interrupt sources to any
 * of the CPU's 32 interrupt lines.
 *
 * Register layout and behavior are taken from this repo's own pre-rewrite
 * QEMU source (recoverable from git history at `cae84de99b^`):
 * `include/hw/xtensa/esp32_intc.h` (`ESP32_INT_MATRIX_INPUTS = 69`, one
 * map register per source) and `hw/xtensa/esp32_intc.c`'s
 * `esp32_intmatrix_read`/`_write`/`esp32_intmatrix_irq_handler`. The base
 * address (`ESP32_DPORT_PRO_INTMATRIX_BASE`) is `A_DPORT_PRO_MAC_INTR_MAP`
 * from `include/hw/esp32/esp32_dport.h` - i.e. these registers really do
 * live inside the DPORT peripheral's address window (`PERIPHERAL_BASE.dport
 * + 0x104`), not a separate block, even though `soc/dport.ts` itself
 * doesn't exist yet.
 *
 * Reset default is `6` for every map entry (`memset(irq_map, 6, ...)` in
 * the reference) - not "disabled" in any documented sense, just what the
 * hardware happens to reset to. Writing exactly `6` to a map register is
 * used by firmware as a "disconnect this source" idiom: the reference
 * lowers whatever CPU line the source was previously routed to (without
 * touching the source's own raw/latched level) and then stops redriving
 * anything for it, rather than treating 6 as a distinct sentinel bit.
 * That's replicated exactly here (see `writeWord`).
 *
 * Faithfully NOT improved on: if two sources are mapped to the same CPU
 * line, the reference's handler just calls `qemu_set_irq` per event with
 * no OR-ing - the most recent event on either source wins, not "both must
 * clear for the line to go low". That's what real hardware conceptually
 * does too for wired-OR-style muxing at this layer (only one source can
 * really own the mux "slot" for a given target at a time), so it isn't a
 * bug to route around.
 *
 * Only the 69-entry map register array itself is modeled generically here;
 * this repo only has a small number of real interrupt sources implemented
 * so far (`ETS_UART0_INTR_SOURCE`=34, `ETS_GPIO_INTR_SOURCE`=22,
 * `ETS_TG0_T0/T1/WDT_LEVEL_INTR_SOURCE`=14/15/16, from
 * `include/hw/esp32/esp32_reg.h`), and none of them are wired to actually
 * *drive* a source into this matrix yet - see ARCHITECTURE.md's Phase 4
 * status for why (it needs a per-step "sync peripheral condition into its
 * source line" concept that doesn't exist yet, a separate scope decision
 * from the matrix mechanism itself). `setSourceLevel`/`readWord`/`writeWord`
 * are all real and usable today via direct calls (see intmatrix.test.ts).
 */

import type { Cpu } from '../cpu/cpu.js';

/** ESP32_INT_MATRIX_INPUTS. */
export const INTMATRIX_NUM_SOURCES = 69;

/** Byte size of the register window (one uint32-sized map register per source). */
export const INTMATRIX_WINDOW_SIZE = INTMATRIX_NUM_SOURCES * 4;

/** Reset default for every map entry, and the "disconnect" write value (esp32_intc.c's INTMATRIX_UNINT_VALUE). */
const UNINT_VALUE = 6;

/** Real ESP32 interrupt source indices for the peripherals this repo implements (include/hw/esp32/esp32_reg.h). */
export const INTMATRIX_SOURCE = {
  TG0_T0: 14,
  TG0_T1: 15,
  TG0_WDT: 16,
  GPIO: 22,
  UART0: 34,
} as const;

export class IntMatrix {
  private readonly map = new Array<number>(INTMATRIX_NUM_SOURCES).fill(UNINT_VALUE);
  private readonly raw = new Array<number>(INTMATRIX_NUM_SOURCES).fill(0);
  private cpu: Cpu | undefined;

  /** Wire this matrix's outputs to a CPU. Must be called before any source is driven for that to take effect. */
  attach(cpu: Cpu): void {
    this.cpu = cpu;
  }

  /** esp32_intmatrix_irq_handler: a source's live level changed - drive its currently-mapped CPU line accordingly. */
  setSourceLevel(source: number, level: 0 | 1): void {
    if (source < 0 || source >= INTMATRIX_NUM_SOURCES) return;
    this.raw[source] = level;
    this.cpu?.setInterruptLine(this.map[source]!, level !== 0);
  }

  readWord(offset: number): number {
    const idx = offset >>> 2;
    if (!Number.isInteger(offset / 4) || idx >= INTMATRIX_NUM_SOURCES) return 0;
    return this.map[idx]! >>> 0;
  }

  writeWord(offset: number, value: number): void {
    if (!Number.isInteger(offset / 4)) return;
    const idx = offset >>> 2;
    if (idx >= INTMATRIX_NUM_SOURCES) return;
    const v = value & 0x1f;

    if (v === UNINT_VALUE) {
      if (this.raw[idx]) this.cpu?.setInterruptLine(this.map[idx]!, false);
      this.map[idx] = UNINT_VALUE;
    } else {
      this.map[idx] = v;
      if (this.raw[idx]) this.cpu?.setInterruptLine(v, true);
    }
  }
}
