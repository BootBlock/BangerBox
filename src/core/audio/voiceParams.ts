/**
 * Program-scope parameter mapping (spec §6, §7.8) — resolves a registered
 * `program:<id>.pad:<idx>.<param>` address to the concrete change it makes.
 *
 * Two destinations exist, and telling them apart is the point of this module:
 *  - *per-voice* leaves (`filter.cutoff`, `filter.resonance`, `pitch`, `amp.attack`,
 *    `amp.release`) act on the voice itself — the first three on the nodes inside it
 *    (spec §5.2 stage 2), the last two on the §6 amp contour its own gain carries;
 *  - *channel* leaves (`amp`, `pan`) belong to the pad's mixer channel — applying those
 *    per voice would double them against the channel the voices already feed.
 *
 * The two envelope TIMES were mapped by nothing at all until issue #143, so a lane on either
 * was inert live and rendered as nothing, on addresses the §7.8 registry, the §8.5.2 lane
 * selector and §10.3's pad-mode defaults all advertise.
 *
 * Pure and node-free so it is unit-testable without a Web Audio context (spec §11.3).
 */

/** Cents per semitone — `AudioBufferSourceNode.detune` is expressed in cents. */
const CENTS_PER_SEMITONE = 100;

export type ProgramParamTarget =
  'filterFrequency' | 'filterQ' | 'detune' | 'ampAttack' | 'ampRelease' | 'channelLevel' | 'channelPan';

export interface ProgramParamChange {
  readonly target: ProgramParamTarget;
  readonly value: number;
}

/** The voice-pool pad key for a program/pad pair (spec §5.4 `${programId}:${padIndex}`). */
export function padKeyFor(programId: string, padIndex: number): string {
  return `${programId}:${padIndex}`;
}

/**
 * Resolve a registered program-scope leaf to its concrete change, or null when the leaf
 * is not one the registry exposes (spec §7.8 gate).
 */
export function programParamChange(param: string, value: number): ProgramParamChange | null {
  switch (param) {
    case 'filter.cutoff':
      return { target: 'filterFrequency', value };
    case 'filter.resonance':
      return { target: 'filterQ', value };
    case 'pitch':
      return { target: 'detune', value: value * CENTS_PER_SEMITONE };
    // The §6 AHDSR times, in the milliseconds §6 stores them in (issue #143).
    case 'amp.attack':
      return { target: 'ampAttack', value };
    case 'amp.release':
      return { target: 'ampRelease', value };
    case 'amp':
      return { target: 'channelLevel', value };
    case 'pan':
      return { target: 'channelPan', value };
    default:
      return null;
  }
}

/** True when a change targets the voice itself rather than the pad channel below it. */
export function isPerVoiceTarget(target: ProgramParamTarget): boolean {
  return target !== 'channelLevel' && target !== 'channelPan';
}
