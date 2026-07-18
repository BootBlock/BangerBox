/**
 * WaveformCanvas primitive (spec §2.5, §8.4) — a DPR-aware `<canvas>` that draws a min/max peak
 * pyramid of a mono signal. Rendering happens on the canvas (never React DOM, spec §3.3), and the
 * reduction itself is done once per sample in the peak-pyramid worker (§8.5.4) — this component
 * only maps the cheapest sufficient pyramid level onto its own pixel columns, so drawing costs
 * the same whether the sample is one second or ten minutes long.
 *
 * This is the *static* waveform: the whole file, no interaction, used by Browser's per-row
 * micro-preview (§8.5.7) where a hundred rows must stay cheap. The zoom/selection/marker editor
 * is `WaveformEditor`, which shares this component's painting via `waveformDraw`.
 *
 * Per §8.4 the canvas resizes via `ResizeObserver` and skips redraws while scrolled out of view.
 * There is no rAF loop: a static waveform changes only when its pyramid or its size does, so it
 * redraws on those events instead of burning a frame budget re-painting an unchanging picture.
 */
import { useEffect, useRef } from 'react';
import type { PeakPyramid } from '@/core/audio/peakPyramid';
import { fullView } from '@/core/audio/waveformView';
import { drawWaveform, readWaveformTokens } from './waveformDraw';

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

  // The effect re-runs whenever the pyramid changes, so the observers set up here always close
  // over the current one — no ref mirror is needed to reach it from their callbacks.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const tokens = readWaveformTokens(canvas);
    let visible = true;

    const render = () => {
      if (!visible) return;
      const dpr = globalThis.devicePixelRatio || 1;
      // Measure the laid-out box rather than trusting a hardcoded fallback width, which would
      // silently paint at the wrong scale whenever the element is measured before layout.
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width * dpr));
      const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== pixelHeight) {
        canvas.width = width;
        canvas.height = pixelHeight;
      }
      drawWaveform(context, {
        pyramid,
        view: fullView(pyramid?.frames ?? 1),
        width,
        height: pixelHeight,
        tokens,
      });
    };

    render();
    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(canvas);

    // Offscreen-culled idle state (spec §8.4): a scrolled-away preview does no drawing, and
    // redraws once when it returns so it is never left stale after a resize it skipped.
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        const nowVisible = entries.some((entry) => entry.isIntersecting);
        const becameVisible = nowVisible && !visible;
        visible = nowVisible;
        if (becameVisible) render();
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    return () => {
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [pyramid, height]);

  return (
    <canvas
      ref={canvasRef}
      role={decorative ? 'presentation' : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : ariaLabel}
      className={className}
      style={{ height }}
    />
  );
}
