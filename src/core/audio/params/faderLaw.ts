/**
 * Fader law — spec §8.5.6 ("dB law: −∞..+6 dB mapped perceptually"). The mixer strip
 * `level` field is a 0..1.2 fader position (spec §4.2, `LEVEL_RANGE`); this is the sole
 * pure mapping from that position to a linear `GainNode` gain, so the perceptual taper
 * lives in one place and stays swappable (spec §3.1, YAGNI). Used by the graph channel
 * builders (§5.2) and the sync-layer bridge (§4.3).
 *
 * Shape: position 1.0 is unity (0 dB); the top of the fader (1.2) is +6 dB; below unity
 * the travel is linear-in-dB down to a −60 dB floor, and the very bottom is true silence
 * (−∞ dB, gain 0) — a fader pulled fully down mutes rather than leaving a residual.
 *
 * The input is CLAMPED into `LEVEL_RANGE` rather than extrapolated, and a non-finite level
 * reads as true silence (issue #97). This is the last function before a `GainNode.gain`:
 * un-clamped, position 2.0 extrapolated to +30 dB and a NaN position returned NaN, which
 * silences the graph for the rest of the session. Silence is the safe answer for a level
 * nobody can interpret — it is recoverable by moving the fader, where a poisoned param is not.
 */
import { clamp } from '@/core/math';
import { LEVEL_RANGE } from '@/core/project/schemas';

/** dB at the top of the fader (level = `LEVEL_RANGE[1]` = 1.2) — spec §8.5.6. */
export const FADER_MAX_DB = 6;
/** Unity-gain fader position (0 dB). Matches the neutral strip default (spec §4.2). */
const FADER_UNITY_LEVEL = 1;
/** Perceptual floor: the lowest audible dB before the fader snaps to true silence. */
export const FADER_FLOOR_DB = -60;

/** Linear gain for a dB value; −∞ ⇒ 0 (true silence), and so does any non-finite dB. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return 10 ** (db / 20);
}

/** Fader position (0..1.2) → dB. `level ≤ 0`, and anything non-finite, is −∞ (true silence). */
export function faderLevelToDb(rawLevel: number): number {
  if (!Number.isFinite(rawLevel)) return Number.NEGATIVE_INFINITY;
  const level = clamp(rawLevel, LEVEL_RANGE[0], LEVEL_RANGE[1]);
  if (level <= 0) return Number.NEGATIVE_INFINITY;
  if (level >= FADER_UNITY_LEVEL) {
    // Unity..top maps linearly 0..+6 dB across [1.0, LEVEL_RANGE[1]].
    const span = LEVEL_RANGE[1] - FADER_UNITY_LEVEL;
    return (FADER_MAX_DB * (level - FADER_UNITY_LEVEL)) / span;
  }
  // Below unity: linear-in-dB from 0 dB (at 1.0) down to the floor (at 0).
  return FADER_FLOOR_DB * (1 - level);
}

/** Fader position (0..1.2) → linear `GainNode` gain. */
export function faderLevelToGain(level: number): number {
  return dbToGain(faderLevelToDb(level));
}
