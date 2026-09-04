import { describe, expect, it } from 'vitest';
import { EFFECT_TYPES } from '@/core/project/schemas';
import {
  defaultEffectParams,
  effectParamLabel,
  effectParamUnit,
  EFFECT_PARAM_CHOICES,
  EFFECT_PARAM_RANGES,
} from './effectParams';

describe('effect parameter defaults (spec §5.7)', () => {
  it('gives every native effect defaults that sit within its declared ranges', () => {
    for (const effectType of EFFECT_TYPES) {
      const defaults = defaultEffectParams(effectType);
      const ranges = EFFECT_PARAM_RANGES[effectType];
      for (const [name, value] of Object.entries(defaults)) {
        if (name === 'mix') continue; // mix is the wrapper's param, ranged 0..1
        const range = ranges[name];
        expect(range, `${effectType}.${name} should have a declared range`).toBeDefined();
        expect(value).toBeGreaterThanOrEqual(range![0]);
        expect(value).toBeLessThanOrEqual(range![1]);
      }
    }
  });

  it('ships the worklet effects with ranged params (spec §5.7)', () => {
    const limiter = defaultEffectParams('limiter');
    expect(limiter.ceiling).toBeGreaterThanOrEqual(-6);
    expect(limiter.ceiling).toBeLessThanOrEqual(0);
    expect(limiter.release).toBeGreaterThanOrEqual(10);

    const comp = defaultEffectParams('multibandComp');
    expect(comp.crossoverLowMid).toBeGreaterThanOrEqual(40);
    expect(comp.crossoverMidHigh).toBeLessThanOrEqual(8_000);
    // Every default sits inside its declared range.
    for (const [name, value] of Object.entries(comp)) {
      const range = EFFECT_PARAM_RANGES.multibandComp[name]!;
      expect(value).toBeGreaterThanOrEqual(range[0]);
      expect(value).toBeLessThanOrEqual(range[1]);
    }
  });
});

/**
 * Every §5.7 parameter has to be readable (spec §8.2, issue #35). These are the gate
 * against the labels and units drifting away from the ranges beside them — a parameter
 * added to `EFFECT_PARAM_RANGES` and nowhere else fails here rather than silently
 * announcing its own store key.
 */
describe('every §5.7 parameter reads as words and a unit (spec §8.2, issue #35)', () => {
  /** The unit and domain tokens `formatValueText` knows how to turn into words. */
  const KNOWN_UNITS = new Set(['', 'dB', 'dBFS', 'Hz', 'ms', 's', '%', 'fraction', 'ratio', 'pan']);

  /** A parameter that is genuinely dimensionless, and reads as a bare number on hardware too. */
  const DIMENSIONLESS = new Set(['type', 'sync', 'curve', 'resonance', 'peak1Q', 'peak2Q']);

  it('names every parameter in words rather than in its frozen store key', () => {
    for (const effectType of EFFECT_TYPES) {
      for (const param of Object.keys(EFFECT_PARAM_RANGES[effectType])) {
        const label = effectParamLabel(effectType, param);
        expect(label, `${effectType}.${param}`).not.toBe(param);
        // A label starts as a word a person would say, so it is capitalised.
        expect(label[0], `${effectType}.${param}`).toBe(label[0]!.toUpperCase());
      }
      // The wrapper's own dry/wet mix, which no per-effect table lists (spec §5.7).
      expect(effectParamLabel(effectType, 'mix')).toBe('Mix');
    }
  });

  it('gives every measurable parameter a unit the formatter knows', () => {
    for (const effectType of EFFECT_TYPES) {
      for (const param of Object.keys(EFFECT_PARAM_RANGES[effectType])) {
        const unit = effectParamUnit(effectType, param);
        expect(KNOWN_UNITS.has(unit), `${effectType}.${param} unit "${unit}"`).toBe(true);
        const enumerated = EFFECT_PARAM_CHOICES[effectType]?.[param] !== undefined;
        if (!enumerated && !DIMENSIONLESS.has(param)) {
          expect(unit, `${effectType}.${param} should be measured in something`).not.toBe('');
        }
      }
      expect(effectParamUnit(effectType, 'mix')).toBe('fraction');
    }
  });

  it('falls back to the key rather than throwing on a parameter it has never seen', () => {
    expect(effectParamLabel('delay', 'notAParam')).toBe('notAParam');
    expect(effectParamUnit('delay', 'notAParam')).toBe('');
  });
});
