/**
 * LooperRing — the Looper's capture progress ring (spec §8.5.8). Position within the
 * bar-locked loop is animation, not application state, so nothing here passes through React:
 * the panel binds the setter on mount and calls it from the capture drain loop, which writes
 * `strokeDashoffset` straight to the SVG (spec §3.3, and §8.4 — no second rAF loop).
 */
import { useCallback, useEffect, useRef } from 'react';

export interface LooperRingProps {
  /** Accessible name for the progress readout. */
  label: string;
  /**
   * Receives the progress setter on mount and null on unmount, so the owner can drive the
   * ring from wherever its capture loop runs.
   */
  bindSetter: (set: ((progress: number) => void) | null) => void;
}

const SIZE = 72;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** aria-valuenow refresh interval, matching MeterCanvas's throttle (spec §8.2). */
const ARIA_INTERVAL_MS = 250;

export function LooperRing({ label, bindSetter }: LooperRingProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const arcRef = useRef<SVGCircleElement | null>(null);
  const lastAria = useRef(0);

  const setProgress = useCallback((progress: number) => {
    const clamped = Math.min(1, Math.max(0, progress));
    arcRef.current?.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - clamped)));
    const now = performance.now();
    if (now - lastAria.current > ARIA_INTERVAL_MS) {
      lastAria.current = now;
      rootRef.current?.setAttribute('aria-valuenow', String(Math.round(clamped * 100)));
    }
  }, []);

  useEffect(() => {
    bindSetter(setProgress);
    return () => bindSetter(null);
  }, [bindSetter, setProgress]);

  return (
    <div
      ref={rootRef}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      data-testid="looper-ring"
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        {/* Rotated so the arc starts at twelve o'clock and fills clockwise. */}
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            className="stroke-bb-line"
          />
          <circle
            ref={arcRef}
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE}
            className="stroke-bb-accent"
          />
        </g>
      </svg>
    </div>
  );
}
