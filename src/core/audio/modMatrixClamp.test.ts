/**
 * Mod-matrix clamping (spec §6, issue #76). `modMatrix.ts` documents its result as
 * "left un-clamped so the voice builder can clamp against each target's own range" — these
 * tests pin the clamp the voice builder owes, for every target it consumes.
 *
 * The §6 schema caps the matrix at `MAX_MOD_ROUTES` (32) and each `amount` at ±1, but
 * nothing forbids all 32 routes pointing at one target. A valid, Zod-passing program can
 * therefore sum to ±32 full scale — 32 octaves of detune, or 33× amp gain — which is either
 * silence or hard clipping with no error anywhere.
 */
import { describe, expect, it } from 'vitest';
import { MAX_MOD_ROUTES, type ModRoute } from '@/core/project/schemas';
import { oscillatorDepthScale } from './modMatrix';
import { PITCH_MOD_CENTS, staticModulation } from './voiceModulation';

/** `count` identical routes onto one target — the shape §6 validates but does not bound. */
function pileUp(count: number, source: ModRoute['source'], target: ModRoute['target']): ModRoute[] {
  return Array.from({ length: count }, () => ({ source, target, amount: 1 }));
}

describe('staticModulation clamps its summed targets (spec §6, issue #76)', () => {
  it('caps detune at one octave however many routes point at pitch', () => {
    const stat = staticModulation(pileUp(MAX_MOD_ROUTES, 'velocity', 'pitch'), 60, 127, 0);
    expect(stat.detuneCents).toBe(PITCH_MOD_CENTS);
  });

  it('caps detune symmetrically for negative route sums', () => {
    const routes = pileUp(MAX_MOD_ROUTES, 'velocity', 'pitch').map((route) => ({ ...route, amount: -1 }));
    expect(staticModulation(routes, 60, 127, 0).detuneCents).toBe(-PITCH_MOD_CENTS);
  });

  it('caps the amp factor at full-scale modulation rather than 33x', () => {
    const stat = staticModulation(pileUp(MAX_MOD_ROUTES, 'velocity', 'amp'), 60, 127, 0);
    expect(stat.ampFactor).toBe(2);
  });

  it('caps the cutoff factor at the full-scale modulation depth', () => {
    const stat = staticModulation(pileUp(MAX_MOD_ROUTES, 'velocity', 'filterCutoff'), 60, 127, 0);
    expect(stat.cutoffFactor).toBeCloseTo(2 ** 4, 6);
  });

  it('leaves a single in-range route exactly as it was', () => {
    const routes: ModRoute[] = [{ source: 'velocity', target: 'pitch', amount: 0.5 }];
    // velocity 127 → 1.0 unipolar, so the contribution is 0.5 full scale.
    expect(staticModulation(routes, 60, 127, 0).detuneCents).toBeCloseTo(PITCH_MOD_CENTS * 0.5, 6);
  });

  it('collapses a NaN amount to no modulation rather than poisoning the param', () => {
    const routes: ModRoute[] = [{ source: 'velocity', target: 'pitch', amount: Number.NaN }];
    expect(staticModulation(routes, 60, 127, 0).detuneCents).toBe(0);
  });
});

describe('oscillatorDepthScale bounds the combined LFO excursion (spec §6, issue #76)', () => {
  it('scales 32 full-depth pitch routes back to one full scale between them', () => {
    const routes = pileUp(MAX_MOD_ROUTES, 'lfo1', 'pitch');
    expect(oscillatorDepthScale(routes, 'pitch')).toBeCloseTo(1 / MAX_MOD_ROUTES, 12);
  });

  it('counts both LFOs against the same target', () => {
    const routes: ModRoute[] = [
      { source: 'lfo1', target: 'pitch', amount: 1 },
      { source: 'lfo2', target: 'pitch', amount: 1 },
    ];
    expect(oscillatorDepthScale(routes, 'pitch')).toBeCloseTo(0.5, 12);
  });

  it('leaves routes that already fit inside full scale untouched', () => {
    const routes: ModRoute[] = [
      { source: 'lfo1', target: 'pitch', amount: 0.6 },
      { source: 'lfo2', target: 'pitch', amount: -0.3 },
    ];
    expect(oscillatorDepthScale(routes, 'pitch')).toBe(1);
  });

  it('ignores routes onto other targets and from non-oscillator sources', () => {
    const routes: ModRoute[] = [
      { source: 'lfo1', target: 'pitch', amount: 0.5 },
      { source: 'lfo1', target: 'filterCutoff', amount: 1 },
      { source: 'velocity', target: 'pitch', amount: 1 },
    ];
    expect(oscillatorDepthScale(routes, 'pitch')).toBe(1);
  });

  it('treats a non-finite amount as no depth at all', () => {
    const routes: ModRoute[] = [{ source: 'lfo1', target: 'pitch', amount: Number.NaN }];
    expect(oscillatorDepthScale(routes, 'pitch')).toBe(1);
  });
});
