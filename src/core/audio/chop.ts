/**
 * Chop slice-region maths (spec §8.5.4) — pure functions turning equal divisions, manual
 * markers, or WASM-detected transients into contiguous frame regions the editor assigns to
 * pads or a new program. Detection itself is the `transientDetect` WASM kernel (spec §7.5);
 * this module only slices, so it stays dependency-free and trivially testable (spec §2.5).
 */

/** A half-open frame region `[startFrame, endFrame)` of a sample (spec §8.5.4). */
export interface SliceRegion {
  readonly startFrame: number;
  readonly endFrame: number;
}

/** Divide `totalFrames` into `count` contiguous, gap-free equal regions (spec §8.5.4). */
export function equalSlices(totalFrames: number, count: number): SliceRegion[] {
  if (count < 1 || !Number.isInteger(count)) throw new Error('equalSlices: count must be a positive integer');
  const regions: SliceRegion[] = [];
  for (let i = 0; i < count; i++) {
    // Round each boundary from the exact fraction so remainders spread evenly and adjacent
    // regions always share an edge (no gaps, no overlaps).
    const startFrame = Math.round((i * totalFrames) / count);
    const endFrame = Math.round(((i + 1) * totalFrames) / count);
    regions.push({ startFrame, endFrame });
  }
  return regions;
}

/**
 * Build regions from interior marker frames plus the implicit file bounds (spec §8.5.4).
 * Markers are sorted and de-duplicated; markers at or outside `(0, totalFrames)` are ignored.
 * With no valid markers the whole sample is one region.
 */
export function slicesFromMarkers(totalFrames: number, markers: readonly number[]): SliceRegion[] {
  const interior = [...new Set(markers.map((m) => Math.round(m)))]
    .filter((m) => m > 0 && m < totalFrames)
    .sort((a, b) => a - b);
  const boundaries = [0, ...interior, totalFrames];
  const regions: SliceRegion[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    regions.push({ startFrame: boundaries[i]!, endFrame: boundaries[i + 1]! });
  }
  return regions;
}

/**
 * Thin a marker list so no two kept markers are closer than `minSpacingFrames` (spec §8.5.4 /
 * §7.5 min-spacing). Input is sorted; the earliest of each dense cluster is kept.
 */
export function enforceMinSpacing(markers: readonly number[], minSpacingFrames: number): number[] {
  const sorted = [...markers].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const marker of sorted) {
    if (kept.length === 0 || marker - kept[kept.length - 1]! >= minSpacingFrames) kept.push(marker);
  }
  return kept;
}
