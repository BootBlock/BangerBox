/**
 * WaveformCanvas primitive (spec §2.5, §8.4) — a DPR-aware `<canvas>` that draws a min/max peak
 * pyramid of a mono signal. Rendering happens on the canvas (never React DOM, spec §3.3), and the
 * reduction itself is done once per sample in the peak-pyramid worker (§8.5.4) — this component
 * only maps the cheapest sufficient pyramid level onto its own pixel columns, so drawing costs
 * the same whether the sample is one second or ten minutes long.
 */
import { useEffect, useRef } from 'react';
import { levelForColumns, type PeakPyramid } from '@/core/audio/peakPyramid';

interface WaveformCanvasProps {
  /** The sample's cached peak pyramid, or null for an idle (empty) waveform. */
  readonly pyramid: PeakPyramid | null;
  readonly height?: number;
  readonly ariaLabel?: string;
  /** Extra classes for the canvas — Browser's micro-preview is a different shape to the editor. */
  readonly className?: string;
  /**
   * Hide from assistive tech (spec §8.2). Set where the waveform only illustrates a label that
   * is already announced — Browser's per-row micro-preview, whose row states the sample name.
   */
  readonly decorative?: boolean;
}

export function WaveformCanvas({
  pyramid,
  height = 96,
  ariaLabel = 'Sample waveform',
  className = 'h-24 w-full rounded-bb-sm border border-bb-line',
  decorative = false,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const dpr = globalThis.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 600;
    const width = Math.max(1, Math.floor(cssWidth * dpr));
    const pixelHeight = Math.floor(height * dpr);
    canvas.width = width;
    canvas.height = pixelHeight;

    context.clearRect(0, 0, width, pixelHeight);
    // Design tokens are CSS-only; read the resolved colours off the canvas element.
    const styles = getComputedStyle(canvas);
    context.fillStyle = styles.getPropertyValue('--wave-bg') || '#1b1a20';
    context.fillRect(0, 0, width, pixelHeight);
    const mid = pixelHeight / 2;
    context.strokeStyle = styles.getPropertyValue('--wave-mid') || '#3a3846';
    context.beginPath();
    context.moveTo(0, mid);
    context.lineTo(width, mid);
    context.stroke();

    if (!pyramid || pyramid.frames === 0) return;

    // Pick the coarsest level that still backs every pixel column with its own bucket, so a
    // 96 px micro-preview never walks the finest level of a ten-minute sample.
    const level = levelForColumns(pyramid, width);
    const bucketsPerColumn = level.min.length / width;

    context.fillStyle = styles.getPropertyValue('--wave-fg') || '#7c5cff';
    for (let x = 0; x < width; x++) {
      const start = Math.floor(x * bucketsPerColumn);
      const end = Math.max(start + 1, Math.floor((x + 1) * bucketsPerColumn));
      let min = Infinity;
      let max = -Infinity;
      for (let bucket = start; bucket < end && bucket < level.min.length; bucket++) {
        const lo = level.min[bucket]!;
        const hi = level.max[bucket]!;
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }
      if (min === Infinity) continue; // past the end of the pyramid
      const yTop = mid - max * mid;
      const yBottom = mid - min * mid;
      context.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
    }
  }, [pyramid, height]);

  return (
    <canvas
      ref={canvasRef}
      role={decorative ? 'presentation' : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : ariaLabel}
      className={className}
      style={{
        height,
        ['--wave-bg' as string]: '#1b1a20',
        ['--wave-mid' as string]: '#3a3846',
        ['--wave-fg' as string]: '#7c5cff',
      }}
    />
  );
}
