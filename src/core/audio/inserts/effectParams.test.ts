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

  it('gives the deferred worklet effects no native params yet (spec §5.7, Phase 6)', () => {
    expect(defaultEffectParams('multibandComp')).toEqual({});
    expect(defaultEffectParams('limiter')).toEqual({});
  });
});
