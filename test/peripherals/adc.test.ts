import { describe, expect, it } from 'vitest';
import { Adc, ADC_REG } from '../../src/peripherals/adc.js';

describe('Adc', () => {
  it('reads back the done bit (0x10000) plus channel 0 value (0) at reset', () => {
    const adc = new Adc();
    expect(adc.readWord(ADC_REG.MEAS1_START_SAR)).toBe(0x10000);
    expect(adc.readWord(ADC_REG.MEAS2_START_SAR)).toBe(0x10000);
  });

  it('selects an ADC1 channel via one-hot bits[30:19] and reads its injected value', () => {
    const adc = new Adc();
    adc.setChannelValue(3, 2048);
    adc.writeWord(ADC_REG.MEAS1_START_SAR, 1 << (19 + 3)); // one-hot for channel 3
    expect(adc.readWord(ADC_REG.MEAS1_START_SAR)).toBe(0x10000 + 2048);
  });

  it('ADC2 channel select indexes into the same value array offset by 8', () => {
    const adc = new Adc();
    adc.setChannelValue(5 + 8, 1234); // what ADC2 channel 5 reads
    adc.writeWord(ADC_REG.MEAS2_START_SAR, 1 << (19 + 5));
    expect(adc.readWord(ADC_REG.MEAS2_START_SAR)).toBe(0x10000 + 1234);
    // ADC1's own channel 5 (index 5, not 13) is unaffected
    expect(adc.getChannelValue(5)).toBe(0);
  });

  it('a zero channel field leaves the previously selected channel unchanged', () => {
    const adc = new Adc();
    adc.setChannelValue(2, 500);
    adc.writeWord(ADC_REG.MEAS1_START_SAR, 1 << (19 + 2));
    adc.writeWord(ADC_REG.MEAS1_START_SAR, 0); // no channel bits set - a "start" with no reselect
    expect(adc.readWord(ADC_REG.MEAS1_START_SAR)).toBe(0x10000 + 500);
  });

  it('getChannelValue/setChannelValue ignore out-of-range channels', () => {
    const adc = new Adc();
    adc.setChannelValue(-1, 99);
    adc.setChannelValue(32, 99);
    expect(adc.getChannelValue(-1)).toBe(0);
    expect(adc.getChannelValue(32)).toBe(0);
  });

  it('unrecognized offsets read as 0 and ignore writes', () => {
    const adc = new Adc();
    expect(adc.readWord(0x200)).toBe(0);
    adc.writeWord(0x200, 0xffffffff);
    expect(adc.readWord(0x200)).toBe(0);
  });
});
