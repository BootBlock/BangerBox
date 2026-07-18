/**
 * Pure numeric helpers shared across the state layer (spec §3.1 permits clamp/scale
 * math mappers as shared utilities). Dependency-free so it is trivially unit-testable
 * (spec §2.5). Store actions clamp inputs into range before committing (spec §4.1);
 * the Zod schemas reject out-of-range payloads at the load/import boundary (spec §6).
 */

/** Clamp `value` into the inclusive range `[min, max]`. NaN collapses to `min`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp into the unit range `[0, 1]`. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Round to the nearest integer and clamp into `[min, max]` (inclusive). */
export function clampInt(value: number, min: number, max: number): number {
  return clamp(Math.round(value), min, max);
}

// --- Control taper (spec §3.1 shared math mappers) ---------------------------------
// One implementation of value↔normalised travel, shared by the UI primitives (spec §3.6
// ZERO DRY) and by the Q-Link encoder scaling (spec §10.3), which map the same curves.

export type ControlCurve = 'linear' | 'log';
export type ControlRange = readonly [number, number];

/** True when a logarithmic taper is representable — both ends must be strictly positive. */
function logTaperUsable(range: ControlRange, curve: ControlCurve): boolean {
  return curve === 'log' && range[0] > 0 && range[1] > 0;
}

/** Value → normalised travel (0..1). Out-of-range values clamp rather than extrapolate. */
export function valueToNormalised(value: number, range: ControlRange, curve: ControlCurve): number {
  const [min, max] = range;
  if (max === min) return 0;
  const bounded = clamp(value, Math.min(min, max), Math.max(min, max));
  if (logTaperUsable(range, curve)) {
    return clamp01(Math.log(bounded / min) / Math.log(max / min));
  }
  return clamp01((bounded - min) / (max - min));
}

/** Normalised travel (0..1) → value. The exact inverse of {@link valueToNormalised}. */
export function normalisedToValue(normalised: number, range: ControlRange, curve: ControlCurve): number {
  const [min, max] = range;
  const t = clamp01(normalised);
  if (logTaperUsable(range, curve)) {
    return min * (max / min) ** t;
  }
  return min + (max - min) * t;
}
