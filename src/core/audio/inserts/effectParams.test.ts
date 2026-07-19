import { describe, expect, it } from 'vitest';
import { EFFECT_TYPES } from '@/core/project/schemas';
import { defaultEffectParams, EFFECT_PARAM_RANGES } from './effectParams';

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
