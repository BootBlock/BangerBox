/**
 * Pure value↔travel mapping shared by every continuous primitive (Knob, Fader,
 * XYSurface) — spec §3.1 permits shared math mappers, and keeping this DOM-free makes it
 * trivially unit-testable (spec §2.5). One implementation means the taper, stepping, and
 * `aria-valuetext` wording are identical across all controls, which is the
 * ZERO-DRY-violations rule for `src/ui/primitives/` (spec §3.6).
 */
import { clamp } from '@/core/math';
// The §8.5.6 fader law's single source of truth — the `faderLevel` domain below reads it
// rather than restating the taper (spec §3.6).
import { faderLevelToDb } from '@/core/audio/params/faderLaw';

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
 *
 * A NaN reads as an em dash rather than the literal "NaN", which a screen reader announces
 * verbatim (issue #97); a positive infinity reads as the infinity symbol.
 *
 * ## Units, and the four that are domains rather than units
 *
 * `dB`/`dBFS`, `Hz`, `%`, `ms`, `s`, `st`, `bpm` and anything else are plain units: the
 * number is already in them and the suffix is appended.
 *
 * Four tokens instead name the DOMAIN a raw control value lives in, because the number a
 * control stores is not the number a person reads (issue #35):
 *
 *   `pan`        a −1..1 position, read as "Centre" / "L 30" / "R 30"
 *   `fraction`   a 0..1 amount, read as a percentage — sends, mix, feedback, damping
 *   `faderLevel` a §8.5.6 fader position, read as dB through the one fader law
 *   `ratio`      a compression ratio, read as "4.0:1"
 *
 * They live here rather than as a `formatValue` callback at each call site because §8.2's
 * wording is a property of the parameter, not of the screen it appears on: the same send
 * has to read the same way on a Mixer knob and on an XYFX axis (spec §3.6).
 */
export function formatValueText(value: number, unit: string): string {
  // First, because the fader law owns what a non-finite POSITION means — true silence,
  // not the em dash a bare number would take (§8.5.6, issue #97). It is read, never
  // restated here.
  if (unit === 'faderLevel') return formatValueText(faderLevelToDb(value), 'dB');

  if (Number.isNaN(value)) return unit ? `— ${unit}` : '—';
  if (!Number.isFinite(value)) {
    const symbol = value < 0 ? `${MINUS}∞` : '∞';
    return unit ? `${symbol} ${unit}` : symbol;
  }

  // spec §8.2 wants a pan POSITION, not a signed fraction: "−0.3" says nothing about which
  // side of the image it is on, which is the only thing a pan control means.
  if (unit === 'pan') {
    const offset = Math.round(Math.abs(value) * 100);
    if (offset === 0) return 'Centre';
    return `${value < 0 ? 'L' : 'R'} ${offset}`;
  }
  if (unit === 'fraction') return withSign(`${Math.round(Math.abs(value) * 100)} %`, value < 0);
  if (unit === 'ratio') return `${Math.abs(value).toFixed(1)}:1`;

  const negative = value < 0;
  const magnitude = Math.abs(value);

  if (unit === 'Hz') {
    // The rounding happens BEFORE the kHz test, not after it: 999.6 rounds to 1000, which read
    // as "1000 Hz" and looked as though the abbreviation had simply failed (issue #97).
    if (Math.round(magnitude) >= 1000) return withSign(`${(magnitude / 1000).toFixed(1)} kHz`, negative);
    return withSign(`${Math.round(magnitude)} Hz`, negative);
  }
  if (unit === '%') return withSign(`${Math.round(magnitude)} %`, negative);
  // dBFS keeps its own suffix: §5.7 states the limiter's ceiling in it, and "dB" would
  // lose that it is measured against full scale rather than being a relative change.
  if (unit === 'dB' || unit === 'dBFS') return withSign(`${magnitude.toFixed(1)} ${unit}`, negative);

  // Everything else: integers stay integral, fractions keep one decimal place.
  const body = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
  return unit ? withSign(`${body} ${unit}`, negative) : withSign(body, negative);
}
