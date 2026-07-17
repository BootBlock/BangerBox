import { describe, expect, it } from 'vitest';
import { LEVEL_RANGE } from '@/core/project/schemas';
import {
  FADER_FLOOR_DB,
  FADER_MAX_DB,
  dbToGain,
  faderLevelToDb,
  faderLevelToGain,
} from './faderLaw';

describe('fader law (spec §8.5.6)', () => {
  it('places unity (0 dB) at level 1.0', () => {
    expect(faderLevelToDb(1)).toBe(0);
    expect(faderLevelToGain(1)).toBeCloseTo(1, 12);
  });

  it('places +6 dB at the top of the fader (level 1.2)', () => {
    expect(faderLevelToDb(LEVEL_RANGE[1])).toBeCloseTo(FADER_MAX_DB, 12);
    // +6 dB ≈ ×1.9953
    expect(faderLevelToGain(LEVEL_RANGE[1])).toBeCloseTo(1.9953, 3);
  });

  it('is true silence (−∞ dB, gain 0) at the bottom of the fader', () => {
    expect(faderLevelToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(faderLevelToGain(0)).toBe(0);
    // Below zero is clamped to silence too.
    expect(faderLevelToGain(-0.5)).toBe(0);
  });

  it('maps the lower half perceptually (linear-in-dB toward the floor)', () => {
    // Half travel → half of the floor in dB space.
    expect(faderLevelToDb(0.5)).toBeCloseTo(FADER_FLOOR_DB / 2, 12);
    expect(faderLevelToGain(0.5)).toBeCloseTo(dbToGain(FADER_FLOOR_DB / 2), 12);
  });

  it('is monotonically increasing across the whole range', () => {
    let previous = -1;
    for (let level = 0; level <= LEVEL_RANGE[1] + 1e-9; level += 0.01) {
      const gain = faderLevelToGain(level);
      expect(gain).toBeGreaterThanOrEqual(previous);
      previous = gain;
    }
  });

  it('converts dB to linear gain (−∞ ⇒ 0)', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 12);
    expect(dbToGain(6)).toBeCloseTo(1.9953, 3);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
