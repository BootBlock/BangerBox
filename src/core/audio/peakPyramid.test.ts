/** Peak-pyramid reduction tests (spec §8.5.4) — the pure half of the waveform pipeline. */
import { describe, expect, it } from 'vitest';
import {
  MAX_BASE_BUCKETS,
  baseBucketFrames,
  buildPeakPyramid,
  levelForColumns,
  monoDownmix,
} from './peakPyramid';

/** A length whose level-0 buckets are exactly 256 frames, for the fixed-geometry cases below. */
const BUCKET = 256;
const FRAMES_FOR_256 = MAX_BASE_BUCKETS * BUCKET;

/** A signal whose extremes sit at known frames, so a lost bucket is visible. */
function signalWithSpikes(frames: number, spikes: ReadonlyMap<number, number>): Float32Array {
  const out = new Float32Array(frames);
  for (const [index, value] of spikes) out[index] = value;
  return out;
}

describe('monoDownmix', () => {
  it('passes a mono signal through as a copy', () => {
    const source = new Float32Array([0.5, -0.25]);
    const mixed = monoDownmix([source]);
    expect(Array.from(mixed)).toEqual([0.5, -0.25]);
    expect(mixed).not.toBe(source); // callers may transfer the result
  });

  it('averages channels rather than summing them', () => {
    const mixed = monoDownmix([new Float32Array([1, -1]), new Float32Array([0, 1])]);
    expect(Array.from(mixed)).toEqual([0.5, 0]);
  });

  it('returns an empty signal for no channels', () => {
    expect(monoDownmix([]).length).toBe(0);
  });
});

describe('buildPeakPyramid', () => {
  it('keeps the true min and max of every base bucket', () => {
    const mono = signalWithSpikes(
      FRAMES_FOR_256,
      new Map([
        [10, 0.9],
        [20, -0.7],
        [BUCKET + 5, 0.3],
      ]),
    );
    const base = buildPeakPyramid(mono).levels[0]!;
    expect(base.bucketFrames).toBe(BUCKET);
    expect(base.max[0]).toBeCloseTo(0.9);
    expect(base.min[0]).toBeCloseTo(-0.7);
    expect(base.max[1]).toBeCloseTo(0.3);
    expect(base.min[1]).toBe(0);
  });

  it('records the source frame count', () => {
    expect(buildPeakPyramid(new Float32Array(1234)).frames).toBe(1234);
  });

  it('halves resolution each level and never loses an extreme', () => {
    const mono = signalWithSpikes(FRAMES_FOR_256, new Map([[900, 0.95]]));
    const pyramid = buildPeakPyramid(mono);
    expect(pyramid.levels.length).toBeGreaterThan(1);
    for (let i = 1; i < pyramid.levels.length; i++) {
      const finer = pyramid.levels[i - 1]!;
      const coarser = pyramid.levels[i]!;
      expect(coarser.bucketFrames).toBe(finer.bucketFrames * 2);
      expect(coarser.min.length).toBe(Math.ceil(finer.min.length / 2));
    }
    // The peak survives all the way to the coarsest level — that is what makes a
    // micro-preview honest rather than a decimated sample of the signal.
    for (const level of pyramid.levels) {
      expect(Math.max(...level.max)).toBeCloseTo(0.95);
    }
  });

  it('stops coarsening rather than collapsing to a single bucket', () => {
    const coarsest = buildPeakPyramid(new Float32Array(FRAMES_FOR_256)).levels.at(-1)!;
    expect(coarsest.min.length).toBeGreaterThan(1);
  });

  it('gives a short one-shot a bucket per frame, so an editor canvas is not blocky', () => {
    // A 5760-frame maracas hit at 48 kHz. With a fixed 256-frame bucket this reduced to 23
    // buckets and drew as a visible staircase across a ~1000 px canvas; the bucket size is
    // derived from the length precisely so short samples stay smooth.
    const pyramid = buildPeakPyramid(new Float32Array(5760));
    expect(pyramid.levels[0]!.bucketFrames).toBe(1);
    expect(pyramid.levels[0]!.min.length).toBe(5760);
    expect(levelForColumns(pyramid, 1009).min.length).toBeGreaterThanOrEqual(1009);
  });

  it('bounds level 0 for a long sample rather than growing without limit', () => {
    // Ten minutes of stereo at 48 kHz — the case a fixed bucket size makes enormous.
    const base = buildPeakPyramid(new Float32Array(48_000 * 600)).levels[0]!;
    expect(base.min.length).toBeLessThanOrEqual(MAX_BASE_BUCKETS);
    expect(base.bucketFrames).toBe(baseBucketFrames(48_000 * 600));
  });

  it('handles a signal of only a couple of frames', () => {
    // Derived bucket sizing gives this one frame per bucket, so the two extremes land apart.
    const pyramid = buildPeakPyramid(new Float32Array([0.5, -0.5]));
    expect(pyramid.levels).toHaveLength(1);
    expect(pyramid.levels[0]!.bucketFrames).toBe(1);
    expect(Math.max(...pyramid.levels[0]!.max)).toBeCloseTo(0.5);
    expect(Math.min(...pyramid.levels[0]!.min)).toBeCloseTo(-0.5);
  });

  it('reads an empty signal as silence, not as ±Infinity', () => {
    const base = buildPeakPyramid(new Float32Array(0)).levels[0]!;
    expect(base.min[0]).toBe(0);
    expect(base.max[0]).toBe(0);
  });
});

describe('levelForColumns', () => {
  const pyramid = buildPeakPyramid(new Float32Array(FRAMES_FOR_256));

  it('picks the coarsest level that still covers every column', () => {
    const level = levelForColumns(pyramid, 96);
    expect(level.min.length).toBeGreaterThanOrEqual(96);
    const finerThanNeeded = pyramid.levels.filter((l) => l.min.length >= 96);
    expect(level).toBe(finerThanNeeded.at(-1));
  });

  it('gives a wide canvas a finer level than a micro-preview', () => {
    const thumb = levelForColumns(pyramid, 64);
    const editor = levelForColumns(pyramid, 1200);
    expect(editor.min.length).toBeGreaterThan(thumb.min.length);
  });

  it('falls back to the finest level when even it is too coarse', () => {
    expect(levelForColumns(pyramid, 10_000_000)).toBe(pyramid.levels[0]);
  });
});
