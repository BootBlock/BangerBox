import { describe, expect, it } from 'vitest';
import {
  formatValueText,
  normalisedToValue,
  quantiseToStep,
  stepValue,
  valueToNormalised,
} from './controlMaths';

describe('controlMaths — linear mapping', () => {
  it('maps the range ends to 0 and 1', () => {
    expect(valueToNormalised(0, [0, 10], 'linear')).toBe(0);
    expect(valueToNormalised(10, [0, 10], 'linear')).toBe(1);
    expect(valueToNormalised(5, [0, 10], 'linear')).toBeCloseTo(0.5);
  });

  it('round-trips through the inverse', () => {
    for (const value of [-1, 0, 0.25, 3.5, 10]) {
      const range: [number, number] = [-1, 10];
      expect(normalisedToValue(valueToNormalised(value, range, 'linear'), range, 'linear')).toBeCloseTo(
        value,
      );
    }
  });

  it('clamps out-of-range input', () => {
    expect(valueToNormalised(-99, [0, 10], 'linear')).toBe(0);
    expect(valueToNormalised(99, [0, 10], 'linear')).toBe(1);
    expect(normalisedToValue(2, [0, 10], 'linear')).toBe(10);
  });
});

describe('controlMaths — logarithmic mapping (spec §5.7 cutoff 20–20 kHz log)', () => {
  const range: [number, number] = [20, 20_000];

  it('places the geometric mean at the centre of travel', () => {
    // A log taper puts sqrt(20 * 20000) ≈ 632 Hz at half travel, not 10 kHz.
    expect(normalisedToValue(0.5, range, 'log')).toBeCloseTo(Math.sqrt(20 * 20_000), 0);
  });

  it('maps the range ends to 0 and 1 and round-trips', () => {
    expect(valueToNormalised(20, range, 'log')).toBeCloseTo(0);
    expect(valueToNormalised(20_000, range, 'log')).toBeCloseTo(1);
    expect(normalisedToValue(valueToNormalised(1000, range, 'log'), range, 'log')).toBeCloseTo(1000, 3);
  });

  it('falls back to linear when the range crosses or touches zero', () => {
    // log of 0/negative is undefined — the taper degrades rather than producing NaN.
    expect(normalisedToValue(0.5, [0, 10], 'log')).toBeCloseTo(5);
    expect(normalisedToValue(0.5, [-5, 5], 'log')).toBeCloseTo(0);
  });
});

describe('controlMaths — stepping (spec §8.2 arrow-key increments, Shift = fine)', () => {
  it('steps by the coarse step and clamps at the ends', () => {
    expect(stepValue(5, 1, { range: [0, 10], step: 1 })).toBe(6);
    expect(stepValue(10, 1, { range: [0, 10], step: 1 })).toBe(10);
    expect(stepValue(0, -1, { range: [0, 10], step: 1 })).toBe(0);
  });

  it('uses the fine step when requested', () => {
    expect(stepValue(5, 1, { range: [0, 10], step: 1, fineStep: 0.1, fine: true })).toBeCloseTo(5.1);
  });

  it('defaults the fine step to a tenth of the coarse step', () => {
    expect(stepValue(5, 1, { range: [0, 10], step: 1, fine: true })).toBeCloseTo(5.1);
  });

  it('quantises to the step grid from the range floor', () => {
    expect(quantiseToStep(5.4, [0, 10], 1)).toBe(5);
    expect(quantiseToStep(5.6, [0, 10], 1)).toBe(6);
    // A grid anchored at a non-zero floor stays on that floor's lattice.
    expect(quantiseToStep(21, [20, 30], 4)).toBe(20);
    expect(quantiseToStep(23, [20, 30], 4)).toBe(24);
    // step 0 disables quantisation.
    expect(quantiseToStep(5.4321, [0, 10], 0)).toBe(5.4321);
  });
});

describe('controlMaths — aria-valuetext in human units (spec §8.2)', () => {
  it('formats with the unit and sensible precision', () => {
    expect(formatValueText(-6, 'dB')).toBe('−6.0 dB');
    expect(formatValueText(0.5, '')).toBe('0.5');
    expect(formatValueText(120, 'bpm')).toBe('120 bpm');
  });

  it('abbreviates kilohertz above 1000 Hz (spec §8.2 "1.2 kHz")', () => {
    expect(formatValueText(1200, 'Hz')).toBe('1.2 kHz');
    expect(formatValueText(20, 'Hz')).toBe('20 Hz');
    expect(formatValueText(20_000, 'Hz')).toBe('20.0 kHz');
  });

  it('renders true silence as −∞ dB rather than a large negative number', () => {
    expect(formatValueText(Number.NEGATIVE_INFINITY, 'dB')).toBe('−∞ dB');
  });

  it('uses the en-GB minus sign, not a hyphen (spec §1.3 en-GB locale)', () => {
    expect(formatValueText(-6, 'dB').startsWith('−')).toBe(true);
  });

  it('formats percentages as integers', () => {
    expect(formatValueText(62.4, '%')).toBe('62 %');
  });
});
