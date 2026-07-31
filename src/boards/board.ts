/**
 * A runnable board: a `Cpu`+`SystemBus` pair constructed and wired together
 * for a given `BoardDefinition`, plus firmware loading and the
 * pin/serial/ADC passthroughs an embedder (physicalsim, a test, a REPL)
 * actually wants to drive - not itself ported from the QEMU fork (nothing
 * in `hw/esp32/esp32_picsimlab.c` corresponds 1:1 to this class; it's the
 * "board" half of this project's own two-layer split - see this repo's
 * top-level ARCHITECTURE.md).
 *
 * Every other piece of this project (`Cpu`, `SystemBus`, `loadElf`, the
 * `BoardDefinition`s in `boards/*.ts`) already existed; `Board` is just the
 * one place that constructs them together and performs the wiring steps
 * `SystemBus`'s own doc comment says an embedder must do itself
 * (`bus.intmatrix.attach(cpu)`) plus the one a driving loop must do every
 * step (`cpu.step(); bus.tick(cpu.lastStepCycles)`, see `cpu/cpu.ts`'s
 * `CYCLE_COST` and `soc/bus.ts`'s `tick` doc comments) - so callers don't
 * have to know that sequencing exists.
 *
 * One `Board` class serves all boards (`new Board(ESP32_DEVKIT_V1)`,
 * `new Board(ESP32_DEVKIT_C_V4)`, `new Board(ESP32_CAM)`) rather than a
 * subclass per board, since every `BoardDefinition` this project has today
 * differs only in pin metadata, not emulated behavior - the SoC model
 * underneath (`SystemBus`) is identical for all three real boards, matching
 * this project's own "one SoC model, thin board data" design.
 *
 * `setPin`/`getPin` pass straight through to `bus.gpio`, but check the
 * board's own pin list first: driving a `flash-spi`/`boot-strap`/`camera`/
 * `sd-card` pin still works (this class doesn't block it - a test might
 * deliberately want to), but reports it via `onReservedPinWarning`, since
 * doing so on real hardware would either not be wired to anything usable
 * or actively interfere with boot. This is a callback rather than a direct
 * `console.warn` for the same reason every other side effect in this
 * project is (`Uart0.onTx`, `RtcCntl.onReset`, ...): a plain global
 * `console` isn't part of the ES2020 lib this project targets to stay
 * usable in both the browser and Node without pulling in DOM types.
 * `setAdcChannel`/`getAdcChannel` and `onSerialOut`/`serialIn` are thin
 * passthroughs to `bus.adc` and `bus.uart0` for the same reason: an
 * embedder driving a `Board` shouldn't need to reach past it into `bus.*`
 * for the common cases.
 *
 * Not implemented: nothing camera- or microSD-specific for ESP32-CAM - its
 * `BoardDefinition` marks those GPIOs with `role: 'camera'`/`'sd-card'`
 * metadata only. Real image capture was already out of scope before this
 * class existed (this fork's own QEMU stubs I2S the same way real hardware
 * boot expects, without functionally emulating the camera - see
 * ARCHITECTURE.md's "What's real silicon vs. what QEMU itself stubs out"),
 * so `Board` doesn't invent anything new here.
 */

import { Cpu } from '../cpu/cpu.js';
import { RegisterFile } from '../cpu/registers.js';
import { loadElf } from '../loader/elf.js';
import { SystemBus } from '../soc/bus.js';
import type { BoardDefinition, PinRole } from './types.js';

/** Pin roles where driving the pin from outside the chip doesn't reflect anything a real board's wiring would do. */
const RESERVED_PIN_ROLES: ReadonlySet<PinRole> = new Set(['flash-spi', 'boot-strap', 'camera', 'sd-card']);

export class Board {
  readonly definition: BoardDefinition;
  readonly bus: SystemBus;
  readonly cpu: Cpu;

  private readonly pinRoles = new Map<number, PinRole>();

  /** Fires with each byte UART0 transmits - see `peripherals/uart.ts`'s `Uart0.onTx`. */
  onSerialOut?: (byte: number) => void;
  /** Fires when `setPin` drives a pin this board reserves (flash/strap/camera/SD) - see class doc comment. */
  onReservedPinWarning?: (pin: number, role: PinRole) => void;

  constructor(definition: BoardDefinition) {
    this.definition = definition;
    this.bus = new SystemBus();
    this.cpu = new Cpu(new RegisterFile(), this.bus);
    this.bus.intmatrix.attach(this.cpu);
    this.bus.uart0.onTx = (byte) => this.onSerialOut?.(byte);
    for (const pin of definition.pins) this.pinRoles.set(pin.gpio, pin.role);
  }

  /** Loads a compiled ESP32 `.elf` (`loadElf`) and starts execution at its entry point. */
  loadFirmware(elf: Uint8Array): void {
    const image = loadElf(this.bus, elf);
    this.cpu.pc = image.entry >>> 0;
  }

  /** Executes one instruction, then advances every clock-driven peripheral by that instruction's cycle cost. */
  step(): void {
    this.cpu.step();
    this.bus.tick(this.cpu.lastStepCycles);
  }

  /** Convenience: `step()` `count` times. */
  run(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  /** Drive GPIO `pin` (0-39) from outside the chip - see class doc comment for the reserved-pin warning. */
  setPin(pin: number, value: 0 | 1): void {
    const role = this.pinRoles.get(pin);
    if (role !== undefined && RESERVED_PIN_ROLES.has(role)) {
      this.onReservedPinWarning?.(pin, role);
    }
    this.bus.gpio.setPin(pin, value);
  }

  /** Read GPIO `pin`'s current level (0-39). */
  getPin(pin: number): 0 | 1 {
    return this.bus.gpio.getPin(pin);
  }

  /** Feed an externally-received byte into UART0's RX FIFO - see `Uart0.pushRx`. */
  serialIn(byte: number): void {
    this.bus.uart0.pushRx(byte);
  }

  /** Inject a simulated ADC reading - see `Adc.setChannelValue`. */
  setAdcChannel(channel: number, value: number): void {
    this.bus.adc.setChannelValue(channel, value);
  }

  /** Read back an injected ADC reading - see `Adc.getChannelValue`. */
  getAdcChannel(channel: number): number {
    return this.bus.adc.getChannelValue(channel);
  }
}
