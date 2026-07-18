/**
 * Pure voice-allocation policy — spec §5.4. The runtime {@link VoicePool} owns the audio
 * nodes; these dependency-free functions decide *which* voice to steal and *which*
 * voices a trigger chokes, so the policy is exhaustively unit-testable without an
 * AudioContext (spec §11.1). No DOM/audio types leak in here.
 */

/** The minimal voice facts the allocation policy needs (spec §5.4). */
export interface VoiceRef {
  readonly id: string;
  /** Context time the voice started — lower is older. */
  readonly startTime: number;
  /** True once note-off has begun the release phase. */
  readonly released: boolean;
}

/**
 * Pick the voice to steal when the pool is exhausted (spec §5.4): the oldest *released*
 * voice if any are releasing, otherwise the oldest voice overall. Returns null for an
 * empty pool.
 */
export function selectStealVictim(voices: readonly VoiceRef[]): string | null {
  let oldestReleased: VoiceRef | null = null;
  let oldestOverall: VoiceRef | null = null;
  for (const voice of voices) {
    if (oldestOverall === null || voice.startTime < oldestOverall.startTime) oldestOverall = voice;
    if (voice.released && (oldestReleased === null || voice.startTime < oldestReleased.startTime)) {
      oldestReleased = voice;
    }
  }
  return (oldestReleased ?? oldestOverall)?.id ?? null;
}

/** A sounding voice tagged with the identity a choke test compares against (spec §5.4). */
export interface ChokeCandidate {
  readonly id: string;
  readonly programId: string;
  /** Pad identity `${programId}:${padIndex}` — voices of the same pad never choke. */
  readonly padKey: string;
  readonly chokeGroup: number;
}

/** The identity of the pad being triggered (spec §5.4). */
export interface ChokeTrigger {
  readonly programId: string;
  readonly padKey: string;
  readonly chokeGroup: number;
}

/**
 * The voices a trigger chokes (spec §5.4): a pad with `chokeGroup > 0` cuts all sounding
 * voices of *other* pads sharing that group *within the same program* (closed hat chokes
 * open hat). Group 0 chokes nothing.
 */
export function selectChokeVictims(active: readonly ChokeCandidate[], trigger: ChokeTrigger): string[] {
  if (trigger.chokeGroup <= 0) return [];
  return active
    .filter(
      (voice) =>
        voice.chokeGroup === trigger.chokeGroup &&
        voice.programId === trigger.programId &&
        voice.padKey !== trigger.padKey,
    )
    .map((voice) => voice.id);
}
