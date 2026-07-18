/**
 * Pure value↔travel mapping shared by every continuous primitive (Knob, Fader,
 * XYSurface) — spec §3.1 permits shared math mappers, and keeping this dependency-free
 * makes it trivially unit-testable (spec §2.5). One implementation means the taper,
 * stepping, and `aria-valuetext` wording are identical across all controls, which is the
 * ZERO-DRY-violations rule for `src/ui/primitives/` (spec §3.6).
 */
import { clamp } from '@/core/math';

// The taper itself lives in `@/core/math` so the Q-Link encoder scaling (spec §10.3) maps
// values through exactly the same curve the primitives draw (spec §3.6 ZERO DRY). It is
// re-exported here so every primitive keeps importing its maths from one module.
export { normalisedToValue, valueToNormalised, type ControlCurve, type ControlRange } from '@/core/math';
import type { ControlRange } from '@/core/math';

export interface StepOptions {
  readonly range: ControlRange;
  readonly step: number;
  /** Shift-held increment; defaults to a tenth of `step` (spec §8.2 "fine with Shift"). */
  readonly fineStep?: number;
  readonly fine?: boolean;
}

/** Arrow-key increment: `direction` is +1/−1, clamped into range (spec §8.2). */
export function stepValue(value: number, direction: number, options: StepOptions): number {
  const { range, step, fineStep, fine } = options;
  const increment = fine ? (fineStep ?? step / 10) : step;
  const min = Math.min(range[0], range[1]);
  const max = Math.max(range[0], range[1]);
  return clamp(value + increment * Math.sign(direction), min, max);
}

/** Snap a value onto the step lattice anchored at the range floor. `step ≤ 0` disables. */
export function quantiseToStep(value: number, range: ControlRange, step: number): number {
  if (!(step > 0)) return value;
  const min = Math.min(range[0], range[1]);
  const max = Math.max(range[0], range[1]);
  return clamp(min + Math.round((value - min) / step) * step, min, max);
}

/** en-GB minus sign (U+2212) — typographically correct, and what `Intl` emits (spec §1.3.1). */
const MINUS = '−';

function withSign(text: string, negative: boolean): string {
  return negative ? `${MINUS}${text}` : text;
}

/**
 * Human-readable `aria-valuetext` (spec §8.2 — "−6.0 dB", "1.2 kHz"). Unit-aware:
 * hertz abbreviates to kHz above 1 kHz, percentages read as integers, and a −∞ dB
 * fader (true silence, §8.5.6 fader law) reads as "−∞ dB" rather than a huge number.
 */
export function formatValueText(value: number, unit: string): string {
  if (value === Number.NEGATIVE_INFINITY) return unit ? `${MINUS}∞ ${unit}` : `${MINUS}∞`;
  const negative = value < 0;
  const magnitude = Math.abs(value);

  if (unit === 'Hz') {
    if (magnitude >= 1000) return withSign(`${(magnitude / 1000).toFixed(1)} kHz`, negative);
    return withSign(`${Math.round(magnitude)} Hz`, negative);
  }
  if (unit === '%') return withSign(`${Math.round(magnitude)} %`, negative);
  if (unit === 'dB') return withSign(`${magnitude.toFixed(1)} dB`, negative);

  // Everything else: integers stay integral, fractions keep one decimal place.
  const body = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
  return unit ? withSign(`${body} ${unit}`, negative) : withSign(body, negative);
}
