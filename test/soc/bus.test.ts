import { describe, expect, it } from 'vitest';
import { Cpu } from '../../src/cpu/cpu.js';
import { RegisterFile } from '../../src/cpu/registers.js';
import { SystemBus } from '../../src/soc/bus.js';
import { MEMORY_MAP, type MemoryRegionName, PERIPHERAL_BASE } from '../../src/soc/memmap.js';
import { UART_REG } from '../../src/peripherals/uart.js';
import { GPIO_REG } from '../../src/peripherals/gpio.js';
import { TIMG_REG } from '../../src/peripherals/timer.js';
import { INTMATRIX_SOURCE } from '../../src/peripherals/intmatrix.js';
import { RESET_CAUSE, RTC_CNTL_REG } from '../../src/soc/rtc_cntl.js';
import { DPORT_REG } from '../../src/soc/dport.js';

const regionNames = Object.keys(MEMORY_MAP) as MemoryRegionName[];

describe('SystemBus', () => {
  it.each(regionNames)('round-trips a 32-bit value at the base of %s', (name) => {
    const bus = new SystemBus();
    const base = MEMORY_MAP[name].base;
    bus.write32(base, 0xdeadbeef);
    expect(bus.read32(base)).toBe(0xdeadbeef);
  });

  it.each(regionNames)('round-trips a 32-bit value near the end of %s', (name) => {
    const bus = new SystemBus();
    const { base, size } = MEMORY_MAP[name];
    const addr = base + size - 4;
    bus.write32(addr, 0x12345678);
    expect(bus.read32(addr)).toBe(0x12345678);
  });

  it('keeps regions isolated - a write to one does not leak into an adjacent one', () => {
    const bus = new SystemBus();
    bus.write32(MEMORY_MAP.iram.base, 0xffffffff);
    expect(bus.read32(MEMORY_MAP.dram.base)).toBe(0);
    expect(bus.read32(MEMORY_MAP.drom.base)).toBe(0);
  });

  it('reads unmapped addresses as 0 and ignores writes to them, without throwing', () => {
    const bus = new SystemBus();
    const unmapped = 0x12345678; // not inside any MEMORY_MAP region
    expect(regionNames.every((name) => {
      const { base, size } = MEMORY_MAP[name];
      return unmapped < base || unmapped >= base + size;
    })).toBe(true);

    expect(bus.readByte(unmapped)).toBe(0);
    expect(bus.read32(unmapped)).toBe(0);
    expect(() => bus.write32(unmapped, 0xffffffff)).not.toThrow();
    expect(bus.read32(unmapped)).toBe(0);
  });

  it('loadBytes preloads a region, readable via readByte and read32', () => {
    const bus = new SystemBus();
    bus.loadBytes('irom', 0x10, new Uint8Array([0x02, 0x20, 0xa0, 0x02])); // MOVI a2,2 then start of next insn
    expect(bus.readByte(MEMORY_MAP.irom.base + 0x10)).toBe(0x02);
    expect(bus.readByte(MEMORY_MAP.irom.base + 0x12)).toBe(0xa0);
  });

  it('runs a tiny program loaded into IRAM via the real CPU/Bus pairing', () => {
    // Unlike test/cpu/cpu.test.ts's flat TestBus, this exercises the CPU
    // against genuine SoC addresses (IRAM's real base/size from memmap.ts).
    const bus = new SystemBus();
    const base = MEMORY_MAP.iram.base;
    const MOVI = (dest: number, imm: number) => {
      const raw12 = imm & 0xfff;
      const s = (raw12 >> 8) & 0xf;
      const imm8 = raw12 & 0xff;
      return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
    };
    const ADD = (dest: number, s1: number, s2: number) => (0x8 << 20) | (dest << 12) | (s1 << 8) | (s2 << 4);
    const writeInsn = (addr: number, word: number) => {
      // Exactly 3 bytes - instructions are packed 3 bytes apart, so a 4-byte
      // write32 here would clobber the next instruction's first byte.
      bus.writeByte(addr, word & 0xff);
      bus.writeByte(addr + 1, (word >>> 8) & 0xff);
      bus.writeByte(addr + 2, (word >>> 16) & 0xff);
    };

    writeInsn(base, MOVI(2, 5));
    writeInsn(base + 3, MOVI(3, 7));
    writeInsn(base + 6, ADD(4, 2, 3));

    const cpu = new Cpu(new RegisterFile(), bus, base);
    cpu.step();
    cpu.step();
    cpu.step();

    expect(cpu.regs.get(4)).toBe(12);
    expect(cpu.pc).toBe(base + 9);
  });

  describe('UART0 dispatch', () => {
    it('routes a 32-bit write to UART_FIFO to Uart0.onTx exactly once', () => {
      const bus = new SystemBus();
      const bytes: number[] = [];
      bus.uart0.onTx = (b) => bytes.push(b);

      bus.write32(PERIPHERAL_BASE.uart0 + UART_REG.FIFO, 0x48);
      expect(bytes).toEqual([0x48]);
    });

    it('routes a 32-bit read from UART_DATE to the fixed reference value', () => {
      const bus = new SystemBus();
      expect(bus.read32(PERIPHERAL_BASE.uart0 + UART_REG.DATE)).toBe(0x15122500);
    });

    it('round-trips a plain storage register (CONF0) through read32/write32', () => {
      const bus = new SystemBus();
      bus.write32(PERIPHERAL_BASE.uart0 + UART_REG.CONF0, 0xabcdef01);
      expect(bus.read32(PERIPHERAL_BASE.uart0 + UART_REG.CONF0)).toBe(0xabcdef01);
    });

    it('does not leak into the surrounding memory map (peripherals are unmapped there)', () => {
      const bus = new SystemBus();
      bus.write32(PERIPHERAL_BASE.uart0 + UART_REG.CONF0, 0xffffffff);
      // UART0's base address itself must not have been misrouted to a MEMORY_MAP region.
      expect(regionNames.some((name) => {
        const { base, size } = MEMORY_MAP[name];
        return PERIPHERAL_BASE.uart0 >= base && PERIPHERAL_BASE.uart0 < base + size;
      })).toBe(false);
    });

    it('runs a real S32I instruction that writes a string to UART_FIFO byte by byte', () => {
      // The classic first-peripheral smoke test: firmware "prints" by storing
      // each character to UART_FIFO. Loads/executes from IRAM (real base
      // address), writes to UART0 (real peripheral base address) - the two
      // halves of the SoC map working together through one Bus.
      const bus = new SystemBus();
      const output: number[] = [];
      bus.uart0.onTx = (b) => output.push(b);

      const base = MEMORY_MAP.iram.base;
      const MOVI = (dest: number, imm: number) => {
        const raw12 = imm & 0xfff;
        const s = (raw12 >> 8) & 0xf;
        const imm8 = raw12 & 0xff;
        return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
      };
      const S32I = (src: number, base_: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x6 << 12) | (base_ << 8) | (src << 4) | 0x2;
      const writeInsn = (addr: number, word: number) => {
        bus.writeByte(addr, word & 0xff);
        bus.writeByte(addr + 1, (word >>> 8) & 0xff);
        bus.writeByte(addr + 2, (word >>> 16) & 0xff);
      };

      // a1 = UART0's FIFO register address (0x3ff40000 - far outside MOVI's
      // 12-bit range, so it's set directly rather than via an instruction);
      // a2/a3 = 'h'/'i'; S32I a2/a3 -> [a1+0].
      const uartFifoAddr = PERIPHERAL_BASE.uart0 + UART_REG.FIFO;
      const cpu = new Cpu(new RegisterFile(), bus, base);
      cpu.regs.set(1, uartFifoAddr);
      writeInsn(base, MOVI(2, 'h'.charCodeAt(0)));
      writeInsn(base + 3, S32I(2, 1, 0));
      writeInsn(base + 6, MOVI(3, 'i'.charCodeAt(0)));
      writeInsn(base + 9, S32I(3, 1, 0));

      cpu.step(); // MOVI a2, 'h'
      cpu.step(); // S32I -> UART_FIFO
      cpu.step(); // MOVI a3, 'i'
      cpu.step(); // S32I -> UART_FIFO

      expect(output).toEqual([0x68, 0x69]); // "hi"
    });
  });

  describe('GPIO dispatch', () => {
    it('routes a 32-bit write/read to GPIO_OUT to the Gpio peripheral', () => {
      const bus = new SystemBus();
      bus.write32(PERIPHERAL_BASE.gpio + GPIO_REG.OUT, 0xdeadbeef);
      expect(bus.read32(PERIPHERAL_BASE.gpio + GPIO_REG.OUT)).toBe(0xdeadbeef >>> 0);
    });

    it('does not collide with UART0 - the two peripherals stay isolated', () => {
      const bus = new SystemBus();
      bus.write32(PERIPHERAL_BASE.gpio + GPIO_REG.OUT, 0xffffffff);
      expect(bus.read32(PERIPHERAL_BASE.uart0 + UART_REG.CONF0)).toBe(0);
    });

    it('runs a real "blink" program: S32I toggles a GPIO pin observed via bus.gpio.getPin', () => {
      const bus = new SystemBus();
      const base = MEMORY_MAP.iram.base;
      const MOVI = (dest: number, imm: number) => {
        const raw12 = imm & 0xfff;
        const s = (raw12 >> 8) & 0xf;
        const imm8 = raw12 & 0xff;
        return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
      };
      const S32I = (src: number, base_: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x6 << 12) | (base_ << 8) | (src << 4) | 0x2;
      const writeInsn = (addr: number, word: number) => {
        bus.writeByte(addr, word & 0xff);
        bus.writeByte(addr + 1, (word >>> 8) & 0xff);
        bus.writeByte(addr + 2, (word >>> 16) & 0xff);
      };

      const gpioEnableW1tsAddr = PERIPHERAL_BASE.gpio + GPIO_REG.ENABLE_W1TS;
      const gpioOutW1tsAddr = PERIPHERAL_BASE.gpio + GPIO_REG.OUT_W1TS;
      const gpioOutW1tcAddr = PERIPHERAL_BASE.gpio + GPIO_REG.OUT_W1TC;
      const cpu = new Cpu(new RegisterFile(), bus, base);
      // Addresses are far outside MOVI's 12-bit range, so set them directly.
      cpu.regs.set(1, gpioEnableW1tsAddr);
      cpu.regs.set(2, gpioOutW1tsAddr);
      cpu.regs.set(3, gpioOutW1tcAddr);
      cpu.regs.set(4, 1 << 2); // pin 2 (a common onboard-LED pin)

      writeInsn(base, S32I(4, 1, 0)); // enable pin 2 as output
      writeInsn(base + 3, S32I(4, 2, 0)); // drive it high
      writeInsn(base + 6, S32I(4, 3, 0)); // drive it low

      cpu.step(); // enable
      cpu.step(); // set high
      expect(bus.gpio.getPin(2)).toBe(1);

      cpu.step(); // set low
      expect(bus.gpio.getPin(2)).toBe(0);
    });
  });

  describe('TIMG0 dispatch', () => {
    it('routes a 32-bit write/read to T0CONFIG to the Timg peripheral', () => {
      const bus = new SystemBus();
      bus.write32(PERIPHERAL_BASE.timg0 + TIMG_REG.T0CONFIG, 0x12345678);
      expect(bus.read32(PERIPHERAL_BASE.timg0 + TIMG_REG.T0CONFIG)).toBe(0x12345678);
    });

    it('reads WDTPROTECT as the reset default magic word through the bus', () => {
      const bus = new SystemBus();
      expect(bus.read32(PERIPHERAL_BASE.timg0 + TIMG_REG.WDTPROTECT)).toBe(0x50d83aa1);
    });

    it('runs a real "disable the watchdog" boot idiom via S32I through the bus', () => {
      const bus = new SystemBus();
      const base = MEMORY_MAP.iram.base;
      const MOVI = (dest: number, imm: number) => {
        const raw12 = imm & 0xfff;
        const s = (raw12 >> 8) & 0xf;
        const imm8 = raw12 & 0xff;
        return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
      };
      const S32I = (src: number, base_: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x6 << 12) | (base_ << 8) | (src << 4) | 0x2;
      const writeInsn = (addr: number, word: number) => {
        bus.writeByte(addr, word & 0xff);
        bus.writeByte(addr + 1, (word >>> 8) & 0xff);
        bus.writeByte(addr + 2, (word >>> 16) & 0xff);
      };

      const protectAddr = PERIPHERAL_BASE.timg0 + TIMG_REG.WDTPROTECT;
      const config0Addr = PERIPHERAL_BASE.timg0 + TIMG_REG.WDTCONFIG0;
      const cpu = new Cpu(new RegisterFile(), bus, base);
      cpu.regs.set(1, protectAddr); // addresses far outside MOVI's 12-bit range
      cpu.regs.set(2, config0Addr);
      cpu.regs.set(3, 0x50d83aa1); // unlock word
      cpu.regs.set(4, 0); // WDTCONFIG0 = 0 -> EN bit cleared

      writeInsn(base, S32I(3, 1, 0)); // unlock
      writeInsn(base + 3, S32I(4, 2, 0)); // disable
      writeInsn(base + 6, MOVI(5, 0)); // re-lock with a non-magic value
      writeInsn(base + 9, S32I(5, 1, 0));

      cpu.step();
      cpu.step();
      cpu.step();
      cpu.step();

      expect(bus.timg0.readWord(TIMG_REG.WDTCONFIG0)).toBe(0);
      expect(bus.timg0.readWord(TIMG_REG.WDTPROTECT)).toBe(0);
    });
  });

  describe('interrupt matrix dispatch', () => {
    const intmatrixBase = PERIPHERAL_BASE.dport + 0x104; // A_DPORT_PRO_MAC_INTR_MAP

    it('routes a 32-bit write/read to the UART0 source map register', () => {
      const bus = new SystemBus();
      const addr = intmatrixBase + INTMATRIX_SOURCE.UART0 * 4;
      bus.write32(addr, 5);
      expect(bus.read32(addr)).toBe(5);
    });

    it('resets every source to 6, matching esp32_intmatrix_reset_hold', () => {
      const bus = new SystemBus();
      expect(bus.read32(intmatrixBase)).toBe(6);
    });

    it('drives a real interrupt end to end: GPIO -> intmatrix -> Cpu, once attached', () => {
      const bus = new SystemBus();
      const cpu = new Cpu(new RegisterFile(), bus, MEMORY_MAP.iram.base);
      bus.intmatrix.attach(cpu);

      cpu.intenable = 1 << 3; // route GPIO's source to CPU line 3 (level 1)
      bus.write32(intmatrixBase + INTMATRIX_SOURCE.GPIO * 4, 3);
      bus.intmatrix.setSourceLevel(INTMATRIX_SOURCE.GPIO, 1);

      cpu.step();
      expect(cpu.lastException).toEqual({ kind: 'interrupt', level: 1 });
    });
  });

  describe('RTC_CNTL / DPORT dispatch', () => {
    it('routes a 32-bit write/read to RTC_CNTL_STORE0', () => {
      const bus = new SystemBus();
      const addr = PERIPHERAL_BASE.rtcCntl + RTC_CNTL_REG.STORE0;
      bus.write32(addr, 0xcafef00d);
      expect(bus.read32(addr)).toBe(0xcafef00d >>> 0);
    });

    it('routes a 32-bit write/read to DPORT_APPCPU_BOOT_ADDR', () => {
      const bus = new SystemBus();
      const addr = PERIPHERAL_BASE.dport + DPORT_REG.APPCPU_BOOT_ADDR;
      bus.write32(addr, MEMORY_MAP.iram.base);
      expect(bus.read32(addr)).toBe(MEMORY_MAP.iram.base);
    });

    it("DPORT's own registers and the interrupt matrix coexist in DPORT's window without colliding", () => {
      const bus = new SystemBus();
      bus.write32(PERIPHERAL_BASE.dport + DPORT_REG.CPU_PER_CONF, 0xffffffff);
      const intmatrixAddr = PERIPHERAL_BASE.dport + 0x104 + INTMATRIX_SOURCE.UART0 * 4;
      expect(bus.read32(intmatrixAddr)).toBe(6); // intmatrix's own reset default, untouched
    });

    it('runs a real boot idiom: read RESET_STATE, then trigger a software reset via S32I', () => {
      const bus = new SystemBus();
      const base = MEMORY_MAP.iram.base;
      const MOVI = (dest: number, imm: number) => {
        const raw12 = imm & 0xfff;
        const s = (raw12 >> 8) & 0xf;
        const imm8 = raw12 & 0xff;
        return (imm8 << 16) | (0xa << 12) | (s << 8) | (dest << 4) | 0x2;
      };
      const L32I = (dest: number, base_: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x2 << 12) | (base_ << 8) | (dest << 4) | 0x2;
      const S32I = (src: number, base_: number, byteOffset: number) => (((byteOffset >> 2) & 0xff) << 16) | (0x6 << 12) | (base_ << 8) | (src << 4) | 0x2;
      const writeInsn = (addr: number, word: number) => {
        bus.writeByte(addr, word & 0xff);
        bus.writeByte(addr + 1, (word >>> 8) & 0xff);
        bus.writeByte(addr + 2, (word >>> 16) & 0xff);
      };

      let resetFired: string | undefined;
      bus.rtcCntl.onReset = (cause) => (resetFired = cause);

      const resetStateAddr = PERIPHERAL_BASE.rtcCntl + RTC_CNTL_REG.RESET_STATE;
      const options0Addr = PERIPHERAL_BASE.rtcCntl + RTC_CNTL_REG.OPTIONS0;
      const cpu = new Cpu(new RegisterFile(), bus, base);
      cpu.regs.set(1, resetStateAddr); // far outside MOVI's 12-bit range
      cpu.regs.set(2, options0Addr);
      cpu.regs.set(4, 1 << 5); // SW_PROCPU_RESET

      writeInsn(base, L32I(3, 1, 0)); // a3 = RESET_STATE (esp_reset_reason() idiom)
      writeInsn(base + 3, S32I(4, 2, 0)); // trigger a software PROCPU reset

      cpu.step();
      expect(cpu.regs.get(3) & 0x3f).toBe(RESET_CAUSE.POWERON_RESET); // reads real POWERON cause first

      cpu.step();
      expect(resetFired).toBe('procpu');
      expect(bus.rtcCntl.readWord(RTC_CNTL_REG.RESET_STATE) & 0x3f).toBe(RESET_CAUSE.SW_CPU_RESET);
    });
  });
});
