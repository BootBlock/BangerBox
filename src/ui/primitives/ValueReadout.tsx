/**
 * ValueReadout — a monospaced, tabular-numeral display for engine values (position, BPM,
 * PDC latency, storage). Tabular numerals stop the readout jittering as digits change,
 * which matters for a value updating several times a second (spec §8.3 tactility).
 *
 * `live` marks a readout that assistive tech should announce as it changes; it is off by
 * default because most readouts update far too often to announce (spec §8.2 — the single
 * polite LiveRegion carries transport/save announcements instead).
 */
import type { ReactNode } from 'react';
import { FieldLabel } from './FieldLabel';

export interface ValueReadoutProps {
  label: string;
  value: ReactNode;
  /** Show the label above the value rather than only to assistive tech. */
  showLabel?: boolean;
  live?: boolean;
  tone?: 'default' | 'accent' | 'muted';
  size?: 'sm' | 'md' | 'lg';
  'data-testid'?: string;
}

const TONE: Record<'default' | 'accent' | 'muted', string> = {
  default: 'text-bb-text',
  accent: 'text-bb-accent',
  muted: 'text-bb-muted',
};

const SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-xl',
};

export function ValueReadout({
  label,
  value,
  showLabel = false,
  live = false,
  tone = 'default',
  size = 'md',
  'data-testid': testId,
}: ValueReadoutProps) {
  return (
    <div className="flex flex-col gap-0.5">
      {showLabel && <FieldLabel as="span">{label}</FieldLabel>}
      {/* A <span>, deliberately not <output>: `output` carries an implicit `role="status"`,
          which would turn every readout in the app into a live region competing with the
          real announcer and the toasts (spec §8.2 — one polite LiveRegion). */}
      <span
        aria-label={showLabel ? undefined : label}
        aria-live={live ? 'polite' : undefined}
        data-testid={testId}
        className={`block rounded-bb-sm border border-bb-line bg-bb-raised px-2 py-1 font-mono tabular-nums ${SIZE[size]} ${TONE[tone]}`}
      >
        {value}
      </span>
    </div>
  );
}
