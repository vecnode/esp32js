import { describe, expect, it } from 'vitest';
import { RESET_CAUSE, RtcCntl, RTC_CNTL_REG } from '../../src/soc/rtc_cntl.js';

describe('RtcCntl', () => {
  it('resets with RESET_CAUSE=POWERON_RESET for both cores, readable via RESET_STATE', () => {
    const rtc = new RtcCntl();
    const state = rtc.readWord(RTC_CNTL_REG.RESET_STATE);
    expect(state & 0x3f).toBe(RESET_CAUSE.POWERON_RESET); // PROCPU
    expect((state >>> 6) & 0x3f).toBe(RESET_CAUSE.POWERON_RESET); // APPCPU
  });

  it('TIME_UPDATE always reads back VALID, and writing it is a no-op', () => {
    const rtc = new RtcCntl();
    expect(rtc.readWord(RTC_CNTL_REG.TIME_UPDATE)).toBe(1 << 30);
    rtc.writeWord(RTC_CNTL_REG.TIME_UPDATE, 1 << 31);
    expect(rtc.readWord(RTC_CNTL_REG.TIME_UPDATE)).toBe(1 << 30);
  });

  it('TIME0/TIME1 are static (no free-running clock)', () => {
    const rtc = new RtcCntl();
    expect(rtc.readWord(RTC_CNTL_REG.TIME0)).toBe(0);
    expect(rtc.readWord(RTC_CNTL_REG.TIME1)).toBe(0);
  });

  it('STORE0-7 round-trip as plain scratch registers', () => {
    const rtc = new RtcCntl();
    rtc.writeWord(RTC_CNTL_REG.STORE0, 0x11111111);
    rtc.writeWord(RTC_CNTL_REG.STORE3, 0x44444444);
    rtc.writeWord(RTC_CNTL_REG.STORE4, 0x55555555);
    rtc.writeWord(RTC_CNTL_REG.STORE7, 0x88888888);

    expect(rtc.readWord(RTC_CNTL_REG.STORE0)).toBe(0x11111111);
    expect(rtc.readWord(RTC_CNTL_REG.STORE3)).toBe(0x44444444);
    expect(rtc.readWord(RTC_CNTL_REG.STORE4)).toBe(0x55555555 >>> 0);
    expect(rtc.readWord(RTC_CNTL_REG.STORE7)).toBe(0x88888888 >>> 0);
  });

  it('CLK_CONF round-trips its three clock-select fields', () => {
    const rtc = new RtcCntl();
    // ANA_CLK_RTC_SEL(slowclk)=2 @30, FAST_CLK_RTC_SEL=1 @29, SOC_CLK_SEL=3 @27
    const value = (2 << 30) | (1 << 29) | (3 << 27);
    rtc.writeWord(RTC_CNTL_REG.CLK_CONF, value);
    expect(rtc.readWord(RTC_CNTL_REG.CLK_CONF)).toBe(value >>> 0);
  });

  it('SW_CPU_STALL round-trips as a plain register', () => {
    const rtc = new RtcCntl();
    rtc.writeWord(RTC_CNTL_REG.SW_CPU_STALL, 0x12345678);
    expect(rtc.readWord(RTC_CNTL_REG.SW_CPU_STALL)).toBe(0x12345678);
  });

  it('RTC_CNTL_DATE reads as 0 (unhandled in the reference too)', () => {
    const rtc = new RtcCntl();
    expect(rtc.readWord(RTC_CNTL_REG.DATE)).toBe(0);
  });

  it('OPTIONS0 SW_PROCPU_RESET self-clears, updates reset cause, and fires onReset', () => {
    const rtc = new RtcCntl();
    let firedWith: string | undefined;
    rtc.onReset = (cause) => (firedWith = cause);

    rtc.writeWord(RTC_CNTL_REG.OPTIONS0, 1 << 5); // SW_PROCPU_RESET
    expect(firedWith).toBe('procpu');
    expect(rtc.readWord(RTC_CNTL_REG.OPTIONS0) & (1 << 5)).toBe(0); // self-cleared
    expect(rtc.readWord(RTC_CNTL_REG.RESET_STATE) & 0x3f).toBe(RESET_CAUSE.SW_CPU_RESET);
  });

  it('OPTIONS0 SW_SYS_RESET updates both cores reset cause and fires onReset("sys")', () => {
    const rtc = new RtcCntl();
    let firedWith: string | undefined;
    rtc.onReset = (cause) => (firedWith = cause);

    rtc.writeWord(RTC_CNTL_REG.OPTIONS0, 1 << 31); // SW_SYS_RESET
    expect(firedWith).toBe('sys');
    const state = rtc.readWord(RTC_CNTL_REG.RESET_STATE);
    expect(state & 0x3f).toBe(RESET_CAUSE.SW_SYS_RESET);
    expect((state >>> 6) & 0x3f).toBe(RESET_CAUSE.SW_SYS_RESET);
  });

  it('a plain OPTIONS0 write (no reset bits) round-trips and never fires onReset', () => {
    const rtc = new RtcCntl();
    let fired = false;
    rtc.onReset = () => (fired = true);

    // 0x1000 avoids bits 4/5/31 (the reset-trigger bits) so this is a genuine no-op write.
    rtc.writeWord(RTC_CNTL_REG.OPTIONS0, 0x1000);
    expect(rtc.readWord(RTC_CNTL_REG.OPTIONS0)).toBe(0x1000);
    expect(fired).toBe(false);
  });

  it('RESET_STATE write only affects the stat-vector-sel bits, not reset cause', () => {
    const rtc = new RtcCntl();
    rtc.writeWord(RTC_CNTL_REG.RESET_STATE, 0); // clear both stat_vector_sel bits
    const state = rtc.readWord(RTC_CNTL_REG.RESET_STATE);
    expect((state >>> 13) & 1).toBe(0);
    expect((state >>> 12) & 1).toBe(0);
    expect(state & 0x3f).toBe(RESET_CAUSE.POWERON_RESET); // reset cause untouched
  });

  it('triggerWdtReset("cpu") sets TGWDT_CPU_RESET on PROCPU only and fires onReset("wdt-cpu")', () => {
    const rtc = new RtcCntl();
    let firedWith: string | undefined;
    rtc.onReset = (cause) => (firedWith = cause);

    rtc.triggerWdtReset('cpu');
    expect(firedWith).toBe('wdt-cpu');
    const state = rtc.readWord(RTC_CNTL_REG.RESET_STATE);
    expect(state & 0x3f).toBe(RESET_CAUSE.TGWDT_CPU_RESET);
    expect((state >>> 6) & 0x3f).toBe(RESET_CAUSE.POWERON_RESET); // APPCPU untouched
  });

  it('triggerWdtReset("sys") sets TG0WDT_SYS_RESET on both cores and fires onReset("wdt-sys")', () => {
    const rtc = new RtcCntl();
    let firedWith: string | undefined;
    rtc.onReset = (cause) => (firedWith = cause);

    rtc.triggerWdtReset('sys');
    expect(firedWith).toBe('wdt-sys');
    const state = rtc.readWord(RTC_CNTL_REG.RESET_STATE);
    expect(state & 0x3f).toBe(RESET_CAUSE.TG0WDT_SYS_RESET);
    expect((state >>> 6) & 0x3f).toBe(RESET_CAUSE.TG0WDT_SYS_RESET);
  });
});
