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
