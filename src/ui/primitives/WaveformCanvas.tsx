/**
 * WaveformCanvas primitive (spec §2.5, §8.4) — a DPR-aware `<canvas>` that draws a min/max peak
 * pyramid of a mono signal. Rendering happens on the canvas (never React DOM, spec §3.3); the
 * peaks are computed once per data change, not per frame. The full worker-computed pyramid cache
 * for very long files (spec §8.5.4) is a Phase 7 refinement; this draws the decoded peaks
 * directly, which is ample for the functional editor.
 */
import { useEffect, useRef } from 'react';

interface WaveformCanvasProps {
  /** Mono samples to visualise, or null for an idle (empty) waveform. */
  readonly samples: Float32Array | null;
  readonly height?: number;
  readonly ariaLabel?: string;
}

export function WaveformCanvas({ samples, height = 96, ariaLabel = 'Sample waveform' }: WaveformCanvasProps) {
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

    if (!samples || samples.length === 0) return;

    context.fillStyle = styles.getPropertyValue('--wave-fg') || '#7c5cff';
    const perColumn = Math.max(1, Math.floor(samples.length / width));
    for (let x = 0; x < width; x++) {
      let min = 1;
      let max = -1;
      const start = x * perColumn;
      for (let i = 0; i < perColumn && start + i < samples.length; i++) {
        const value = samples[start + i]!;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      const yTop = mid - max * mid;
      const yBottom = mid - min * mid;
      context.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
    }
  }, [samples, height]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      className="h-24 w-full rounded-bb-sm border border-bb-line"
      style={{
        height,
        ['--wave-bg' as string]: '#1b1a20',
        ['--wave-mid' as string]: '#3a3846',
        ['--wave-fg' as string]: '#7c5cff',
      }}
    />
  );
}
