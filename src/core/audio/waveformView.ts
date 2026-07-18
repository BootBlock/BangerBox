/**
 * Waveform viewport maths (spec §8.5.4 "zoom to sample level", §8.4) — the pure mapping between
 * a sample's frames and the pixel columns of the editor canvas, plus the zoom/scroll window that
 * mapping is taken through.
 *
 * This lives apart from the canvas for the reason §3.3 gives: the interaction layer may not route
 * a drag through React state, so the component drives its rAF redraw from refs holding these
 * values. Keeping the arithmetic here makes the part that is easy to get wrong — anchored zoom,
 * clamping at the ends, hit-testing a marker under the cursor — dependency-free and directly
 * testable (spec §2.5), leaving the component with only drawing and event plumbing.
 */
import { clamp } from '@/core/math';
import type { SliceRegion } from './chop';

/**
 * The visible window: `visibleFrames` of audio starting at `startFrame`. Expressed as a span
 * rather than a `[start, end]` pair because zoom scales the span about an anchor and scroll
 * translates it, and both stay one operation on one field this way.
 */
export interface WaveformView {
  readonly startFrame: number;
  readonly visibleFrames: number;
}

/**
 * The tightest zoom, in frames across the canvas. "Sample level" (§8.5.4) means individual
 * frames are distinguishable; 16 frames over a canvas hundreds of pixels wide puts tens of
 * pixels between consecutive samples, which is as far in as an editor has any use for.
 */
export const MIN_VISIBLE_FRAMES = 16;

/** The whole sample, the view an unzoomed editor opens on. */
export function fullView(totalFrames: number): WaveformView {
  return { startFrame: 0, visibleFrames: Math.max(1, totalFrames) };
}

/**
 * Force a view inside the sample: the span is capped at the file length and floored at
 * {@link MIN_VISIBLE_FRAMES}, then the start is pulled back so the window never runs past the
 * end. Every public operation returns through here, so no caller can produce an out-of-range
 * view by composing them.
 */
export function clampView(view: WaveformView, totalFrames: number): WaveformView {
  const total = Math.max(1, totalFrames);
  const visibleFrames = clamp(Math.round(view.visibleFrames), Math.min(MIN_VISIBLE_FRAMES, total), total);
  const startFrame = clamp(Math.round(view.startFrame), 0, total - visibleFrames);
  return { startFrame, visibleFrames };
}

/** Frame → pixel column within a canvas `width` px wide. May fall outside `[0, width)`. */
export function frameToX(frame: number, view: WaveformView, width: number): number {
  return ((frame - view.startFrame) / view.visibleFrames) * width;
}

/** Pixel column → frame. The inverse of {@link frameToX}, unclamped for the same reason. */
export function xToFrame(x: number, view: WaveformView, width: number): number {
  if (width <= 0) return view.startFrame;
  return view.startFrame + (x / width) * view.visibleFrames;
}

/**
 * Zoom by `factor` (>1 widens, <1 tightens) keeping `anchorFrame` under the same pixel column.
 * Anchoring is what makes wheel-zoom feel attached to the pointer instead of to the file: the
 * anchor's fractional position across the window is measured before the scale and restored
 * after it.
 */
export function zoomView(
  view: WaveformView,
  totalFrames: number,
  factor: number,
  anchorFrame: number,
): WaveformView {
  const anchorFraction = clamp((anchorFrame - view.startFrame) / view.visibleFrames, 0, 1);
  const visibleFrames = view.visibleFrames * factor;
  return clampView({ startFrame: anchorFrame - anchorFraction * visibleFrames, visibleFrames }, totalFrames);
}

/** Translate the window by `deltaFrames`, clamped at both ends of the sample. */
export function scrollView(view: WaveformView, totalFrames: number, deltaFrames: number): WaveformView {
  return clampView({ ...view, startFrame: view.startFrame + deltaFrames }, totalFrames);
}

/**
 * Build a selection from the two ends of a drag (spec §8.5.4 region tools). The pair is ordered
 * and rounded, so dragging right-to-left selects the same region as left-to-right, and clamped
 * into the sample. A drag that covers less than one frame yields null rather than an empty
 * region — a click is not a selection, and `trim` rejects an empty range anyway.
 */
export function selectionFromDrag(
  anchorFrame: number,
  frame: number,
  totalFrames: number,
): SliceRegion | null {
  const a = clamp(Math.round(anchorFrame), 0, totalFrames);
  const b = clamp(Math.round(frame), 0, totalFrames);
  const startFrame = Math.min(a, b);
  const endFrame = Math.max(a, b);
  return endFrame > startFrame ? { startFrame, endFrame } : null;
}

/**
 * The index of the marker within `tolerancePx` of pixel column `x`, or −1. Used to decide
 * whether a press grabs an existing marker (drag/remove) or places a new one, so the tolerance
 * is in pixels: the grab target stays the same physical size at every zoom level.
 */
export function markerAtX(
  markers: readonly number[],
  x: number,
  view: WaveformView,
  width: number,
  tolerancePx: number,
): number {
  let best = -1;
  let bestDistance = tolerancePx;
  for (let i = 0; i < markers.length; i++) {
    const distance = Math.abs(frameToX(markers[i]!, view, width) - x);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}
