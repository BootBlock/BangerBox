/**
 * Sequence, track, event, automation and song-entry domain schemas (spec §4.2, §7,
 * §9.3). These are the camelCase runtime model held by `useSequenceStore`; the
 * hydration layer maps the snake_case rows (spec §9.3) onto them.
 */
import { z } from 'zod';
import {
  automationCurveSchema,
  automationScopeSchema,
  rangedInt,
  trackTypeSchema,
} from './primitives';
import {
  BPM_RANGE,
  LENGTH_BARS_RANGE,
  NOTE_RANGE,
  SWING_RANGE,
  TIME_SIG_NUMERATOR_RANGE,
  VELOCITY_RANGE,
} from './ranges';
import { ranged } from './primitives';

// --- MIDI event (spec §9.3 midi_events; keyed by trackId in the store) ------------
export const midiEventSchema = z.object({
  id: z.string(),
  tickStart: z.number().int().min(0),
  durationTicks: z.number().int().min(1), // spec §7.7 min duration 1 tick
  note: rangedInt(NOTE_RANGE),
  velocity: rangedInt(VELOCITY_RANGE),
  /** Reserved JSON (probability, provenance) — spec §9.3. */
  extra: z.record(z.string(), z.unknown()).nullable(),
});
export type MidiEvent = z.infer<typeof midiEventSchema>;

// --- Automation point (spec §7.8, §9.3 automation_points) ------------------------
export const automationPointSchema = z.object({
  id: z.string(),
  scope: automationScopeSchema,
  ownerId: z.string(),
  targetPath: z.string(),
  tick: z.number().int().min(0),
  value: z.number(),
  curve: automationCurveSchema,
});
export type AutomationPoint = z.infer<typeof automationPointSchema>;

/** Store key for an automation lane: `${scope}:${ownerId}:${targetPath}` (spec §4.2). */
export function automationLaneKey(scope: AutomationPoint['scope'], ownerId: string, targetPath: string): string {
  return `${scope}:${ownerId}:${targetPath}`;
}

// --- Sequence (spec §4.2, §9.3 sequences) ----------------------------------------
export const timeSignatureSchema = z.object({
  numerator: rangedInt(TIME_SIG_NUMERATOR_RANGE),
  denominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
});
export type TimeSignature = z.infer<typeof timeSignatureSchema>;

export const sequenceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  position: z.number().int().min(0),
  name: z.string(),
  lengthBars: rangedInt(LENGTH_BARS_RANGE),
  timeSig: timeSignatureSchema,
  /** null = follow the project default tempo (spec §7.2). */
  tempo: ranged(BPM_RANGE).nullable(),
  swingAmount: ranged(SWING_RANGE),
  swingDivision: z.union([z.literal(8), z.literal(16)]),
});
export type Sequence = z.infer<typeof sequenceSchema>;

// --- Track (spec §4.2, §9.3 tracks; mixer state lives in useMixerStore) ----------
export const trackSchema = z.object({
  id: z.string(),
  sequenceId: z.string(),
  programId: z.string().nullable(),
  position: z.number().int().min(0),
  name: z.string(),
  type: trackTypeSchema,
});
export type Track = z.infer<typeof trackSchema>;

// --- Song entry (spec §7.9, §9.3 song_entries) -----------------------------------
export const songEntrySchema = z.object({
  id: z.string(),
  position: z.number().int().min(0),
  sequenceId: z.string(),
  repeats: z.number().int().min(1),
});
export type SongEntry = z.infer<typeof songEntrySchema>;

// --- Default factories -----------------------------------------------------------
export function createDefaultSequence(
  projectId: string,
  position = 0,
  name = 'Sequence 1',
  id = crypto.randomUUID(),
): Sequence {
  return {
    id,
    projectId,
    position,
    name,
    lengthBars: 2,
    timeSig: { numerator: 4, denominator: 4 },
    tempo: null,
    swingAmount: 50,
    swingDivision: 16,
  };
}

export function createDefaultTrack(
  sequenceId: string,
  programId: string | null,
  position = 0,
  name = 'Track 1',
  type: Track['type'] = 'drum',
  id = crypto.randomUUID(),
): Track {
  return { id, sequenceId, programId, position, name, type };
}
