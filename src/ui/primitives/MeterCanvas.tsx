/**
 * MeterCanvas — spec §5.8 / §8.4. A DPR-aware canvas VU meter that reads its slot from
 * the shared meter loop ({@link meterScope}) and paints peak + rms with client-side
 * peak-hold and clip-latch. No React state drives the animation — the draw callback and
 * peak-hold live in refs, so re-renders are zero (spec §3.3). Per §8.4 it resizes via
 * `ResizeObserver` and skips painting while scrolled out of view. Presented to assistive tech
 * as a `meter` with a throttled `aria-valuenow` (spec §8.2).
 */
import { useEffect, useRef } from 'react';
import type { MeterReading } from '@/core/audio/metering';
import { meterScope } from './meterScope';

interface MeterCanvasProps {
  /** Channel id whose SAB slot to read (`master`, `track:<id>`, …). */
  meterId: string;
  label: string;
  className?: string;
}

const PEAK_HOLD_DECAY = 0.02; // per frame
const CLIP_THRESHOLD = 0.999;

export function MeterCanvas({ meterId, label, className }: MeterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const peakHold = useRef(0);
  const clipLatched = useRef(false);
  const ariaValue = useRef(0);
  const lastAria = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    // Resolve meter colours from the design tokens (spec §3.6 — no raw palette literals).
    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const rmsColour = token('--color-bb-ok', '#57d98a');
    const peakColour = token('--color-bb-warn', '#e8c249');
    const clipColour = token('--color-bb-danger', '#f0564a');

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    // Offscreen-culled idle state (spec §8.4). The shared loop keeps ticking for the meters
    // that *are* on screen, so a scrolled-away strip simply paints nothing: Mixer's pads tab
    // gives every assigned pad a meter inside a horizontal scroller, where only a handful are
    // ever in view. The loop resumes painting on the next frame after it scrolls back.
    let visible = true;
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
      },
      { threshold: 0 },
    );
    intersectionObserver.observe(canvas);

    const draw = (reading: MeterReading) => {
      if (!visible) return;
      const peak = Math.max(reading.peakL, reading.peakR);
      const rms = Math.max(reading.rmsL, reading.rmsR);
      peakHold.current = Math.max(peak, peakHold.current - PEAK_HOLD_DECAY);
      if (peak >= CLIP_THRESHOLD) clipLatched.current = true;

      const { width, height } = canvas;
      context.clearRect(0, 0, width, height);
      // rms body
      context.fillStyle = rmsColour;
      context.fillRect(0, height * (1 - rms), width, height * rms);
      // peak-hold line
      const y = height * (1 - peakHold.current);
      context.fillStyle = clipLatched.current ? clipColour : peakColour;
      context.fillRect(0, y, width, Math.max(1, height * 0.02));

      // Throttled aria-valuenow (~4 Hz), written directly — no React re-render.
      ariaValue.current = Math.round(Math.min(1, peak) * 100);
      const now = performance.now();
      if (now - lastAria.current > 250) {
        lastAria.current = now;
        meterRef.current?.setAttribute('aria-valuenow', String(ariaValue.current));
      }
    };

    const unsubscribe = meterScope.subscribe(meterId, draw);
    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
    };
  }, [meterId]);

  return (
    <div
      ref={meterRef}
      role="meter"
      aria-label={`${label} level`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      data-testid={`meter-${meterId}`}
      className={className ?? 'h-24 w-3 overflow-hidden rounded-bb-sm bg-bb-raised'}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
    </div>
  );
}
