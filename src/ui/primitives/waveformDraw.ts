/**
 * Waveform canvas painting (spec §8.4) — the drawing shared by the static {@link WaveformCanvas}
 * and the interactive `WaveformEditor`, so one reduction is rendered one way everywhere (§3.6).
 *
 * Every routine takes an explicit {@link WaveformView}, which is what lets the editor zoom: the
 * column loop resolves each pixel to a frame range and reads whichever pyramid level backs that
 * range, rather than assuming the window is the whole file. Colours arrive as resolved token
 * strings from {@link readWaveformTokens} — canvas cannot consume a Tailwind utility, and §3.6
 * forbids a component inventing its own hex palette.
 */
import { levelForColumns, type PeakPyramid } from '@/core/audio/peakPyramid';
import type { SliceRegion } from '@/core/audio/chop';
import { frameToX, type WaveformView } from '@/core/audio/waveformView';

/** Resolved design-token colours for one canvas (spec §3.6 — no literals in components). */
export interface WaveformTokens {
  readonly bg: string;
  readonly line: string;
  readonly wave: string;
  readonly accent: string;
  readonly muted: string;
}

/**
 * Read the `--color-bb-*` tokens off a canvas element. The literals here are fallbacks only, for
 * the case where computed styles are unavailable (jsdom) — they mirror `src/styles/index.css`.
 */
export function readWaveformTokens(canvas: HTMLCanvasElement): WaveformTokens {
  const styles = getComputedStyle(canvas);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    bg: token('--color-bb-surface', '#1c1b21'),
    line: token('--color-bb-line', '#37343f'),
    wave: token('--color-bb-accent', '#f5a524'),
    accent: token('--color-bb-focus', '#61b8ff'),
    muted: token('--color-bb-muted', '#a3a1ad'),
  };
}

export interface DrawWaveformOptions {
  readonly pyramid: PeakPyramid | null;
  readonly view: WaveformView;
  /** Backing-store size in device pixels (already DPR-scaled by the caller). */
  readonly width: number;
  readonly height: number;
  readonly tokens: WaveformTokens;
}

/** Paint the background, zero line and min/max body of the visible window. */
export function drawWaveform(context: CanvasRenderingContext2D, options: DrawWaveformOptions): void {
  const { pyramid, view, width, height, tokens } = options;
  context.clearRect(0, 0, width, height);
  context.fillStyle = tokens.bg;
  context.fillRect(0, 0, width, height);

  const mid = height / 2;
  context.strokeStyle = tokens.line;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, mid);
  context.lineTo(width, mid);
  context.stroke();

  if (!pyramid || pyramid.frames === 0 || width <= 0) return;

  // Ask for the level fine enough for this *window*, not this file: zooming to a tenth of the
  // sample needs ten times the buckets across the whole pyramid to still fill every column.
  const columnsAcrossFile = (width * pyramid.frames) / Math.max(1, view.visibleFrames);
  const level = levelForColumns(pyramid, columnsAcrossFile);
  const framesPerColumn = view.visibleFrames / width;

  context.fillStyle = tokens.wave;
  for (let x = 0; x < width; x++) {
    const startFrame = view.startFrame + x * framesPerColumn;
    const startBucket = Math.floor(startFrame / level.bucketFrames);
    const endBucket = Math.max(
      startBucket + 1,
      Math.floor((startFrame + framesPerColumn) / level.bucketFrames),
    );
    let min = Infinity;
    let max = -Infinity;
    for (let bucket = startBucket; bucket < endBucket && bucket < level.min.length; bucket++) {
      if (bucket < 0) continue;
      const lo = level.min[bucket]!;
      const hi = level.max[bucket]!;
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    if (min === Infinity) continue; // column lies outside the sample
    const yTop = mid - max * mid;
    const yBottom = mid - min * mid;
    context.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
  }
}

/**
 * Shade the selected region and mark its two edges (spec §8.5.4 region tools). Drawn over the
 * waveform as a translucent wash so the audio under the selection stays readable.
 */
export function drawSelection(
  context: CanvasRenderingContext2D,
  selection: SliceRegion | null,
  options: Omit<DrawWaveformOptions, 'pyramid'>,
): void {
  if (!selection) return;
  const { view, width, height, tokens } = options;
  const x0 = frameToX(selection.startFrame, view, width);
  const x1 = frameToX(selection.endFrame, view, width);

  context.save();
  context.globalAlpha = 0.22;
  context.fillStyle = tokens.accent;
  context.fillRect(x0, 0, x1 - x0, height);
  context.restore();

  context.strokeStyle = tokens.accent;
  context.lineWidth = 2;
  for (const x of [x0, x1]) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
}

/**
 * Draw the manual chop markers (spec §8.5.4). `activeIndex` is the marker being dragged, drawn
 * in the accent colour so the grabbed one is distinguishable from its neighbours mid-gesture.
 */
export function drawMarkers(
  context: CanvasRenderingContext2D,
  markers: readonly number[],
  activeIndex: number,
  options: Omit<DrawWaveformOptions, 'pyramid'>,
): void {
  const { view, width, height, tokens } = options;
  context.lineWidth = 2;
  for (let i = 0; i < markers.length; i++) {
    const x = frameToX(markers[i]!, view, width);
    if (x < -2 || x > width + 2) continue;
    context.strokeStyle = i === activeIndex ? tokens.accent : tokens.muted;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
    // A flag at the top edge gives the marker a grab target the eye can find at any zoom.
    context.fillStyle = i === activeIndex ? tokens.accent : tokens.muted;
    context.fillRect(x, 0, 6, 6);
  }
}
