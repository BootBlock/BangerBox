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
 * voice builder can clamp against each target's own range — {@link clampModSum} and
 * {@link oscillatorDepthScale} are the two clamps that contract calls for (issue #76).
 */
import { clamp } from '@/core/math';
import { MOD_AMOUNT_RANGE, type ModRoute, type ModSource, type ModTarget } from '@/core/project/schemas';

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

/**
 * Clamp a summed target into the ±1 full scale every §6 target declares (issue #76).
 *
 * §6 caps the matrix at `MAX_MOD_ROUTES` (32) and each route's `amount` at ±1, but nothing
 * forbids all 32 routes pointing at one target — so a program that passes Zod validation, an
 * imported `.mpcweb` pack included (§9.6), can sum to ±32 full scale. At the pitch target
 * that is 32 octaves, which consumes the buffer in a fraction of a millisecond; at the amp
 * target it is 33× gain. One route at full amount with a full-scale source is what ±1 means,
 * so ±1 is the range the parameter declares and this is the clamp against it.
 *
 * A non-finite sum collapses to no modulation rather than to the range floor: a route whose
 * amount is somehow NaN should leave the sound alone, not detune it a full octave down.
 */
export function clampModSum(sum: number): number {
  if (!Number.isFinite(sum)) return 0;
  return clamp(sum, MOD_AMOUNT_RANGE[0], MOD_AMOUNT_RANGE[1]);
}

/** The §6 sources wired as live oscillators rather than folded into a static offset. */
const OSCILLATOR_SOURCES: readonly ModSource[] = ['lfo1', 'lfo2'];

/**
 * The factor every LFO route's depth onto `target` must be scaled by so their COMBINED
 * excursion stays inside ±1 full scale (issue #76).
 *
 * The static offsets sum to one number that {@link clampModSum} can clamp; LFO routes cannot,
 * because each is its own oscillator → gain → param and they sum in the audio graph, where
 * there is nothing to clamp them at. Scaling the depths in proportion is what bounds them:
 * the routes keep their relative weights, and the loudest combination they can reach is the
 * one a single full-depth route already reaches.
 *
 * Returns 1 when the routes already fit, so an ordinary one- or two-route patch is untouched.
 */
export function oscillatorDepthScale(routes: readonly ModRoute[], target: ModTarget): number {
  let total = 0;
  for (const route of routes) {
    if (route.target !== target || !OSCILLATOR_SOURCES.includes(route.source)) continue;
    if (!Number.isFinite(route.amount)) continue;
    total += Math.abs(route.amount);
  }
  return total > 1 ? 1 / total : 1;
}
