/**
 * Scheduler worker message protocol — spec §7.1.3 (typed, versioned). The main thread
 * forwards transport/state changes in; the worker posts scheduled-event batches, capture
 * flushes and notifications out. Kinds and field names are naming-frozen (spec §13.6);
 * this is the sole definition of the contract, Zod-guarded at both boundaries (locked
 * decision §1.3 #11) exactly like the DB RPC bridge (`rpc.ts`, spec §13.6 reference rule).
 *
 * Protocol extensions beyond the §7.1.3 list are recorded in spec §14 (2026-07-17 (f)):
 * `ScheduledEvent.bpm` (the tempo a note is scheduled at, §7.2/§7.9),
 * `sequenceMeta` (per-sequence length/tempo the worker needs to build the song tempo map,
 * §7.9), `liveNote.trackId` (record-capture destination), `eventsDiff.sequenceId` (the
 * owning sequence, needed to select a segment's tracks in song mode, §7.9), `liveErase`
 * request + `erased` response (MPC live erase, §7.7), and `ScheduledEvent.accented`
 * (metronome beat-1 accent, §5.9), and the `arp` request (keygroup arpeggiator, §7.3;
 * spec §14 2026-07-17 (g)). The `songLoop` request and the `songEnded` response carry
 * §7.9's end of song. New kinds extend the union; existing ones never change.
 *
 * The Zod unions below are NOT cast to their TypeScript counterparts: the annotation on
 * each `const` is the only thing that makes the compiler check the two for exhaustiveness,
 * and a redundant `as` suppressed exactly that — which is how `groove` reached production
 * as a typed sender with no schema member and every groove message was dropped (issue #71).
 */
import { z } from 'zod';
import {
  automationPointSchema,
  BPM_RANGE,
  midiEventSchema,
  ranged,
  SONG_REPEATS_MIN,
  SWING_RANGE,
  type AutomationPoint,
  type MidiEvent,
} from '@/core/project/schemas';
import type { NoteRepeatDivision } from './noteRepeat';
import { grooveTemplateSchema, type GrooveTemplate } from './groove';
import type { ArpMode } from './arpeggiator';

/**
 * Protocol version — bumped on any breaking change to the message shapes (spec §7.1.3).
 *
 * It rides the `init` handshake and the worker compares it against its own copy, which is
 * the whole reason it exists: a version nothing attaches and nothing checks cannot detect
 * the skew it is named for (issue #96). Adding a request or response kind does NOT bump it
 * — the established rule is extend-by-adding-kinds, never repurpose one (spec §14
 * 2026-07-17 (f), (g), (i)) — so a newer main thread and an older worker still agree about
 * every kind they both know.
 *
 * **2 (issue #130):** `songSequence` carries §7.9's position-sorted ENTRIES with their
 * repeat counts instead of a repeat-expanded id list. That is the first change to an
 * existing kind's shape rather than an addition, so it is the first thing the version has
 * ever had to name — an older peer's `orderedSequenceIds` no longer parses, and without the
 * bump the only symptom would be a silent guard rejection and a song that never starts.
 *
 * A mismatch is REPORTED, not enforced. The two halves are emitted by one Vite build and
 * loaded from one page, so skew is not reachable today; and refusing to start would turn a
 * partial disagreement into a dead transport, where the §1.3 #11 Zod guards already drop
 * exactly the messages the worker cannot understand. What the check buys is a NAME for
 * that silence — the §11.4 smoke fails on any console error, so a skew would fail the gate
 * rather than present as a sequencer that quietly does nothing (issue #71's shape).
 */
export const SCHEDULER_PROTOCOL_VERSION = 2;

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
  /**
   * Effective tempo of the note, in BPM (spec §7.2). Song mode plays sequences at their
   * own tempi (spec §7.9), so the transport's own `bpm` is not the tempo every note sounds
   * at — and a §6 tempo-synced LFO resolved against it would run at the wrong rate for
   * every segment whose sequence carries a tempo of its own.
   */
  readonly bpm?: number;
}

/**
 * One §7.9 playlist entry as the worker receives it (issue #130).
 *
 * The list is POSITION-SORTED by the sender and its index is what `songAdvanced` reports,
 * so an entry consumes exactly one index however many times it repeats and the worker
 * expands `repeats` itself. Sending a repeat-expanded id list instead made a `repeats: 2`
 * entry consume two indices, which §7.9 forbids. It carries neither `id` nor `position`:
 * the map is built from the order, and a field the worker cannot use is one more thing
 * that can disagree with the store.
 */
export interface SchedulerSongEntry {
  readonly sequenceId: string;
  readonly repeats: number;
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
  | {
      readonly kind: 'init';
      readonly playheadSab: SharedArrayBuffer;
      /**
       * The sender's {@link SCHEDULER_PROTOCOL_VERSION}, compared by the worker.
       *
       * OPTIONAL on purpose, and the one field in this protocol that is. The version exists
       * to NAME a skew, and a required field would have the guard drop the handshake of the
       * very build it is meant to name — leaving the SAB uninstalled, the transport dead and
       * nothing said, which is the outcome the check was added to prevent. This build always
       * sends it; a peer that does not is reported like any other mismatch.
       */
      readonly protocolVersion?: number;
    }
  | { readonly kind: 'clockSync'; readonly contextTime: number; readonly performanceTime: number }
  | {
      readonly kind: 'transport';
      readonly isPlaying: boolean;
      readonly isRecording: boolean;
      readonly startTick: number;
    }
  | { readonly kind: 'tempo'; readonly bpm: number }
  | { readonly kind: 'swing'; readonly amount: number; readonly division: 8 | 16 }
  | { readonly kind: 'loop'; readonly enabled: boolean; readonly startTick: number; readonly endTick: number }
  | { readonly kind: 'groove'; readonly trackId: string; readonly template: GrooveTemplate | null }
  | {
      readonly kind: 'eventsDiff';
      readonly trackId: string;
      readonly sequenceId: string;
      readonly upserts: readonly MidiEvent[];
      readonly deletes: readonly string[];
    }
  | {
      readonly kind: 'automationDiff';
      readonly scope: AutomationPoint['scope'];
      readonly ownerId: string;
      readonly targetPath: string;
      readonly points: readonly AutomationPoint[];
    }
  | { readonly kind: 'songSequence'; readonly orderedEntries: readonly SchedulerSongEntry[] }
  | { readonly kind: 'songLoop'; readonly enabled: boolean }
  | {
      readonly kind: 'sequenceMeta';
      readonly sequences: Readonly<Record<string, SchedulerSequenceMeta>>;
      readonly projectBpm: number;
      readonly activeSequenceId: string | null;
      readonly playbackMode: 'sequence' | 'song';
    }
  | {
      readonly kind: 'liveNote';
      readonly note: number;
      readonly velocity: number;
      readonly on: boolean;
      readonly timestamp: number;
      readonly trackId: string;
    }
  | { readonly kind: 'noteRepeat'; readonly enabled: boolean; readonly division: NoteRepeatDivision }
  | {
      readonly kind: 'arp';
      readonly enabled: boolean;
      readonly mode: ArpMode;
      readonly octaves: number;
      readonly gate: number;
      readonly division: NoteRepeatDivision;
    }
  | { readonly kind: 'metronome'; readonly enabled: boolean; readonly countInBars: 0 | 1 | 2 }
  | { readonly kind: 'liveErase'; readonly trackId: string; readonly note: number; readonly active: boolean };

// --- Worker → main responses (spec §7.1.3) ----------------------------------------

export type SchedulerResponse =
  | { readonly kind: 'scheduleBatch'; readonly events: readonly ScheduledEvent[] }
  | { readonly kind: 'recorded'; readonly trackId: string; readonly events: readonly MidiEvent[] }
  | { readonly kind: 'erased'; readonly trackId: string; readonly eventIds: readonly string[] }
  | { readonly kind: 'loopWrapped'; readonly tick: number }
  | { readonly kind: 'songAdvanced'; readonly entryIndex: number }
  | { readonly kind: 'songEnded' };

// --- Zod guards (locked decision §1.3 #11) ----------------------------------------

const noteRepeatDivisionSchema = z.object({
  value: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32), z.literal(64)]),
  triplet: z.boolean(),
});

/**
 * An entity id crossing into the worker (spec §1.3.1) — and the ONE place the colon-free
 * invariant those ids rest on is checked (issue #96).
 *
 * `SchedulerCore` keys three of its maps `${trackId}:${note}` and its automation lanes
 * `${scope}:${ownerId}:${targetPath}`, then splits them apart again. §7.8 target paths
 * CONTAIN colons of their own (`mixer.pad:<prog>:<idx>.sendLevels.2`,
 * `insert:track:<id>:slot2.mix`), so the splits count separators rather than searching for
 * one, and that arithmetic is sound only while an id carries none. It does: §1.3.1 makes
 * every id a `crypto.randomUUID()`, the §9.8 factory generator derives UUID-shaped ids, and
 * `remapSnapshot` refuses a §9.6 import whose ids are not UUIDs. Stating it here, at the
 * boundary §1.3 #11 already designates as the worker's validation contract, is what lets
 * the three splitters be arithmetic with no assumption of their own.
 *
 * A §7.8 `targetPath` is deliberately NOT guarded this way — colons are its grammar.
 */
const schedulerIdSchema = z
  .string()
  .refine((value) => !value.includes(':'), { message: 'An id may not contain ":"' });

const sequenceMetaSchema = z.object({
  lengthBars: z.number().int().min(1),
  timeSigNumerator: z.number().int().min(1),
  timeSigDenominator: z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(16)]),
  // The §4.2 range the store already clamps to, not a bare number. An in-app clamp makes an
  // out-of-range tempo unreachable today; the guard is the contract, so it may not be the
  // looser of the two (spec §1.3 #11, issue #96). A tempo of 0 divides by zero in the §7.2
  // tick↔seconds conversion and a negative one runs the tempo map backwards.
  tempo: ranged(BPM_RANGE).nullable(),
});

/**
 * Validate the playhead SAB without dereferencing the global at module-evaluation time.
 *
 * `z.instanceof(SharedArrayBuffer)` reads the binding as this module is imported, and
 * `SharedArrayBuffer` is UNDEFINED in a context that is not cross-origin isolated — so
 * merely importing this file threw a ReferenceError there, taking down the whole entry
 * bundle before `main.tsx` could run. That turned every unsupported browser, and the
 * first (pre-service-worker) load on a static host, into a blank page instead of the
 * §2.1 capability gate that is supposed to explain the problem. Checking `typeof` first
 * keeps the schema inert until something actually validates a message.
 */
const playheadSabSchema = z.custom<SharedArrayBuffer>(
  (value) => typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer,
  { message: 'Expected a SharedArrayBuffer' },
);

const schedulerRequestSchema: z.ZodType<SchedulerRequest> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('init'),
    playheadSab: playheadSabSchema,
    // `.catch(undefined)` rather than a plain optional: a version this build cannot read at
    // all is exactly the skew the field reports, so it must reach the reporting branch
    // instead of taking the whole handshake down with it.
    protocolVersion: z.number().int().optional().catch(undefined),
  }),
  z.object({ kind: z.literal('clockSync'), contextTime: z.number(), performanceTime: z.number() }),
  z.object({
    kind: z.literal('transport'),
    isPlaying: z.boolean(),
    isRecording: z.boolean(),
    startTick: z.number(),
  }),
  // Bounded to the §4.2 ranges the store clamps to, not left as bare numbers (issue #96).
  // With the guard bypassed, `bpm < 0` makes `beatSeconds` negative and the §7.7 click loop
  // emits its whole structural guard — 4096 clicks — on every wake; a swing amount of 100
  // shifts a 1/16 fully onto the next grid line.
  z.object({ kind: z.literal('tempo'), bpm: ranged(BPM_RANGE) }),
  z.object({
    kind: z.literal('swing'),
    amount: ranged(SWING_RANGE),
    division: z.union([z.literal(8), z.literal(16)]),
  }),
  z.object({ kind: z.literal('loop'), enabled: z.boolean(), startTick: z.number(), endTick: z.number() }),
  z.object({
    kind: z.literal('groove'),
    trackId: schedulerIdSchema,
    template: grooveTemplateSchema.nullable(),
  }),
  z.object({
    kind: z.literal('eventsDiff'),
    trackId: schedulerIdSchema,
    sequenceId: schedulerIdSchema,
    upserts: z.array(midiEventSchema),
    deletes: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('automationDiff'),
    scope: z.enum(['sequence', 'track']),
    ownerId: schedulerIdSchema,
    targetPath: z.string(),
    points: z.array(automationPointSchema),
  }),
  z.object({
    kind: z.literal('songSequence'),
    orderedEntries: z.array(
      z.object({
        sequenceId: schedulerIdSchema,
        // The floor the §9.3 `song_entries.repeats` column and `songEntrySchema` already
        // take. A guard may not be looser than the store it mirrors, and §7.9 states no
        // ceiling, so the bound on the WORK a large count implies lives in `buildSongMap`.
        repeats: z.number().int().min(SONG_REPEATS_MIN),
      }),
    ),
  }),
  z.object({ kind: z.literal('songLoop'), enabled: z.boolean() }),
  z.object({
    kind: z.literal('sequenceMeta'),
    sequences: z.record(schedulerIdSchema, sequenceMetaSchema),
    projectBpm: ranged(BPM_RANGE),
    activeSequenceId: schedulerIdSchema.nullable(),
    playbackMode: z.enum(['sequence', 'song']),
  }),
  z.object({
    kind: z.literal('liveNote'),
    note: z.number().int(),
    velocity: z.number().int(),
    on: z.boolean(),
    timestamp: z.number(),
    trackId: schedulerIdSchema,
  }),
  z.object({ kind: z.literal('noteRepeat'), enabled: z.boolean(), division: noteRepeatDivisionSchema }),
  z.object({
    kind: z.literal('arp'),
    enabled: z.boolean(),
    mode: z.enum(['up', 'down', 'upDown', 'played', 'random']),
    octaves: z.number().int(),
    gate: z.number(),
    division: noteRepeatDivisionSchema,
  }),
  z.object({
    kind: z.literal('metronome'),
    enabled: z.boolean(),
    countInBars: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
  z.object({
    kind: z.literal('liveErase'),
    trackId: schedulerIdSchema,
    note: z.number().int(),
    active: z.boolean(),
  }),
]);

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
  bpm: z.number().optional(),
});

const schedulerResponseSchema: z.ZodType<SchedulerResponse> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scheduleBatch'), events: z.array(scheduledEventSchema) }),
  z.object({ kind: z.literal('recorded'), trackId: z.string(), events: z.array(midiEventSchema) }),
  z.object({ kind: z.literal('erased'), trackId: z.string(), eventIds: z.array(z.string()) }),
  z.object({ kind: z.literal('loopWrapped'), tick: z.number() }),
  z.object({ kind: z.literal('songAdvanced'), entryIndex: z.number().int() }),
  z.object({ kind: z.literal('songEnded') }),
]);

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
