/**
 * Modulation-matrix evaluator — spec §6. A pure, dependency-free function (spec §6:
 * "the evaluator is a pure function with unit tests", §11.1) that sums the contribution
 * of every mod route into a per-target modulation amount. Evaluation is control-rate
 * (per voice start + per scheduled block, spec §6); the caller samples the source values
 * for the block and scales each target's result into physical units (cents for pitch,
 * octaves for filter cutoff, etc.) at application time — this module stays range-agnostic
 * so the algebra is trivially testable.
 *
 * Source polarity (spec §6): LFOs and per-note random are bipolar (−1..1); the envelope
 * levels, velocity and note number are unipolar (0..1). Route `amount` is −1..1. The
 * result for a target is Σ(sourceValue × amount) over its routes, left un-clamped so the
 * voice builder can clamp against each target's own range.
 */
import type { ModRoute, ModSource, ModTarget } from '@/core/project/schemas';

/** Instantaneous value of every modulation source for one evaluation (spec §6). */
export interface ModSourceValues {
  /** Bipolar oscillator output −1..1. */
  readonly lfo1: number;
  readonly lfo2: number;
  /** Unipolar envelope levels 0..1. */
  readonly ampEnv: number;
  readonly pitchEnv: number;
  readonly filterEnv: number;
  /** Unipolar hit velocity, velocity/127 → 0..1. */
  readonly velocity: number;
  /** Bipolar per-note random −1..1. */
  readonly random: number;
  /** Unipolar note number, note/127 → 0..1. */
  readonly noteNumber: number;
}

/** Summed modulation amount per target (spec §6); un-clamped, in normalised units. */
export type ModMatrixResult = Map<ModTarget, number>;

/**
 * Sum every route's `sourceValue × amount` into its target (spec §6). Targets with no
 * routes are absent from the result; a target with several routes carries their sum.
 */
export function evaluateModMatrix(routes: readonly ModRoute[], sources: ModSourceValues): ModMatrixResult {
  const result: ModMatrixResult = new Map();
  for (const route of routes) {
    const contribution = sources[route.source] * route.amount;
    if (contribution === 0) continue;
    result.set(route.target, (result.get(route.target) ?? 0) + contribution);
  }
  return result;
}

/** The subset of routes driven by a given source (e.g. wiring LFO oscillators) — spec §6. */
export function routesForSource(routes: readonly ModRoute[], source: ModSource): ModRoute[] {
  return routes.filter((route) => route.source === source);
}
