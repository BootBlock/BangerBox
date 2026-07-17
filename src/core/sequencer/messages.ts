/**
 * Scheduler worker message protocol — spec §7.1.3 (typed, versioned). The main thread
 * forwards transport/state changes in; the worker posts scheduled-event batches, capture
 * flushes and notifications out. Kinds and field names are naming-frozen (spec §13.6);
 * this is the sole definition of the contract, Zod-guarded at both boundaries (locked
 * decision §1.3 #11) exactly like the DB RPC bridge (`rpc.ts`, spec §13.6 reference rule).
 *
 * Protocol extensions beyond the §7.1.3 list are recorded in spec §14 (2026-07-17 (f)):
 * `sequenceMeta` (per-sequence length/tempo the worker needs to build the song tempo map,
 * §7.9), `liveNote.trackId` (record-capture destination), `eventsDiff.sequenceId` (the
 * owning sequence, needed to select a segment's tracks in song mode, §7.9), `liveErase`
 * request + `erased` response (MPC live erase, §7.7), and `ScheduledEvent.accented`
 * (metronome beat-1 accent, §5.9). New kinds extend the union; existing ones never change.
 */
import { z } from 'zod';
import {
  automationPointSchema,
  midiEventSchema,
  type AutomationPoint,
  type MidiEvent,
} from '@/core/project/schemas';
import type { NoteRepeatDivision } from './noteRepeat';

/** Protocol version — bumped on any breaking change to the message shapes (spec §7.1.3). */
export const SCHEDULER_PROTOCOL_VERSION = 1;

// --- Scheduled events (worker → main, spec §7.1.3) --------------------------------

export type ScheduledEventKind = 'noteOn' | 'noteOff' | 'click' | 'automationRamp';

/** One scheduled instruction the dispatcher turns into an audio-graph call (spec §7.1.4). */
export interface ScheduledEvent {
  readonly kind: ScheduledEventKind;
  /** Context seconds at which to act (exact `when` for the graph call, spec §7.1.4). */
  readonly when: number;
  /** Sequence tick this event corresponds to. */
  readonly tick: number;
  readonly trackId?: string;
  readonly note?: number;
  readonly velocity?: number;
  readonly durationSec?: number;
  /** Automation target address (spec §7.8) for `automationRamp`. */
  readonly target?: string;
  readonly value?: number;
  readonly rampEnd?: number;
  /** Metronome beat-1 accent (spec §5.9) for `click`. */
  readonly accented?: boolean;
}

/** Per-sequence metadata the worker needs for the song tempo map (spec §7.9, §14 ext). */
export interface SchedulerSequenceMeta {
  readonly lengthBars: number;
  readonly timeSigNumerator: number;
  readonly timeSigDenominator: 2 | 4 | 8 | 16;
  /** null = follow the project default tempo (spec §7.2). */
  readonly tempo: number | null;
}

// --- Main → worker requests (spec §7.1.3) -----------------------------------------

export type SchedulerRequest =
  | { readonly kind: 'init'; readonly playheadSab: SharedArrayBuffer }
  | { readonly kind: 'clockSync'; readonly contextTime: number; readonly performanceTime: number }
  | { readonly kind: 'transport'; readonly isPlaying: boolean; readonly isRecording: boolean; readonly startTick: number }
  | { readonly kind: 'tempo'; readonly bpm: number }
  | { readonly kind: 'swing'; readonly amount: number; readonly division: 8 | 16 }
  | { readonly kind: 'loop'; readonly enabled: boolean; readonly startTick: number; readonly endTick: number }
  | { readonly kind: 'eventsDiff'; readonly trackId: string; readonly sequenceId: string; readonly upserts: readonly MidiEvent[]; readonly deletes: readonly string[] }
  | { readonly kind: 'automationDiff'; readonly scope: AutomationPoint['scope']; readonly ownerId: string; readonly targetPath: string; readonly points: readonly AutomationPoint[] }
  | { readonly kind: 'songSequence'; readonly orderedSequenceIds: readonly string[] }
  | { readonly kind: 'sequenceMeta'; readonly sequences: Readonly<Record<string, SchedulerSequenceMeta>>; readonly projectBpm: number; readonly activeSequenceId: string | null; readonly playbackMode: 'sequence' | 'song' }
  | { readonly kind: 'liveNote'; readonly note: number; readonly velocity: number; readonly on: boolean; readonly timestamp: number; readonly trackId: string }
  | { readonly kind: 'noteRepeat'; readonly enabled: boolean; readonly division: NoteRepeatDivision }
  | { readonly kind: 'metronome'; readonly enabled: boolean; readonly countInBars: 0 | 1 | 2 }
  | { readonly kind: 'liveErase'; readonly trackId: string; readonly note: number; readonly active: boolean };

// --- Worker → main responses (spec §7.1.3) ----------------------------------------

export type SchedulerResponse =
  | { readonly kind: 'scheduleBatch'; readonly events: readonly ScheduledEvent[] }
  | { readonly kind: 'recorded'; readonly trackId: string; readonly events: readonly MidiEvent[] }
  | { readonly kind: 'erased'; readonly trackId: string; readonly eventIds: readonly string[] }
  | { readonly kind: 'loopWrapped'; readonly tick: number }
  | { readonly kind: 'songAdvanced'; readonly entryIndex: number };

// --- Zod guards (locked decision §1.3 #11) ----------------------------------------

const noteRepeatDivisionSchema = z.object({
  value: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64)]),
  triplet: z.boolean(),
});

const sequenceMetaSchema = z.object({
  lengthBars: z.number().int().min(1),
  timeSigNumerator: z.number().int().min(1),
  timeSigDenominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
  tempo: z.number().nullable(),
});

const schedulerRequestSchema: z.ZodType<SchedulerRequest> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('init'), playheadSab: z.instanceof(SharedArrayBuffer) }),
  z.object({ kind: z.literal('clockSync'), contextTime: z.number(), performanceTime: z.number() }),
  z.object({ kind: z.literal('transport'), isPlaying: z.boolean(), isRecording: z.boolean(), startTick: z.number() }),
  z.object({ kind: z.literal('tempo'), bpm: z.number() }),
  z.object({ kind: z.literal('swing'), amount: z.number(), division: z.union([z.literal(8), z.literal(16)]) }),
  z.object({ kind: z.literal('loop'), enabled: z.boolean(), startTick: z.number(), endTick: z.number() }),
  z.object({ kind: z.literal('eventsDiff'), trackId: z.string(), sequenceId: z.string(), upserts: z.array(midiEventSchema), deletes: z.array(z.string()) }),
  z.object({ kind: z.literal('automationDiff'), scope: z.enum(['sequence', 'track']), ownerId: z.string(), targetPath: z.string(), points: z.array(automationPointSchema) }),
  z.object({ kind: z.literal('songSequence'), orderedSequenceIds: z.array(z.string()) }),
  z.object({ kind: z.literal('sequenceMeta'), sequences: z.record(z.string(), sequenceMetaSchema), projectBpm: z.number(), activeSequenceId: z.string().nullable(), playbackMode: z.enum(['sequence', 'song']) }),
  z.object({ kind: z.literal('liveNote'), note: z.number().int(), velocity: z.number().int(), on: z.boolean(), timestamp: z.number(), trackId: z.string() }),
  z.object({ kind: z.literal('noteRepeat'), enabled: z.boolean(), division: noteRepeatDivisionSchema }),
  z.object({ kind: z.literal('metronome'), enabled: z.boolean(), countInBars: z.union([z.literal(0), z.literal(1), z.literal(2)]) }),
  z.object({ kind: z.literal('liveErase'), trackId: z.string(), note: z.number().int(), active: z.boolean() }),
]) as z.ZodType<SchedulerRequest>;

const scheduledEventSchema = z.object({
  kind: z.enum(['noteOn', 'noteOff', 'click', 'automationRamp']),
  when: z.number(),
  tick: z.number(),
  trackId: z.string().optional(),
  note: z.number().optional(),
  velocity: z.number().optional(),
  durationSec: z.number().optional(),
  target: z.string().optional(),
  value: z.number().optional(),
  rampEnd: z.number().optional(),
  accented: z.boolean().optional(),
});

const schedulerResponseSchema: z.ZodType<SchedulerResponse> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scheduleBatch'), events: z.array(scheduledEventSchema) }),
  z.object({ kind: z.literal('recorded'), trackId: z.string(), events: z.array(midiEventSchema) }),
  z.object({ kind: z.literal('erased'), trackId: z.string(), eventIds: z.array(z.string()) }),
  z.object({ kind: z.literal('loopWrapped'), tick: z.number() }),
  z.object({ kind: z.literal('songAdvanced'), entryIndex: z.number().int() }),
]) as z.ZodType<SchedulerResponse>;

/** Validate an inbound request inside the worker (spec §1.3 #11). */
export function parseSchedulerRequest(value: unknown): SchedulerRequest | null {
  const parsed = schedulerRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Validate an inbound response on the main thread (spec §1.3 #11). */
export function parseSchedulerResponse(value: unknown): SchedulerResponse | null {
  const parsed = schedulerResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
