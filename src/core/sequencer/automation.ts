/**
 * Automation engine maths — spec §7.8. Pure evaluation of hierarchical automation:
 * per-point interpolation (step / linear / exp), track-over-sequence resolution (track
 * scope wins for the same target while both exist), and the lookahead emission of
 * `automationRamp` events the dispatcher applies as AudioParam ramps (spec §7.8, §7.1.3).
 * Dependency-free (spec §7.1.5) so the curve maths is exhaustively unit-testable.
 */
import type { AutomationPoint } from '@/core/project/schemas';

/** Interpolate between two values by the segment's curve at fraction `t` (0..1). */
function interpolate(v0: number, v1: number, t: number, curve: AutomationPoint['curve']): number {
  if (curve === 'step') return v0;
  if (curve === 'exp' && v0 > 0 && v1 > 0) return v0 * (v1 / v0) ** t;
  return v0 + (v1 - v0) * t; // linear, and exp fallback when a value is non-positive
}

/**
 * Automation value at an absolute tick (spec §7.8). Points must be sorted by tick. Before
 * the first point the value holds at the first; after the last it holds at the last; within
 * a segment it follows the *earlier* point's curve. Empty ⇒ null (no automation to apply).
 */
export function automationValueAt(points: readonly AutomationPoint[], tick: number): number | null {
  if (points.length === 0) return null;
  if (tick <= points[0]!.tick) return points[0]!.value;
  const last = points[points.length - 1]!;
  if (tick >= last.tick) return last.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (tick >= a.tick && tick < b.tick) {
      const span = b.tick - a.tick;
      const t = span === 0 ? 0 : (tick - a.tick) / span;
      return interpolate(a.value, b.value, t, a.curve);
    }
  }
  return last.value;
}

/**
 * Effective points for a target (spec §7.8): the track-scope lane overrides the
 * sequence-scope lane entirely while it has any points; otherwise the sequence lane plays.
 */
export function resolveEffectivePoints(
  trackPoints: readonly AutomationPoint[] | undefined,
  sequencePoints: readonly AutomationPoint[] | undefined,
): readonly AutomationPoint[] {
  if (trackPoints && trackPoints.length > 0) return trackPoints;
  return sequencePoints ?? [];
}

/** An automation ramp scheduled for the dispatcher (spec §7.1.3 `automationRamp`). */
export interface AutomationRamp {
  readonly targetPath: string;
  readonly value: number;
  /** Context seconds at which the ramp begins. */
  readonly when: number;
  /** Context seconds at which the ramp reaches `value`. */
  readonly rampEnd: number;
}

/**
 * Emit the automation ramp for one lane over a lookahead window (spec §7.8). The param is
 * ramped toward the lane's value at the window's trailing edge, so as windows advance the
 * param tracks the automation curve at scheduler resolution. No points ⇒ no ramp (live
 * edits are left untouched). Ticks map to seconds through `tickToSeconds` (spec §7.2).
 */
export function automationRampForWindow(
  targetPath: string,
  points: readonly AutomationPoint[],
  fromTick: number,
  toTick: number,
  tickToSeconds: (tick: number) => number,
): AutomationRamp | null {
  if (points.length === 0 || toTick <= fromTick) return null;
  const value = automationValueAt(points, toTick);
  if (value === null) return null;
  return { targetPath, value, when: tickToSeconds(fromTick), rampEnd: tickToSeconds(toTick) };
}
