import { describe, expect, it } from 'vitest';
import { enforceMinSpacing, equalSlices, slicesFromMarkers, slicesFromOnsets } from './chop';

describe('chop — pure slice-region maths (spec §8.5.4)', () => {
  describe('equalSlices', () => {
    it('divides a sample into N contiguous equal regions covering the whole file', () => {
      const slices = equalSlices(1000, 4);
      expect(slices).toEqual([
        { startFrame: 0, endFrame: 250 },
        { startFrame: 250, endFrame: 500 },
        { startFrame: 500, endFrame: 750 },
        { startFrame: 750, endFrame: 1000 },
      ]);
    });

    it('distributes the remainder so regions stay contiguous and gap-free', () => {
      const slices = equalSlices(1003, 3);
      expect(slices[0]!.startFrame).toBe(0);
      expect(slices[2]!.endFrame).toBe(1003);
      for (let i = 1; i < slices.length; i++) {
        expect(slices[i]!.startFrame).toBe(slices[i - 1]!.endFrame);
      }
    });

    it('rejects a slice count below 1', () => {
      expect(() => equalSlices(1000, 0)).toThrow(/count/i);
    });
  });

  describe('slicesFromMarkers', () => {
    it('builds regions between sorted, de-duplicated interior markers plus the file bounds', () => {
      const slices = slicesFromMarkers(1000, [500, 250, 250]);
      expect(slices).toEqual([
        { startFrame: 0, endFrame: 250 },
        { startFrame: 250, endFrame: 500 },
        { startFrame: 500, endFrame: 1000 },
      ]);
    });

    it('ignores markers at or beyond the file bounds and returns one region for none', () => {
      expect(slicesFromMarkers(1000, [0, 1000, 2000])).toEqual([{ startFrame: 0, endFrame: 1000 }]);
      expect(slicesFromMarkers(1000, [])).toEqual([{ startFrame: 0, endFrame: 1000 }]);
    });
  });

  describe('enforceMinSpacing', () => {
    it('drops markers closer than the minimum spacing to the previously kept one', () => {
      expect(enforceMinSpacing([100, 140, 300, 320, 800], 100)).toEqual([100, 300, 800]);
    });

    it('sorts the input and keeps the earliest of a dense cluster', () => {
      expect(enforceMinSpacing([320, 100, 300, 800, 140], 100)).toEqual([100, 300, 800]);
    });
  });
});

describe('chop guards its inputs (spec §8.5.4, issue #97)', () => {
  it('refuses more slices than the sample has frames', () => {
    // `equalSlices(8, 3)` is fine; the other way round yields five zero-length regions,
    // which chop-to-pads then assigns as silent pads with no error at all.
    expect(() => equalSlices(8, 3)).not.toThrow();
    expect(() => equalSlices(3, 8)).toThrow(/frames/i);
  });

  it('refuses a zero-frame or non-integer sample length', () => {
    expect(() => equalSlices(0, 4)).toThrow();
    expect(() => equalSlices(1000.5, 4)).toThrow();
    expect(() => equalSlices(Number.NaN, 4)).toThrow();
  });

  it('drops duplicate markers even when the minimum spacing is zero', () => {
    expect(enforceMinSpacing([10, 10, 10], 0)).toEqual([10]);
    expect(enforceMinSpacing([10, 11, 12], 0)).toEqual([10, 11, 12]);
  });

  it('treats a non-finite minimum spacing as one frame', () => {
    expect(enforceMinSpacing([10, 10, 20], Number.NaN)).toEqual([10, 20]);
  });

  it('ignores non-finite markers and onsets rather than emitting NaN regions', () => {
    expect(slicesFromMarkers(1000, [Number.NaN, 500])).toEqual([
      { startFrame: 0, endFrame: 500 },
      { startFrame: 500, endFrame: 1000 },
    ]);
    expect(slicesFromOnsets(1000, [Number.NaN, 400])).toEqual([{ startFrame: 400, endFrame: 1000 }]);
  });
});
