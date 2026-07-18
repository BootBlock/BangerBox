/**
 * Waveform peak pyramid (spec §8.5.4) — the min/max reduction a canvas draws instead of the
 * decoded signal. Level 0 buckets the mono mix at {@link BASE_BUCKET_FRAMES}; each subsequent
 * level halves the resolution by folding pairs of the level below it, so building the whole
 * pyramid costs one pass over the audio plus a geometrically shrinking tail.
 *
 * This module is pure and runs in the worker (spec §3.3 forbids this on the main thread); the
 * client that computes and caches one per sample is `peakPyramidCache.ts`.
 */

/**
 * Buckets in level 0, at most. The bucket *size* is derived from this rather than fixed, which
 * matters at both ends: a fixed size fine enough for a ten-minute sample would make level 0 of a
 * one-shot only a couple of dozen buckets — visibly blocky on a full-width editor canvas — while
 * a fixed size fine enough for the one-shot would make a long sample's level 0 enormous. Deriving
 * it means every sample gets a level 0 finer than any canvas asks for, and bounds the memory a
 * cached pyramid can take (~64 KiB for level 0, ~128 KiB for the whole pyramid).
 */
export const MAX_BASE_BUCKETS = 8192;

/** Frames each level-0 bucket summarises for a signal of this length. */
export function baseBucketFrames(frames: number): number {
  return Math.max(1, Math.ceil(frames / MAX_BASE_BUCKETS));
}

/** Stop coarsening once a level is this small; nothing on screen asks for fewer columns. */
const MIN_BUCKETS = 64;

export interface PyramidLevel {
  /** Frames of source audio each bucket summarises. */
  readonly bucketFrames: number;
  /** Per-bucket minimum and maximum sample value, both length `bucketCount`. */
  readonly min: Float32Array;
  readonly max: Float32Array;
}

export interface PeakPyramid {
  /** Frames in the source signal, so a caller can map buckets back to time. */
  readonly frames: number;
  /** Finest level first; each is half the resolution of the one before it. */
  readonly levels: readonly PyramidLevel[];
}

/** Mono down-mix — the pyramid summarises one signal, not one per channel (spec §8.4). */
export function monoDownmix(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!.slice();
  const frames = channels[0]!.length;
  const out = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  return out;
}

/** Reduce a mono signal to its level-0 min/max buckets. */
function baseLevel(mono: Float32Array): PyramidLevel {
  const bucketFrames = baseBucketFrames(mono.length);
  const bucketCount = Math.max(1, Math.ceil(mono.length / bucketFrames));
  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = bucket * bucketFrames;
    const end = Math.min(start + bucketFrames, mono.length);
    // An empty trailing bucket would leave 0/0, which reads as silence — correct for it.
    let lo = 0;
    let hi = 0;
    if (end > start) {
      lo = Infinity;
      hi = -Infinity;
      for (let i = start; i < end; i++) {
        const value = mono[i]!;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    min[bucket] = lo;
    max[bucket] = hi;
  }
  return { bucketFrames, min, max };
}

/** Fold pairs of buckets into one, halving the resolution. */
function coarsen(level: PyramidLevel): PyramidLevel {
  const bucketCount = Math.ceil(level.min.length / 2);
  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const a = bucket * 2;
    const b = a + 1;
    const hasB = b < level.min.length;
    min[bucket] = hasB ? Math.min(level.min[a]!, level.min[b]!) : level.min[a]!;
    max[bucket] = hasB ? Math.max(level.max[a]!, level.max[b]!) : level.max[a]!;
  }
  return { bucketFrames: level.bucketFrames * 2, min, max };
}

/** Build the full pyramid for a mono signal (spec §8.5.4). */
export function buildPeakPyramid(mono: Float32Array): PeakPyramid {
  const levels: PyramidLevel[] = [baseLevel(mono)];
  while (levels[levels.length - 1]!.min.length > MIN_BUCKETS) {
    levels.push(coarsen(levels[levels.length - 1]!));
  }
  return { frames: mono.length, levels };
}

/**
 * The cheapest level that still has at least one bucket per requested column — so a 96 px
 * micro-preview reads a coarse level and a full-width editor reads a fine one, from the same
 * cached pyramid. Falls back to level 0 when even it is coarser than the request.
 */
export function levelForColumns(pyramid: PeakPyramid, columns: number): PyramidLevel {
  for (let i = pyramid.levels.length - 1; i >= 0; i--) {
    const level = pyramid.levels[i]!;
    if (level.min.length >= columns) return level;
  }
  return pyramid.levels[0]!;
}
