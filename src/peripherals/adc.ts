/**
 * ESP32 SAR ADC (SENS peripheral) - single-shot channel select + read, no
 * touch sensor support.
 *
 * Register offsets and behavior are taken from this repo's own pre-rewrite
 * QEMU source (recoverable from git history at `cae84de99b^`):
 * `include/hw/esp32/esp32_sens.h` for state shape,
 * `hw/esp32/esp32_sens.c`'s `esp32_sens_read`/`_write` for behavior.
 *
 * ADC1 and ADC2 each have their own "start conversion" register
 * (SENS_MEAS1/2_START_SAR): writing it encodes the channel to sample as a
 * one-hot bitmask in bits[30:19] (`bitpos()` in the reference finds which
 * single bit is set, 0-16); reading it back returns `0x10000 |
 * adcValue[channel]` - bit16 is the real hardware's conversion-done flag,
 * modeled here as always "done" immediately (no real ADC hardware exists
 * to take time converting). ADC2's channel indexes into the *same*
 * 32-entry value array, offset by 8 (`ADC_values[channel2 + 8]`) -
 * replicated exactly rather than given ADC2 its own array, since that's
 * what the reference actually does.
 *
 * `setChannelValue`/`getChannelValue` are this peripheral's equivalent of
 * `Gpio.setPin`/`getPin` - the entry point for injecting a simulated
 * analog reading from outside the chip, since there's no real analog input
 * to sample.
 *
 * Not implemented: touch sensor channels (SENS_SAR_TOUCH_CTRL2_REG and the
 * 0x70-0x83 touch-pad range) - the reference's own touch model folds in
 * `rand()` noise and physicalsim-specific calibration constants (pin-
 * specific comments in `esp32_sens.c` like "2=gpio2 ... land +/-300:
 * 2=12166,31743") that aren't meaningful to reproduce without the same
 * calibration data; ADC_ATTEN/width configuration registers (SENS_SAR_
 * ATTEN, SENS_SAR_READ_CTRL) are real ESP32 registers the reference itself
 * doesn't back either.
 */

export const ADC_REG = {
  MEAS1_START_SAR: 0x54,
  MEAS2_START_SAR: 0x94,
} as const;

/** Byte size of the register window this peripheral occupies at its base address. */
export const ADC_WINDOW_SIZE = 0x400;

const CHANNEL_FIELD_MASK = 0x7ff80000;
const CHANNEL_FIELD_SHIFT = 19;
const DONE_BIT = 0x10000;

/** Position of the single set bit in a one-hot value (0 if none/multiple), matching the reference's `bitpos()`. */
function bitpos(value: number): number {
  if (value === 0 || (value & (value - 1)) !== 0) return 0;
  return 31 - Math.clz32(value >>> 0);
}

export class Adc {
  private readonly values = new Int16Array(32);
  private channel1 = 0;
  private channel2 = 0;

  /** Inject a simulated raw ADC reading for `channel` (0-16 for ADC1, matching the reference's flat 32-entry array; pass `channel + 8` to target the same index ADC2 would read). */
  setChannelValue(channel: number, value: number): void {
    if (channel < 0 || channel >= this.values.length) return;
    this.values[channel] = value;
  }

  getChannelValue(channel: number): number {
    return channel < 0 || channel >= this.values.length ? 0 : this.values[channel]!;
  }

  readWord(offset: number): number {
    switch (offset) {
      case ADC_REG.MEAS1_START_SAR:
        return (DONE_BIT + this.values[this.channel1]!) >>> 0;
      case ADC_REG.MEAS2_START_SAR:
        return (DONE_BIT + this.values[this.channel2 + 8]!) >>> 0;
      default:
        return 0;
    }
  }

  writeWord(offset: number, value: number): void {
    const channelField = (value & CHANNEL_FIELD_MASK) >>> CHANNEL_FIELD_SHIFT;
    switch (offset) {
      case ADC_REG.MEAS1_START_SAR:
        if (channelField) this.channel1 = bitpos(channelField);
        break;
      case ADC_REG.MEAS2_START_SAR:
        if (channelField) this.channel2 = bitpos(channelField);
        break;
      default:
        break;
    }
  }
}
