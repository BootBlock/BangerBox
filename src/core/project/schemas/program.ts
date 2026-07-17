/**
 * Program, pad and sound-design schemas — the §6 data model. All program payloads are
 * plain JSON (stored in `programs.payload`, spec §9.3), Zod-validated on load and import
 * (spec §6). British spelling throughout (spec §3.7).
 */
import { z } from 'zod';
import { nonNegative, noteDivisionSchema, playbackModeSchema, ranged, rangedInt } from './primitives';
import { insertSlotSchema, sendLevelsSchema, type InsertSlotState } from './mixer';
import {
  CHOKE_GROUP_RANGE,
  ENVELOPE_LEVEL_RANGE,
  FILTER_CUTOFF_RANGE,
  FILTER_ENV_DEPTH_RANGE,
  FILTER_RESONANCE_RANGE,
  GAIN_DB_RANGE,
  LEVEL_RANGE,
  LFO_PHASE_RANGE,
  LFO_RATE_RANGE,
  MAX_MOD_ROUTES,
  MAX_VELOCITY_LAYERS,
  NOTE_RANGE,
  PAD_INDEX_RANGE,
  PAN_RANGE,
  PITCH_BEND_RANGE_SEMITONES,
  PITCH_ENV_SEMITONES_RANGE,
  POLYPHONY_RANGE,
  ROOT_NOTE_RANGE,
  TUNE_CENTS_RANGE,
  TUNE_SEMITONES_RANGE,
} from './ranges';

// --- Envelopes (spec §6 AhdsrEnvelope) -------------------------------------------
export const ahdsrEnvelopeSchema = z.object({
  attack: nonNegative,
  hold: nonNegative,
  decay: nonNegative,
  sustain: ranged(ENVELOPE_LEVEL_RANGE),
  release: nonNegative,
  curve: z.enum(['linear', 'exponential']),
});
export type AhdsrEnvelope = z.infer<typeof ahdsrEnvelopeSchema>;

export const envelopesSchema = z.object({
  amp: ahdsrEnvelopeSchema,
  pitch: ahdsrEnvelopeSchema,
  filter: ahdsrEnvelopeSchema,
});
export type Envelopes = z.infer<typeof envelopesSchema>;

// --- LFOs (spec §6 LfoConfig) ----------------------------------------------------
export const lfoConfigSchema = z.object({
  rate: ranged(LFO_RATE_RANGE),
  sync: z.union([z.literal('free'), noteDivisionSchema]),
  shape: z.enum(['sine', 'triangle', 'sawUp', 'sawDown', 'square', 'sampleHold', 'drift']),
  phaseOffset: ranged(LFO_PHASE_RANGE),
  retrigger: z.boolean(),
});
export type LfoConfig = z.infer<typeof lfoConfigSchema>;

// --- Modulation matrix (spec §6 ModSource/ModTarget/ModRoute) ---------------------
export const modSourceSchema = z.enum([
  'lfo1',
  'lfo2',
  'ampEnv',
  'pitchEnv',
  'filterEnv',
  'velocity',
  'random',
  'noteNumber',
]);
export type ModSource = z.infer<typeof modSourceSchema>;

const FIXED_MOD_TARGETS = [
  'pitch',
  'filterCutoff',
  'filterResonance',
  'pan',
  'amp',
  'layerStart',
  'lfo1Rate',
  'lfo2Rate',
] as const;
/** Insert-parameter target address form, e.g. `insert2:cutoff` (spec §6). */
const INSERT_TARGET_PATTERN = /^insert[1-4]:.+$/;
export type ModTarget = (typeof FIXED_MOD_TARGETS)[number] | `insert${1 | 2 | 3 | 4}:${string}`;

function isModTarget(value: string): value is ModTarget {
  return (FIXED_MOD_TARGETS as readonly string[]).includes(value) || INSERT_TARGET_PATTERN.test(value);
}

export const modTargetSchema = z
  .string()
  .refine(isModTarget, 'Unknown modulation target') as unknown as z.ZodType<ModTarget>;

export const modRouteSchema = z.object({
  source: modSourceSchema,
  target: modTargetSchema,
  amount: ranged([-1, 1]),
});
export type ModRoute = z.infer<typeof modRouteSchema>;

// --- Velocity layers (spec §6 VelocityLayer) -------------------------------------
export const velocityLayerSchema = z.object({
  sampleId: z.string(),
  velocityStart: rangedInt([0, 127]),
  velocityEnd: rangedInt([0, 127]),
  tuneSemitones: ranged(TUNE_SEMITONES_RANGE),
  tuneCents: ranged(TUNE_CENTS_RANGE),
  gainDb: ranged(GAIN_DB_RANGE),
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
  reverse: z.boolean(),
});
export type VelocityLayer = z.infer<typeof velocityLayerSchema>;

// --- Filter + pad mixer sub-objects ----------------------------------------------
export const padFilterSchema = z.object({
  type: z.enum(['lp', 'hp', 'bp', 'off']),
  cutoff: ranged(FILTER_CUTOFF_RANGE),
  resonance: ranged(FILTER_RESONANCE_RANGE),
  envDepth: ranged(FILTER_ENV_DEPTH_RANGE),
});
export type PadFilter = z.infer<typeof padFilterSchema>;

const padMixerSchema = z.object({
  level: ranged(LEVEL_RANGE),
  pan: ranged(PAN_RANGE),
  sendLevels: sendLevelsSchema,
});

// --- Pad (spec §6 Pad) -----------------------------------------------------------
export const padSchema = z.object({
  padIndex: rangedInt(PAD_INDEX_RANGE),
  name: z.string(),
  chokeGroup: rangedInt(CHOKE_GROUP_RANGE),
  playbackMode: playbackModeSchema,
  warp: z.boolean(),
  layers: z.array(velocityLayerSchema).max(MAX_VELOCITY_LAYERS),
  envelopes: envelopesSchema,
  pitchEnvSemitones: ranged(PITCH_ENV_SEMITONES_RANGE),
  filter: padFilterSchema,
  lfos: z.tuple([lfoConfigSchema, lfoConfigSchema]),
  modMatrix: z.array(modRouteSchema).max(MAX_MOD_ROUTES),
  mixer: padMixerSchema,
  inserts: z.array(insertSlotSchema),
});
export type Pad = z.infer<typeof padSchema>;

// --- Programs (spec §6 DrumProgram / KeygroupProgram) ----------------------------
export const drumProgramSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('drum'),
  pads: z.array(padSchema),
});
export type DrumProgram = z.infer<typeof drumProgramSchema>;

export const keygroupZoneSchema = z.object({
  sampleId: z.string(),
  rootNote: rangedInt(ROOT_NOTE_RANGE),
  lowNote: rangedInt(NOTE_RANGE),
  highNote: rangedInt(NOTE_RANGE),
  lowVelocity: rangedInt([0, 127]),
  highVelocity: rangedInt([0, 127]),
  tuneCents: ranged(TUNE_CENTS_RANGE),
  gainDb: ranged(GAIN_DB_RANGE),
});
export type KeygroupZone = z.infer<typeof keygroupZoneSchema>;

export const keygroupProgramSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.literal('keygroup'),
  zones: z.array(keygroupZoneSchema),
  envelopes: envelopesSchema,
  filter: padFilterSchema,
  lfos: z.tuple([lfoConfigSchema, lfoConfigSchema]),
  modMatrix: z.array(modRouteSchema).max(MAX_MOD_ROUTES),
  mixer: padMixerSchema,
  inserts: z.array(insertSlotSchema),
  polyphony: rangedInt(POLYPHONY_RANGE),
  glideMs: nonNegative,
  pitchBendRange: ranged(PITCH_BEND_RANGE_SEMITONES),
});
export type KeygroupProgram = z.infer<typeof keygroupProgramSchema>;

export const programSchema = z.discriminatedUnion('type', [drumProgramSchema, keygroupProgramSchema]);
export type Program = z.infer<typeof programSchema>;

// --- Default factories (used by newProject and the program editor) ----------------
export function createDefaultEnvelope(overrides: Partial<AhdsrEnvelope> = {}): AhdsrEnvelope {
  return { attack: 1, hold: 0, decay: 60, sustain: 0.8, release: 120, curve: 'exponential', ...overrides };
}

export function createDefaultLfo(): LfoConfig {
  return { rate: 1, sync: 'free', shape: 'sine', phaseOffset: 0, retrigger: true };
}

function createDefaultEnvelopes(): Envelopes {
  return {
    amp: createDefaultEnvelope(),
    // A neutral (flat) pitch/filter envelope: full sustain, no depth applied by default.
    pitch: createDefaultEnvelope({ attack: 0, decay: 0, sustain: 1, release: 0, curve: 'linear' }),
    filter: createDefaultEnvelope({ attack: 0, decay: 0, sustain: 1, release: 0, curve: 'linear' }),
  };
}

function createDefaultInsertSlots(count = 4): InsertSlotState[] {
  return Array.from({ length: count }, () => ({
    id: crypto.randomUUID(),
    effectType: null,
    enabled: false,
    params: {},
  }));
}

/** An unassigned pad (no sample layers) at the given index — the neutral default (spec §6). */
export function createDefaultPad(padIndex: number, name = `Pad ${padIndex + 1}`): Pad {
  return {
    padIndex,
    name,
    chokeGroup: 0,
    playbackMode: 'poly',
    warp: false,
    layers: [],
    envelopes: createDefaultEnvelopes(),
    pitchEnvSemitones: 0,
    filter: { type: 'off', cutoff: 20_000, resonance: 0.7, envDepth: 0 },
    lfos: [createDefaultLfo(), createDefaultLfo()],
    modMatrix: [],
    mixer: { level: 1, pan: 0, sendLevels: [0, 0, 0, 0] },
    inserts: createDefaultInsertSlots(),
  };
}

/** A drum program with no assigned pads (sparse — pads are added on assignment, spec §6). */
export function createDefaultDrumProgram(name = 'Drum Program', id = crypto.randomUUID()): DrumProgram {
  return { id, name, type: 'drum', pads: [] };
}

/** A keygroup program with no zones (spec §6). */
export function createDefaultKeygroupProgram(
  name = 'Keygroup Program',
  id = crypto.randomUUID(),
): KeygroupProgram {
  return {
    id,
    name,
    type: 'keygroup',
    zones: [],
    envelopes: createDefaultEnvelopes(),
    filter: { type: 'off', cutoff: 20_000, resonance: 0.7, envDepth: 0 },
    lfos: [createDefaultLfo(), createDefaultLfo()],
    modMatrix: [],
    mixer: { level: 1, pan: 0, sendLevels: [0, 0, 0, 0] },
    inserts: createDefaultInsertSlots(),
    polyphony: 16,
    glideMs: 0,
    pitchBendRange: 2, // spec §6 default ±2 semitones
  };
}
