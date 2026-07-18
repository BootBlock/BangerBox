/**
 * Looper take folding (spec §8.5.8) — the bar-locked length and overdub layering rules,
 * exercised without an AudioContext (§7.1.5).
 */
import { describe, expect, it } from 'vitest';
import { foldCaptureIntoTake } from './looper';

const chunk = (...values: number[]) => Float32Array.from(values);

describe('foldCaptureIntoTake (spec §8.5.8)', () => {
  it('concatenates the drained chunks when the capture is open-ended', () => {
    const take = foldCaptureIntoTake([chunk(1, 2), chunk(3)], null, 0);
    expect(Array.from(take!)).toEqual([1, 2, 3]);
  });

  it('pads a short bar-locked capture to the target length so overdubs stay aligned', () => {
    const take = foldCaptureIntoTake([chunk(1, 2)], null, 4);
    expect(Array.from(take!)).toEqual([1, 2, 0, 0]);
  });

  it('truncates a capture that overran the bar line', () => {
    const take = foldCaptureIntoTake([chunk(1, 2), chunk(3, 4)], null, 3);
    expect(Array.from(take!)).toEqual([1, 2, 3]);
  });

  it('sums onto the base when overdubbing, keeping the take one bar long', () => {
    const base = chunk(1, 1, 1, 1);
    const take = foldCaptureIntoTake([chunk(0.5, 0.5)], base, 4);
    expect(Array.from(take!)).toEqual([1.5, 1.5, 1, 1]);
    // The base is not mutated in place — layers are additive, not destructive.
    expect(Array.from(base)).toEqual([1, 1, 1, 1]);
  });

  it('leaves the held take alone when nothing was captured', () => {
    const base = chunk(1, 2);
    expect(foldCaptureIntoTake([], base, 4)).toBe(base);
    expect(foldCaptureIntoTake([], null, 4)).toBeNull();
  });

  it('replaces rather than sums when there is no base to overdub onto', () => {
    const take = foldCaptureIntoTake([chunk(0.25, 0.25)], null, 2);
    expect(Array.from(take!)).toEqual([0.25, 0.25]);
  });
});
