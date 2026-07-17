import { describe, expect, it } from 'vitest';
import { fadeIn, fadeOut, normalise, peakOf, reverse, trim } from './sampleEdit';

describe('sampleEdit — pure destructive-op DSP (spec §8.5.4)', () => {
  describe('normalise', () => {
    it('scales the loudest channel peak up to the target', () => {
      const out = normalise([Float32Array.from([0.25, -0.5, 0.1])], 1);
      // peak is 0.5 → gain 2 → −0.5 becomes −1.
      expect(peakOf(out)).toBeCloseTo(1, 6);
      expect(out[0]![1]).toBeCloseTo(-1, 6);
    });

    it('normalises stereo by a single shared gain (preserves the balance)', () => {
      const left = Float32Array.from([0.5, 0]);
      const right = Float32Array.from([0.25, 0]);
      const [l, r] = normalise([left, right], 1);
      expect(l![0]).toBeCloseTo(1, 6);
      expect(r![0]).toBeCloseTo(0.5, 6); // same ×2 gain, ratio preserved
    });

    it('leaves silence untouched (no divide-by-zero)', () => {
      const out = normalise([Float32Array.from([0, 0, 0])], 1);
      expect(Array.from(out[0]!)).toEqual([0, 0, 0]);
    });
  });

  describe('reverse', () => {
    it('reverses each channel and does not mutate the input', () => {
      const input = Float32Array.from([1, 2, 3, 4]);
      const out = reverse([input]);
      expect(Array.from(out[0]!)).toEqual([4, 3, 2, 1]);
      expect(Array.from(input)).toEqual([1, 2, 3, 4]);
    });
  });

  describe('fadeIn / fadeOut', () => {
    it('ramps the first N frames from silence to unity (linear)', () => {
      const out = fadeIn([Float32Array.from([1, 1, 1, 1])], 4);
      expect(out[0]![0]).toBeCloseTo(0, 6);
      expect(out[0]![2]).toBeCloseTo(0.5, 6);
      expect(out[0]![3]).toBeCloseTo(0.75, 6);
    });

    it('ramps the last N frames down to silence at the final sample (linear)', () => {
      const out = fadeOut([Float32Array.from([1, 1, 1, 1])], 4);
      // Mirror of fadeIn: [0.75, 0.5, 0.25, 0] across the four faded frames.
      expect(out[0]![0]).toBeCloseTo(0.75, 6);
      expect(out[0]![1]).toBeCloseTo(0.5, 6);
      expect(out[0]![3]).toBeCloseTo(0, 6);
    });

    it('clamps the fade length to the available frames', () => {
      const out = fadeIn([Float32Array.from([1, 1])], 999);
      expect(out[0]![0]).toBeCloseTo(0, 6);
      expect(out[0]!.length).toBe(2);
    });
  });

  describe('trim', () => {
    it('slices a half-open [start, end) frame range from every channel', () => {
      const out = trim([Float32Array.from([0, 1, 2, 3, 4, 5])], 2, 5);
      expect(Array.from(out[0]!)).toEqual([2, 3, 4]);
    });

    it('clamps out-of-range bounds and rejects an empty/inverted range', () => {
      const out = trim([Float32Array.from([0, 1, 2, 3])], -5, 999);
      expect(Array.from(out[0]!)).toEqual([0, 1, 2, 3]);
      expect(() => trim([Float32Array.from([0, 1, 2, 3])], 3, 3)).toThrow(/range/i);
    });
  });
});
