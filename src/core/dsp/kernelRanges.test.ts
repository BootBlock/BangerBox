/**
 * The §5.7 bounds each kernel wrapper clamps against are declared beside the wrapper rather
 * than imported from `effectParams.ts`, because a wrapper is loaded inside the DSP-effect
 * worklet (spec §5.6.2) and importing the effect table there would drag `@/core/project/schemas`
 * — and Zod behind it — into the render thread.
 *
 * That leaves two copies of the same numbers, which §13.6 calls drift. This test is the gate:
 * the local bounds must equal the §5.7 table entry they mirror, so a change to one fails here
 * until the other follows.
 */
import { describe, expect, it } from 'vitest';
import { EFFECT_PARAM_RANGES } from '@/core/audio/inserts/effectParams';
import { FDN_REVERB_RANGES } from './fdnReverbKernel';
import { LIMITER_RANGES } from './lookaheadLimiterKernel';
import { MULTIBAND_RANGES } from './multibandCompKernel';

describe('kernel wrapper bounds mirror the §5.7 table (spec §13.6)', () => {
  it('limiter', () => {
    expect(LIMITER_RANGES.ceiling).toEqual(EFFECT_PARAM_RANGES.limiter.ceiling);
    expect(LIMITER_RANGES.release).toEqual(EFFECT_PARAM_RANGES.limiter.release);
  });

  it('fdnReverb', () => {
    expect(FDN_REVERB_RANGES.size).toEqual(EFFECT_PARAM_RANGES.reverb.size);
    expect(FDN_REVERB_RANGES.damping).toEqual(EFFECT_PARAM_RANGES.reverb.damping);
    expect(FDN_REVERB_RANGES.predelay).toEqual(EFFECT_PARAM_RANGES.reverb.predelay);
  });

  it('multibandComp', () => {
    const table = EFFECT_PARAM_RANGES.multibandComp;
    expect(MULTIBAND_RANGES.crossoverLowMid).toEqual(table.crossoverLowMid);
    expect(MULTIBAND_RANGES.crossoverMidHigh).toEqual(table.crossoverMidHigh);
    expect(MULTIBAND_RANGES.threshold).toEqual(table.band0Threshold);
    expect(MULTIBAND_RANGES.ratio).toEqual(table.band0Ratio);
    expect(MULTIBAND_RANGES.attack).toEqual(table.band0Attack);
    expect(MULTIBAND_RANGES.release).toEqual(table.band0Release);
    expect(MULTIBAND_RANGES.makeup).toEqual(table.band0Makeup);
  });
});
