/**
 * Audio probe — the DOM-reachable test seam the Playwright smoke drives (spec §11.4).
 * It exposes read-only introspection (master meter peak, live voice count, playhead), the
 * offline effect renders (§11.2), and the record-then-playback proof (§12 exit) —
 * all surfaces that have no other browser-observable handle. Installed only once the engine
 * has started from a user gesture. Harmless in production: it drives the same stores and
 * scheduler the UI does.
 */
import type { AudioEngine } from '@/core/audio/engine';
import {
  renderDelayEchoOffline,
  renderEffectOffline,
  renderKernelGuardOffline,
  renderLfoPhaseOffline,
  renderLfoRateOffline,
  renderProgramNote,
  renderRampGuardOffline,
  type DelayEchoResult,
  type EffectRenderResult,
} from '@/core/audio/offlineTest';
import { getActiveRepositories, loadOrCreateActiveProject, projectService } from '@/core/project';
import { importDecodedSample } from '@/core/audio/sampleImport';
import { chopSampleToNewSamples, stretchSampleToNewSample } from '@/core/audio/sampleEditService';
import { sampleEditContext } from '@/features/sample-edit';
import {
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultPad,
  createDefaultSequence,
  createDefaultTrack,
  type EffectType,
  automationLaneKey,
  type KeygroupZone,
  type Sequence,
  type Track,
  type VelocityLayer,
} from '@/core/project/schemas';
import { useMixerStore, useProjectStore, useSequenceStore, useTransportStore, useUIStore } from '@/store';
import { commitTempo } from '@/store/tempo';
import { decodeWav, encodeWav } from '@/core/audio/wav';
import {
  createPlayheadSab,
  PlayheadReader,
  PlayheadWriter,
  SCHEDULER_PROTOCOL_VERSION,
  type ScheduledEvent,
} from '@/core/sequencer';
// Not through the barrel: the guard is the worker's own entry point, and the proof below
// checks that module rather than a re-export of it (spec §7.1.3, issue #96).
import { parseSchedulerRequest } from '@/core/sequencer/messages';
import { MAX_MOD_ROUTES, type ModRoute } from '@/core/project/schemas';

export interface RecordPlaybackResult {
  /** Notes captured into the track by the recording pass (spec §7.7). */
  readonly recorded: number;
  /** Scheduled notes the dispatcher realised while playing the take back (spec §7.1.4). */
  readonly played: number;
}

export interface AudioProbe {
  /** Current master meter peak from the SAB (spec §5.8) — proves audible signal. */
  masterPeak: () => number;
  /** Live voices in the pool (spec §5.4) — should return to 0 after playback. */
  liveVoiceCount: () => number;
  /** Current playhead tick from the scheduler SAB (spec §7.1.4). */
  playheadTick: () => number;
  /** Trigger `count` demo pads back to back (create/destroy churn, spec §5.3). */
  churn: (count: number) => Promise<void>;
  /** Render a tone through one effect offline and measure it (spec §11.2). */
  renderEffect: (
    effectType: EffectType,
    options?: { toneHz?: number; params?: Record<string, number> },
  ) => Promise<EffectRenderResult>;
  /** Record a short take via live notes, then play it back (spec §12 exit criterion). */
  recordThenPlayback: () => Promise<RecordPlaybackResult>;
  /** Velocity-layer switching: soft vs hard layer render pitches (spec §12 exit). */
  velocityLayerPitches: () => Promise<{ soft: number; hard: number }>;
  /** Keygroup pitch accuracy: root vs one-octave-up render pitches (spec §12 exit). */
  keygroupPitches: () => Promise<{ root: number; octave: number }>;
  /**
   * §6 `VelocityLayer.reverse` (issue #84): the same late-burst sample played forwards and
   * backwards. Forwards the energy sits in the second half, backwards in the first.
   */
  reversedLayerHalves: () => Promise<{
    forward: { first: number; second: number };
    reversed: { first: number; second: number };
  }>;
  /**
   * §5.7.9 `warp` (issue #84): a pad tuned an octave up, with warp off and on. Off, the
   * coupled repitch halves the sample's length; on, the granular source keeps it.
   */
  warpDecouplesPitch: () => Promise<{
    plain: { frequency: number; seconds: number };
    warped: { frequency: number; seconds: number };
  }>;
  /** §6 `LfoConfig.sync` (issue #107): the rate a synced LFO actually runs at, per tempo. */
  syncedLfoRates: () => Promise<{ free: number; atSlowTempo: number; atFastTempo: number }>;
  /** §6 `LfoConfig.phaseOffset` (issue #107): where a quarter-turn sine starts. */
  lfoPhaseStart: () => Promise<{ unshifted: number; quarterTurn: number }>;
  /** §5.7 synced delay (issue #70): where the echo of an impulse lands, per tempo. */
  delayEcho: (options?: {
    division?: string;
    bpm?: number;
    retuneToBpm?: number;
  }) => Promise<DelayEchoResult>;
  /** .mpcweb export → import round-trip (spec §12 exit / §9.6 pack round-trip smoke). */
  packRoundTrip: () => Promise<{ imported: boolean; samples: number }>;
  /** Import → transient chop → time-stretch of a synthetic drum (spec §7.5/§8.5.4/§5.7.9). */
  samplePipelineProof: () => Promise<{
    chops: number;
    importedFrames: number;
    stretchedFrames: number;
    stretchedRatio: number;
  }>;
  /** Factory catalogue fetch → kit merge → demo install over the real path (spec §9.8). */
  factoryInstallProof: () => Promise<FactoryInstallResult>;
  /** A project switch over work autosave could not write refuses (spec §4.4, issue #103). */
  refusedSwitchProof: () => Promise<RefusedSwitchResult>;
  /** OPFS tells "absent" from "could not tell" over real handles (spec §9.2, issue #98). */
  storagePolicyProof: () => Promise<StoragePolicyResult>;
  /** 32 mod routes onto one target stay inside that target's range (spec §6, issue #76). */
  modClampProof: () => Promise<ModClampResult>;
  /** A non-finite value never reaches a real AudioParam or kernel (spec §4.3, issue #97). */
  paramGuardProof: () => Promise<ParamGuardResult>;
  /** A malformed WAV header is refused rather than decoded against (spec §9.4, issue #66). */
  wavHeaderProof: () => WavHeaderResult;
  /** The §7.1 silent-failure modes now report or disarm (spec §7.1.4, §7.7, issue #95). */
  sequencerGuardProof: () => Promise<SequencerGuardResult>;
  /** A mid-playback tempo change applies from the change onward (spec §7.2, issue #74). */
  tempoChangeProof: () => Promise<TempoChangeResult>;
  /** Every §9.5 bounce produces a file the user can actually get back (issue #104). */
  bounceReachProof: () => Promise<BounceReachResult>;
  /** A gesture moves the graph and re-renders nothing (spec §3.3, §4.1, issue #27). */
  gestureRenderProof: () => Promise<GestureRenderResult>;
  /** Song mode schedules everything sequence mode does (spec §7.9, issue #94). */
  songParityProof: () => Promise<SongParityResult>;
  /** One pad held on two tracks repeats on both, not twice on one (spec §7.3, issue #25). */
  noteRepeatOwnerProof: () => Promise<NoteRepeatOwnerResult>;
  /** The §7.1.3 handshake, and the guards tightened to the store's own ranges (issue #96). */
  schedulerBoundaryProof: () => SchedulerBoundaryResult;
  /** The §5.4 declick follows a pitch-modulated voice's real end (issue #87). */
  declickContourProof: () => Promise<DeclickContourResult>;
  /** One announcer, two channels, and severity picking between them (spec §8.2, issue #34). */
  announcementProof: () => Promise<AnnouncementResult>;
  /** The §9.7 eviction warning is readable, dismissible UI in every mode (issue #51). */
  platformNoticeProof: () => Promise<PlatformNoticeResult>;
  /** A sweep across the loop end takes the notes it passed, not their complement (#16). */
  liveEraseWrapProof: () => Promise<LiveEraseWrapResult>;
  /** `songAdvanced` indexes §7.9's position-sorted entries, repeats and all (issue #130). */
  songEntryIndexProof: () => Promise<SongEntryIndexResult>;
  /** A slot's stored params are the ones the graph runs, fresh or reloaded (issue #131). */
  insertDefaultsProof: () => Promise<InsertDefaultsResult>;
}

/**
 * What the store SAYS about one insert parameter, and what the graph DOES with it — the two
 * numbers issue #131 is the disagreement between (spec §3.4).
 */
export interface InsertAgreement {
  /** What a reader of the store gets: the stored value, or the §7.8 range floor if absent. */
  readonly storeTimeMs: number;
  /** Whether the slot carries the parameter at all, or the number above is that fallback. */
  readonly stored: boolean;
  /** Where the echo lands for a delay built from those very params, in ms (spec §11.2). */
  readonly graphTimeMs: number;
  /** Peak of that echo, so a silent render is distinguishable from a mistimed one. */
  readonly echoPeak: number;
}

/** Outcome of the §5.7 insert-defaults proof (see {@link AudioProbe.insertDefaultsProof}). */
export interface InsertDefaultsResult {
  /** The §7.8 address the proof drives, so a failure names the slot it drove. */
  readonly path: string;
  /** A slot the user just added, through the real §8.5.6 store action. */
  readonly added: InsertAgreement;
  /** The same slot after a save and a real §4.4 project reload. */
  readonly reloaded: InsertAgreement;
  /** The slot as a project written BEFORE the fix holds it: `params: {}` in the §9.3 column. */
  readonly legacy: InsertAgreement;
  /** Where that first touch put the parameter, so a failed undo is told from a failed touch. */
  readonly touchedToMs: number;
  /** What an undo of the first touch of a fresh insert returns the parameter to, in ms. */
  readonly undoneToMs: number;
}

/** Outcome of the §7.7 loop-boundary erase proof (see {@link liveEraseWrapProof}). */
export interface LiveEraseWrapResult {
  /** Every written tick on the erase-armed track, before the sweep. */
  readonly ticksBefore: number[];
  /** What survived it. The two sets are complements of each other under issue #16. */
  readonly ticksAfter: number[];
  /** The loop length the sweep wrapped around, in ticks (spec §7.1.4). */
  readonly loopLengthTicks: number;
}

/** Outcome of the §7.9 entry-index proof (see {@link songEntryIndexProof}). */
export interface SongEntryIndexResult {
  /** Entry indices the worker reported, in order, deduplicated as they arrived. */
  readonly reportedIndices: number[];
  /** How many entries the playlist holds, and how many sequence plays that is. */
  readonly entryCount: number;
  readonly segmentCount: number;
  /** The playlist row §8.5.12 marked as playing while the repeated first entry ran. */
  readonly markedRowText: string;
  readonly markedRowIndex: number;
}

/** Outcome of the §8.2 announcer proof (see {@link announcementProof}). */
export interface AnnouncementResult {
  /** Live regions in the whole document before anything is announced. Must be 2. */
  readonly regionsIdle: number;
  /** Live regions with three toasts on screen. Must still be 2 (issue #34). */
  readonly regionsWithToasts: number;
  /** Toasts actually rendered, so the count above is measured under real load. */
  readonly toastsOnScreen: number;
  /** What the assertive channel read after an error toast. */
  readonly assertiveAfterError: string;
  /** What the polite channel read at the same moment — it must NOT carry the error. */
  readonly politeAfterError: string;
  /** What the polite channel read after an advisory toast. */
  readonly politeAfterInfo: string;
  /** And the assertive one, which must not have been interrupted for advice. */
  readonly assertiveAfterInfo: string;
  /** Elements carrying a live role that are neither of the announcer's two. */
  readonly strayRegions: readonly string[];
}

/** Outcome of the §9.7 shell-notice proof (see {@link platformNoticeProof}). */
export interface PlatformNoticeResult {
  /** Notice strips on screen while the persistence grant stands. Must be 0. */
  readonly noticesWhileGranted: number;
  /** The warning's own text once the grant is refused. */
  readonly text: string;
  /** Its Dismiss button's accessible name, which must name what it dismisses. */
  readonly dismissName: string;
  /** Whether that button is in the tab order — the `title` it replaced was not. */
  readonly dismissFocusable: boolean;
  /** Notice strips remaining after pressing Dismiss. Must be 0. */
  readonly noticesAfterDismiss: number;
  /** The storage gauge's `title`, which must no longer hide the same sentence. */
  readonly gaugeTitle: string;
}

/** Outcome of the §7.9 song-parity proof (see {@link songParityProof}). */
export interface SongParityResult {
  /** Automation ramps the worker emitted while the song played (spec §7.8). */
  readonly automationRamps: number;
  /** The lane climbs 0 → 1 across the song, so the last ramp is well above the first. */
  readonly firstAutomationValue: number;
  readonly lastAutomationValue: number;
  /** Written notes on the erase-armed track, before and after the song swept them (§7.7). */
  readonly eventsBeforeErase: number;
  readonly eventsAfterErase: number;
  /** Notes merged into the track by the per-pass flush WHILE the song was still rolling. */
  readonly flushedWhilePlaying: number;
  /** The tick that take landed on, and the pattern length it has to fall inside (§9.3). */
  readonly flushedTick: number;
  readonly patternLengthTicks: number;
}

/** Outcome of the §7.3 note-repeat ownership proof (see {@link noteRepeatOwnerProof}). */
export interface NoteRepeatOwnerResult {
  /** Sequence mode: repeat hits per track for ONE pad held on two tracks (issue #25). */
  readonly sequenceHits: { readonly one: number; readonly two: number };
  /** The velocity each track's hits carried — 100 and 60, never both the same (issue #25). */
  readonly sequenceVelocities: { readonly one: number[]; readonly two: number[] };
  /** Song mode: the same again, where note repeat used to produce nothing (issue #94). */
  readonly songHits: { readonly one: number; readonly two: number };
  /** Song mode: arpeggiator notes per track, which also produced nothing (issue #94). */
  readonly songArpNotes: { readonly one: number[]; readonly two: number[] };
}

/** Outcome of the §7.1.3 worker-boundary proof (see {@link schedulerBoundaryProof}). */
export interface SchedulerBoundaryResult {
  /** The version this build attaches to the handshake, which the worker checks (issue #96). */
  readonly attachedVersion: number | null;
  /** A message the guard must still accept, beside the four it must now refuse. */
  readonly acceptsInRangeTempo: boolean;
  /**
   * A handshake with NO version must still be accepted, so the skew reaches the reporting
   * branch. Dropping it would leave the SAB uninstalled and nothing said (issue #96).
   */
  readonly acceptsVersionlessHandshake: boolean;
  readonly refusals: { readonly name: string; readonly refused: boolean }[];
}

/** Outcome of the §5.4 declick proof (see {@link declickContourProof}). */
export interface DeclickContourResult {
  /** The unmodulated voice, whose region ends where the base rate says it does. */
  readonly flatSeconds: number;
  /** The same pad swept an octave DOWN: half the rate at note-on, so a longer region. */
  readonly sweptSeconds: number;
  /** The last audible sample of the swept voice — a declicked end lands on near-zero. */
  readonly sweptFinalMagnitude: number;
}

/** Outcome of the §6 mod-matrix clamp proof (see {@link modClampProof}). */
export interface ModClampResult {
  /** The pitch a pad with one modest pitch route sounds — the control. */
  readonly baselineHz: number;
  /** The pitch with 32 full-depth pitch routes. Un-clamped this is 32 octaves up. */
  readonly pilePitchHz: number;
  /** Peak of a pad with one amp route, and with 32. Un-clamped the second is 33x the first. */
  readonly baselinePeak: number;
  readonly pileAmpPeak: number;
}

/** Outcome of the §4.3/§5.6 guard proof (see {@link paramGuardProof}). */
export interface ParamGuardResult {
  /** A tone rendered through a GainNode that three ramp helpers tried to write NaN to. */
  readonly rampRms: number;
  readonly rampFinite: boolean;
  /** The same, through the real limiter and reverb worklets driven with NaN parameters. */
  readonly limiterRms: number;
  readonly limiterFinite: boolean;
  readonly reverbRms: number;
  readonly reverbFinite: boolean;
}

/** Outcome of the §9.4 WAV header proof (see {@link wavHeaderProof}). */
export interface WavHeaderResult {
  /** A well-formed file this proof built itself still decodes. */
  readonly goodDecodes: boolean;
  /** Each malformed header, and the message it was refused with (empty = it was accepted). */
  readonly refusals: { readonly name: string; readonly message: string }[];
}

/** Outcome of the §7.1 sequencer guard proof (see {@link sequencerGuardProof}). */
export interface SequencerGuardResult {
  /** A tear-free SAB read, over real SharedArrayBuffer + Atomics. */
  readonly freshTick: number;
  readonly freshStale: boolean;
  /** A read taken while the seqlock generation is odd: held, and reported as stale. */
  readonly tornTick: number;
  readonly tornStale: boolean;
  /** Notes on the track before a live erase is armed. */
  readonly eventsBeforeErase: number;
  /** After a pass with the pad held over Erase — the §7.7 behaviour, and the control. */
  readonly eventsAfterHeldPass: number;
  /** After the same notes are restored and a pass runs with NOTHING held (issue #95). */
  readonly eventsAfterReplay: number;
}

/** Outcome of the §7.2 tempo-change proof (see {@link tempoChangeProof}). */
export interface TempoChangeResult {
  /** Playhead ticks sampled before the tempo change and just after it landed. */
  readonly beforeChange: number;
  readonly afterChange: number;
  /** A later sample, proving the transport kept moving forward at the new tempo. */
  readonly afterSettling: number;
  /** The tempo the change committed, read back off the transport mirror. */
  readonly bpmAfter: number;
}

/** Outcome of the §4.4 refused-switch proof (see {@link refusedSwitchProof}). */
export interface RefusedSwitchResult {
  /** The project that was open before the switch was attempted. */
  readonly projectBefore: string;
  /** The project open after it — the SAME one, because the switch was refused. */
  readonly projectAfter: string;
  /** Whether `loadProject` rejected rather than proceeding. */
  readonly refused: boolean;
  /** The refusal the user is shown; it must name what could not be saved. */
  readonly message: string;
  /** The §4.4 unsaved dot, which must still be up behind the refusal. */
  readonly stillModified: boolean;
  /** The switch succeeds once the unwritable work is gone. */
  readonly switchedAfterClearing: boolean;
}

/** Outcome of the §9.2 storage-policy proof (see {@link storagePolicyProof}). */
export interface StoragePolicyResult {
  /** A write then read of the same bytes through the retrying atomic write (spec §9.7). */
  readonly roundTripped: boolean;
  /** No `.tmp-` artefact is left in the directory afterwards (spec §9.7). */
  readonly noTempLeftBehind: boolean;
  /** `fileExists` answers false for a path that is genuinely absent. */
  readonly absentReportsFalse: boolean;
  /** Deleting an absent file is idempotent, not an error. */
  readonly deleteAbsentSucceeds: boolean;
  /** Deleting outside the two §9.1 content roots is still refused. */
  readonly deleteOutsideRootsRefused: boolean;
  /** A non-`NotFoundError` failure propagates instead of reading as "absent" (issue #98). */
  readonly ioFailurePropagates: boolean;
}

/** Outcome of the §9.8 factory install proof (see {@link factoryInstallProof}). */
export interface FactoryInstallResult {
  catalogueSize: number;
  kits: number;
  demos: number;
  /** Programs and samples in the active project, before and after a kit merge. */
  programsBefore: number;
  programsAfter: number;
  samplesBefore: number;
  samplesAfter: number;
  /** The kit merge must leave the project's arrangement untouched (spec §9.8). */
  sequencesBefore: number;
  sequencesAfter: number;
  tracksBefore: number;
  tracksAfter: number;
  songEntriesBefore: number;
  songEntriesAfter: number;
  /** Every installed sample's WAV is readable back from OPFS at its recorded path (§9.1). */
  mergedSamplesReadable: boolean;
  /** A demo pack opens as a NEW, playable project (spec §9.8). */
  demoOpenedNewProject: boolean;
  demoSequences: number;
  demoSamples: number;
  /**
   * Global-library sample counts after installing a kit, then after installing the demo that
   * plays it. They must be EQUAL: the demo ships the same audio, so it stores none of its own
   * (spec §9.8 de-duplication, §9.1).
   */
  globalAfterKit: number;
  globalAfterDemo: number;
}

/** Every §9.5 bounce, read back from OPFS as the UI does before downloading (issue #104). */
export interface BounceReachResult {
  /** Bytes readable back for each §9.5 variant; 0 means the file could not be retrieved. */
  readonly sequenceBytes: number;
  readonly songBytes: number;
  readonly stemBytes: number;
  /** The resample lands in the sample library rather than in `/bounces/` (spec §9.5). */
  readonly resampledSampleId: string;
  readonly resampledBytes: number;
  /** True when the resampled row is listed by the library query the Browser runs. */
  readonly resampledIsBrowsable: boolean;
}

/** What a continuous gesture costs React and what it moves in the graph (issue #27). */
export interface GestureRenderResult {
  /** `useMixerStore.channels` notifications across the whole gesture. §3.3 requires zero. */
  readonly notificationsDuringGesture: number;
  /** Notifications from the single commit that ends it — exactly one (spec §4.1). */
  readonly notificationsAtCommit: number;
  /**
   * Master meter peak from the same demo hit at three points: before the gesture, part-way
   * through it, and after the commit. A transient that reached the graph is AUDIBLE, so the
   * middle reading is what proves the gesture did its job without a single re-render.
   */
  readonly peakBefore: number;
  readonly peakDuringGesture: number;
  readonly peakAfterCommit: number;
  /** Transient samples sent, so the counts above can be read against a real gesture length. */
  readonly samplesSent: number;
}

declare global {
  interface Window {
    __bangerboxAudioProbe?: AudioProbe;
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function layer(over: Partial<VelocityLayer>): VelocityLayer {
  return {
    sampleId: 'offline',
    velocityStart: 0,
    velocityEnd: 127,
    tuneSemitones: 0,
    tuneCents: 0,
    gainDb: 0,
    startFrame: 0,
    endFrame: 0,
    reverse: false,
    ...over,
  };
}

/**
 * Velocity-layer switching proof (spec §12): a pad with a soft layer (unity pitch) and a
 * hard layer tuned +12 semitones. A soft hit renders the base pitch; a hard hit renders an
 * octave up — proving velocity selects the layer through the real resolution + voice path.
 */
async function velocityLayerPitches(): Promise<{ soft: number; hard: number }> {
  const program = createDefaultDrumProgram('Velocity kit');
  const pad = createDefaultPad(0);
  pad.layers = [
    layer({ sampleId: 'soft', velocityStart: 1, velocityEnd: 63, tuneSemitones: 0 }),
    layer({ sampleId: 'hard', velocityStart: 64, velocityEnd: 127, tuneSemitones: 12 }),
  ];
  program.pads = [pad];
  const soft = await renderProgramNote(program, 0, 30);
  const hard = await renderProgramNote(program, 0, 110);
  return { soft: soft.frequency, hard: hard.frequency };
}

/**
 * Keygroup pitch-accuracy proof (spec §12): one zone rooted at note 60. Note 60 renders the
 * unity pitch; note 72 renders exactly one octave up (coupled repitch, spec §6).
 */
async function keygroupPitches(): Promise<{ root: number; octave: number }> {
  const program = createDefaultKeygroupProgram('Keys');
  const zone: KeygroupZone = {
    sampleId: 'offline',
    rootNote: 60,
    lowNote: 0,
    highNote: 127,
    lowVelocity: 0,
    highVelocity: 127,
    tuneCents: 0,
    gainDb: 0,
  };
  program.zones = [zone];
  const root = await renderProgramNote(program, 60, 100);
  const octave = await renderProgramNote(program, 72, 100);
  return { root: root.frequency, octave: octave.frequency };
}

/**
 * Drive the real sequencer end to end (spec §12 record-then-playback): set up a one-bar
 * looping track, arm recording, tap a pad three times via live notes, let the worker
 * capture and flush the take into the store, then play it back through the scheduler and
 * count the dispatched notes. Exercises the store → sync → worker → dispatcher → graph path.
 */
async function recordThenPlayback(engine: AudioEngine): Promise<RecordPlaybackResult> {
  const seqId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const note = 36;

  // A one-bar 4/4 sequence (3840 ticks = 2 s at 120 bpm) looping on a single drum track.
  // Both rows are inserted through the repositories *before* the store is hydrated, and the
  // sequence is bound to the live project rather than a throwaway id. `hydrate` is the DB →
  // store load path and marks nothing dirty (spec §4.4), so injecting a track that exists
  // only in memory left the recorded take's `events:<trackId>` key unwritable: autosave
  // retried it and failed on the midi_events → tracks foreign key every time, surfacing as
  // repeated "Autosave failed — will retry." toasts that had nothing to do with the app.
  const projectId = useProjectStore.getState().projectId;
  if (!projectId) throw new Error('recordThenPlayback needs an open project');
  const sequence = { ...createDefaultSequence(projectId, 0, 'Smoke', seqId), lengthBars: 1 };
  const track = createDefaultTrack(seqId, null, 0, 'Smoke', 'drum', trackId);

  const repos = getActiveRepositories();
  await repos.sequences.create({
    id: sequence.id,
    project_id: sequence.projectId,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: sequence.tempo,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });
  await repos.tracks.create({
    id: track.id,
    sequence_id: track.sequenceId,
    program_id: track.programId,
    position: track.position,
    name: track.name,
    type: track.type,
    mixer: '{}',
  });

  useSequenceStore.getState().hydrate({
    sequences: { [seqId]: sequence },
    tracks: { [trackId]: track },
    events: {},
    automation: {},
    songEntries: [],
  });

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setPlaybackMode('sequence');
  transport.setBpm(120);
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setRecordMode('overdub');
  transport.setLoop({ enabled: true, startTick: 0, endTick: 3840 });

  // --- record: play + three pad taps across the bar ---
  transport.setRecording(true);
  transport.play();
  for (let i = 0; i < 3; i++) {
    await delay(300);
    engine.scheduler.sendLiveNote(note, 110, true, performance.now(), trackId);
    await delay(60);
    engine.scheduler.sendLiveNote(note, 110, false, performance.now(), trackId);
  }
  await delay(1400); // cross the loop boundary so the overdub take flushes to the store
  useTransportStore.getState().stop();
  await delay(250);
  const recorded = (useSequenceStore.getState().events[trackId] ?? []).length;

  // --- playback: play the take back and count dispatched notes ---
  const before = engine.scheduledNoteCount();
  useTransportStore.getState().setRecording(false);
  useTransportStore.getState().play();
  await delay(2300); // roughly one loop of the recorded bar
  useTransportStore.getState().stop();
  await delay(150);
  const played = engine.scheduledNoteCount() - before;

  return { recorded, played };
}

/**
 * Pack round-trip proof (spec §12 exit, §9.6): ensure the project has a sample, export it to a
 * `.mpcweb` archive, re-import it as a fresh project, and confirm the samples came across.
 */
async function packRoundTrip(): Promise<{ imported: boolean; samples: number }> {
  const ctx = sampleEditContext();
  const existing = await ctx.repos.samples.listByProject(ctx.projectId);
  if (existing.rows.length === 0) {
    const tone = new Float32Array(2_000);
    for (let i = 0; i < tone.length; i++) {
      tone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / ctx.projectSampleRate);
    }
    const { saveChannelsAsSample } = await import('@/core/audio/sampleImport');
    await saveChannelsAsSample([tone], ctx.projectSampleRate, 'probe tone', ['probe'], ctx);
  }
  const originalId = ctx.projectId;
  const blob = await projectService.exportMpcweb();
  const file = new File([blob], 'roundtrip.mpcweb', { type: 'application/zip' });
  const importedId = await projectService.importMpcweb(file);
  const importedSamples = await sampleEditContext().repos.samples.listByProject(importedId);
  return {
    imported: importedId !== originalId && importedId.length > 0,
    samples: importedSamples.rows.length,
  };
}

/**
 * Factory content proof (spec §9.8) over the REAL path: the catalogue is fetched over HTTP,
 * a kit is merged into the live project through actual OPFS writes and SQLite inserts, and
 * a demo is installed as a new project. The unit suite mocks OPFS and the repositories, so
 * this is the only place the §13.5 "real OPFS/SAB/worklet path" is exercised for §9.8.
 */
async function factoryInstallProof(): Promise<FactoryInstallResult> {
  const { fetchFactoryCatalogue, installFactoryPack } = await import('@/core/project');
  const { readFile } = await import('@/core/storage/opfs');

  const catalogue = await fetchFactoryCatalogue();
  const kits = catalogue.filter((pack) => pack.kind === 'kit');
  const demos = catalogue.filter((pack) => pack.kind === 'demo');
  if (kits.length === 0 || demos.length === 0) {
    throw new Error('factory catalogue is missing a kit or a demo');
  }

  const before = sampleEditContext();
  const count = async (projectId: string) => {
    const ctx = sampleEditContext();
    const [programs, samples, sequences] = await Promise.all([
      ctx.repos.programs.listByProject(projectId),
      ctx.repos.samples.listByProject(projectId),
      ctx.repos.sequences.listByProject(projectId),
    ]);
    let tracks = 0;
    for (const sequence of sequences.rows) {
      tracks += (await ctx.repos.tracks.listBySequence(sequence.id)).rows.length;
    }
    const songEntries = await ctx.repos.songs.listByProject(projectId);
    return {
      programs: programs.rows.length,
      samples: samples.rows.length,
      sequences: sequences.rows.length,
      tracks,
      songEntries: songEntries.length,
    };
  };

  const globalSampleCount = async () =>
    (await sampleEditContext().repos.samples.listGlobal({ limit: 1_000 })).rows.length;

  // Pair a kit with the demo that PLAYS it, so the second install is the de-duplication case
  // (spec §9.8). An unrelated pair would install disjoint audio and prove nothing.
  const kit = kits.find((pack) => pack.id === 'kit-808') ?? kits[0]!;
  const demoPack = demos.find((pack) => pack.id === 'demo-song') ?? demos[0]!;

  const activeId = before.projectId;
  const start = await count(activeId);
  await installFactoryPack(kit, activeId);
  const merged = await count(activeId);
  const globalAfterKit = await globalSampleCount();

  // Every installed sample must actually be on disk at the path its row records (spec §9.1) —
  // read back from the GLOBAL library, which is where factory audio now lives.
  const ctx = sampleEditContext();
  const globalSamples = await ctx.repos.samples.listGlobal({ limit: 1_000 });
  let mergedSamplesReadable = globalSamples.rows.length > 0;
  for (const row of globalSamples.rows) {
    try {
      const file = await readFile(row.opfs_path);
      if (file.size === 0) mergedSamplesReadable = false;
    } catch {
      mergedSamplesReadable = false;
    }
  }

  const demoResult = await installFactoryPack(demoPack, activeId);
  const demo = await count(demoResult.projectId);
  const globalAfterDemo = await globalSampleCount();

  return {
    catalogueSize: catalogue.length,
    kits: kits.length,
    demos: demos.length,
    programsBefore: start.programs,
    programsAfter: merged.programs,
    samplesBefore: start.samples,
    samplesAfter: merged.samples,
    sequencesBefore: start.sequences,
    sequencesAfter: merged.sequences,
    tracksBefore: start.tracks,
    tracksAfter: merged.tracks,
    songEntriesBefore: start.songEntries,
    songEntriesAfter: merged.songEntries,
    mergedSamplesReadable,
    demoOpenedNewProject: demoResult.projectId !== activeId,
    demoSequences: demo.sequences,
    demoSamples: demo.samples,
    globalAfterKit,
    globalAfterDemo,
  };
}

/**
 * Sample-pipeline proof (spec §12): import a synthetic drum loop (§9.4), chop it by WASM
 * transient detection (§7.5/§8.5.4), and time-stretch it (§5.7.9) — proving the WASM kernels run
 * end to end on the real OPFS/decode path.
 */
async function samplePipelineProof(engine: AudioEngine): Promise<{
  chops: number;
  importedFrames: number;
  stretchedFrames: number;
  stretchedRatio: number;
}> {
  const ctx = sampleEditContext();
  const sr = ctx.projectSampleRate;
  const buffer = engine.context.createBuffer(1, sr, sr);
  const data = buffer.getChannelData(0);
  for (const onset of [0, sr * 0.25, sr * 0.5, sr * 0.75]) {
    for (let i = 0; i < 2_400 && onset + i < sr; i++) {
      data[Math.floor(onset) + i] = 0.9 * Math.exp(-i / 400) * Math.sin((2 * Math.PI * 180 * i) / sr);
    }
  }
  const imported = await importDecodedSample(buffer, 'probe drum', ['probe'], {
    ...ctx,
    context: engine.context,
  });
  const chops = await chopSampleToNewSamples(
    imported,
    { mode: 'transients', detect: { sensitivity: 0.6, minSpacingMs: 40 } },
    ctx,
  );
  const stretched = await stretchSampleToNewSample(imported, { rate: 0.5, pitchSemitones: 0 }, ctx);
  // The real SQLite worker can return INTEGER columns as BigInt (rpc value union) — coerce
  // before dividing so the ratio is a plain Number across the evaluate boundary. Read the frame
  // counts straight off the stretched channel data to be independent of the DB round-trip.
  const importedFrames = Number(imported.frames);
  const stretchedFrames = Number(stretched.frames);
  return {
    chops: chops.length,
    importedFrames,
    stretchedFrames,
    stretchedRatio: importedFrames > 0 ? stretchedFrames / importedFrames : 0,
  };
}

/**
 * §6 `reverse` proof (issue #84): one pad, one late-burst sample, played both ways. The
 * energy has to move from the second half of the render to the first.
 */
async function reversedLayerHalves(): Promise<{
  forward: { first: number; second: number };
  reversed: { first: number; second: number };
}> {
  const build = (reverse: boolean) => {
    const program = createDefaultDrumProgram('Reverse probe');
    const pad = createDefaultPad(0);
    pad.layers = [layer({ sampleId: 'offline', reverse })];
    program.pads = [pad];
    return program;
  };
  // The sample fills the whole render, so the halves measured are the SAMPLE's halves.
  const options = { signal: 'lateBurst', seconds: 0.4, sampleSeconds: 0.4 } as const;
  const forward = await renderProgramNote(build(false), 0, 100, options);
  const reversed = await renderProgramNote(build(true), 0, 100, options);
  return {
    forward: { first: forward.firstHalfRms, second: forward.secondHalfRms },
    reversed: { first: reversed.firstHalfRms, second: reversed.secondHalfRms },
  };
}

/**
 * §5.7.9 `warp` proof (issue #84): the same +12-semitone pad with warp off and on. Off,
 * detune is the playback rate and the sample lasts half as long; on, the granular source
 * shifts the pitch and leaves the length alone.
 */
async function warpDecouplesPitch(): Promise<{
  plain: { frequency: number; seconds: number };
  warped: { frequency: number; seconds: number };
}> {
  const build = (warp: boolean) => {
    const program = createDefaultDrumProgram('Warp probe');
    const pad = { ...createDefaultPad(0), warp };
    pad.layers = [layer({ sampleId: 'offline', tuneSemitones: 12 })];
    program.pads = [pad];
    return program;
  };
  const plain = await renderProgramNote(build(false), 0, 100, { baseFrequency: 300, seconds: 0.8 });
  const warped = await renderProgramNote(build(true), 0, 100, { baseFrequency: 300, seconds: 0.8 });
  return {
    plain: { frequency: plain.frequency, seconds: plain.soundingSeconds },
    warped: { frequency: warped.frequency, seconds: warped.soundingSeconds },
  };
}

/** §6 `LfoConfig.sync` proof (issue #107): the same LFO free, and synced at two tempos. */
async function syncedLfoRates(): Promise<{ free: number; atSlowTempo: number; atFastTempo: number }> {
  const free = await renderLfoRateOffline('free', 120);
  const atSlowTempo = await renderLfoRateOffline('1/4', 60);
  const atFastTempo = await renderLfoRateOffline('1/4', 240);
  return {
    free: free.measuredHz,
    atSlowTempo: atSlowTempo.measuredHz,
    atFastTempo: atFastTempo.measuredHz,
  };
}

/** §6 `LfoConfig.phaseOffset` proof (issue #107): a quarter-turn sine starts at its peak. */
async function lfoPhaseStart(): Promise<{ unshifted: number; quarterTurn: number }> {
  const unshifted = await renderLfoPhaseOffline(0);
  const quarterTurn = await renderLfoPhaseOffline(0.25);
  return { unshifted: unshifted.firstSample, quarterTurn: quarterTurn.firstSample };
}

/**
 * The §4.4 refused switch (issue #103), over the real autosave queue and a real project switch.
 *
 * The failure is injected as a dirty key no flush path can write — `flushDirtyKeys` rejects it
 * with `UnflushableKeyError`, exactly as it does for a project that is no longer the active one.
 * That is the honest shape of the defect: the flush ran, it did not write, and the switch used
 * to proceed over it anyway while hydration cleared the dot that represented the loss.
 */
async function refusedSwitchProof(): Promise<RefusedSwitchResult> {
  const { markDirty } = await import('@/core/project/dirty');
  const projectBefore = useProjectStore.getState().projectId;

  // A second project to switch TO, created before the unwritable work exists.
  const target = await projectService.newProject('Switch Target');
  await projectService.loadProject(projectBefore);

  markDirty('settings:no-flush-path-exists');

  let refused = false;
  let message = '';
  try {
    await projectService.loadProject(target);
  } catch (error) {
    refused = true;
    message = error instanceof Error ? error.message : String(error);
  }

  const projectAfter = useProjectStore.getState().projectId;
  const stillModified = useProjectStore.getState().modifiedSinceLastSave;

  // The queue drops a permanently unflushable key (§14 issue #72), so a second attempt has
  // nothing outstanding and proceeds — the user is warned once, never trapped.
  let switchedAfterClearing = false;
  try {
    await projectService.loadProject(target);
    switchedAfterClearing = useProjectStore.getState().projectId === target;
  } catch {
    switchedAfterClearing = false;
  }

  return { projectBefore, projectAfter, refused, message, stillModified, switchedAfterClearing };
}

/**
 * The §9.2 storage policy over REAL OPFS handles (issue #98). The unit suite drives an
 * in-memory fake, so this is the only place §13.5's "real OPFS path" is exercised for it.
 */
async function storagePolicyProof(): Promise<StoragePolicyResult> {
  const { deleteFile, fileExists, projectSamplesRoot, readFile, writeFileAtomic } =
    await import('@/core/storage/opfs');
  const projectId = useProjectStore.getState().projectId;
  const path = `${projectSamplesRoot(projectId)}/probe-storage-policy.wav`;
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  const absentReportsFalse = (await fileExists(path)) === false;

  await writeFileAtomic(path, bytes);
  const read = new Uint8Array(await (await readFile(path)).arrayBuffer());
  const roundTripped = read.length === bytes.length && read.every((v, i) => v === bytes[i]);

  // A temp artefact left behind would sit in the user's quota permanently and invisibly.
  const root = await navigator.storage.getDirectory();
  const names: string[] = [];
  const segments = projectSamplesRoot(projectId).replace(/^\//, '').split('/');
  let directory = root;
  for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
  for await (const name of (directory as unknown as { keys(): AsyncIterableIterator<string> }).keys()) {
    names.push(name);
  }
  const noTempLeftBehind = !names.some((name) => name.includes('.tmp-'));

  await deleteFile(path);
  let deleteAbsentSucceeds = true;
  try {
    await deleteFile(path); // already gone: idempotent, not an error
  } catch {
    deleteAbsentSucceeds = false;
  }

  let deleteOutsideRootsRefused = false;
  try {
    await deleteFile('/bangerbox.sqlite3');
  } catch {
    deleteOutsideRootsRefused = true;
  }

  // A failure that is NOT "absent" must reach the caller. Real OPFS will not produce one on
  // demand, so the one seam that can is the directory lookup itself.
  let ioFailurePropagates = false;
  const storage = navigator.storage;
  const original = storage.getDirectory.bind(storage);
  Object.defineProperty(storage, 'getDirectory', {
    configurable: true,
    value: async () => {
      throw new DOMException('device is on fire', 'NotReadableError');
    },
  });
  try {
    await fileExists(path);
  } catch (error) {
    ioFailurePropagates = error instanceof DOMException && error.name === 'NotReadableError';
  } finally {
    Object.defineProperty(storage, 'getDirectory', { configurable: true, value: original });
  }

  return {
    roundTripped,
    noTempLeftBehind,
    absentReportsFalse,
    deleteAbsentSucceeds,
    deleteOutsideRootsRefused,
    ioFailurePropagates,
  };
}

/**
 * §6 mod-matrix clamping over a real render (spec §11.2, issue #76).
 *
 * §6 caps the matrix at 32 routes and each amount at ±1, and forbids nothing about all 32
 * landing on one target — so this program passes Zod validation and could arrive in a §9.6
 * `.mpcweb` pack. Un-clamped it detunes 32 octaves, which consumes the buffer before a frame
 * is audible, and peaks at 33× gain. Measured against a one-route control so the assertion is
 * a ratio rather than an absolute.
 */
async function modClampProof(): Promise<ModClampResult> {
  const build = (routes: ModRoute[]) => {
    const program = createDefaultDrumProgram('Mod clamp probe');
    const pad = createDefaultPad(0);
    pad.layers = [layer({ sampleId: 'offline' })];
    pad.modMatrix = routes;
    program.pads = [pad];
    return program;
  };
  const pile = (target: ModRoute['target']): ModRoute[] =>
    Array.from({ length: MAX_MOD_ROUTES }, () => ({ source: 'velocity' as const, target, amount: 1 }));

  const options = { baseFrequency: 300, seconds: 0.4 } as const;
  const baseline = await renderProgramNote(build([]), 0, 127, options);
  const pilePitch = await renderProgramNote(build(pile('pitch')), 0, 127, options);
  const pileAmp = await renderProgramNote(build(pile('amp')), 0, 127, options);
  return {
    baselineHz: baseline.frequency,
    pilePitchHz: pilePitch.frequency,
    baselinePeak: baseline.peak,
    pileAmpPeak: pileAmp.peak,
  };
}

/**
 * §4.3 and §5.6 guards over real params and real worklets (spec §11.2, §13.5, issue #97).
 * The unit suite writes NaN to a fake `AudioParam`, which merely records the call; only a real
 * one goes permanently silent, and only a real WASM kernel keeps a NaN coefficient.
 */
async function paramGuardProof(): Promise<ParamGuardResult> {
  const ramp = await renderRampGuardOffline();
  const limiter = await renderKernelGuardOffline('limiter');
  const reverb = await renderKernelGuardOffline('reverb');
  return {
    rampRms: ramp.rms,
    rampFinite: ramp.finite,
    limiterRms: limiter.rms,
    limiterFinite: limiter.finite,
    reverbRms: reverb.rms,
    reverbFinite: reverb.finite,
  };
}

/**
 * §9.4 WAV header refusals through the shipped decoder (issue #66). Each case is built here
 * rather than stored, per §11.2; an empty message means the decoder accepted the file.
 */
function wavHeaderProof(): WavHeaderResult {
  const ascii4 = (view: DataView, offset: number, text: string): void => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const riff = (chunks: { id: string; body: Uint8Array }[]): Uint8Array => {
    let size = 4;
    for (const chunk of chunks) size += 8 + chunk.body.length + (chunk.body.length & 1);
    const bytes = new Uint8Array(8 + size);
    const view = new DataView(bytes.buffer);
    ascii4(view, 0, 'RIFF');
    view.setUint32(4, size, true);
    ascii4(view, 8, 'WAVE');
    let cursor = 12;
    for (const chunk of chunks) {
      ascii4(view, cursor, chunk.id);
      view.setUint32(cursor + 4, chunk.body.length, true);
      bytes.set(chunk.body, cursor + 8);
      cursor += 8 + chunk.body.length + (chunk.body.length & 1);
    }
    return bytes;
  };
  const fmtBody = (): Uint8Array => {
    const body = new Uint8Array(16);
    const view = new DataView(body.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(2, 1, true);
    view.setUint32(4, 48_000, true);
    view.setUint32(8, 96_000, true);
    view.setUint16(12, 2, true);
    view.setUint16(14, 16, true);
    return body;
  };
  // 40 bytes of body keeps every stream past the 44-byte minimum, so each case is refused
  // for the reason it names rather than for being too short.
  const data = { id: 'data', body: new Uint8Array(40) };
  const shortFmt = { id: 'fmt ', body: fmtBody().slice(0, 8) };
  const badAlign = fmtBody();
  new DataView(badAlign.buffer).setUint16(12, 99, true);

  const cases: { name: string; bytes: Uint8Array }[] = [
    { name: 'no fmt chunk', bytes: riff([data]) },
    { name: 'fmt body shorter than 16 bytes', bytes: riff([shortFmt, data]) },
    {
      name: 'two fmt chunks',
      bytes: riff([{ id: 'fmt ', body: fmtBody() }, { id: 'fmt ', body: fmtBody() }, data]),
    },
    { name: 'block align contradicts the header', bytes: riff([{ id: 'fmt ', body: badAlign }, data]) },
  ];

  let goodDecodes = false;
  try {
    const decoded = decodeWav(encodeWav([Float32Array.from([0, 0.5, -0.5])], 48_000, '16'));
    goodDecodes = decoded.channels.length === 1 && decoded.sampleRate === 48_000;
  } catch {
    goodDecodes = false;
  }

  const refusals = cases.map(({ name, bytes }) => {
    try {
      decodeWav(bytes);
      return { name, message: '' }; // accepted — the defect
    } catch (error) {
      return { name, message: error instanceof Error ? error.message : String(error) };
    }
  });
  return { goodDecodes, refusals };
}

/**
 * The §7.1 silent-failure modes over the real SAB and the real scheduler worker (issue #95).
 *
 * The seqlock half needs a genuine `SharedArrayBuffer` and `Atomics`, so it exists only under
 * cross-origin isolation (§2.1) — the unit environment cannot reach it. The live-erase half
 * drives an actual stop and restart through the worker, which is where the stale arming lived.
 */
async function sequencerGuardProof(engine: AudioEngine): Promise<SequencerGuardResult> {
  const sab = createPlayheadSab();
  const writer = new PlayheadWriter(sab);
  const reader = new PlayheadReader(sab);
  writer.write(3_840, true, false, false);
  const fresh = reader.read();
  // Leave the generation odd: a write in progress that never completes.
  const header = new Int32Array(sab, 0, 2);
  Atomics.store(header, 0, Atomics.load(header, 0) + 1);
  const torn = reader.read();

  // --- live erase across a stop, over the real worker ---
  // The shell opens one at boot; opening it here too keeps the probe callable before that
  // has finished, through the app's own path rather than a test-only shortcut.
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const note = 36;
  const sequence = { ...createDefaultSequence(projectId, 0, 'Erase probe', seqId), lengthBars: 1 };
  const track = createDefaultTrack(seqId, null, 0, 'Erase probe', 'drum', trackId);
  const restoreEvents = (): void => {
    useSequenceStore.getState().hydrate({
      sequences: { [seqId]: sequence },
      tracks: { [trackId]: track },
      events: {
        [trackId]: [0, 960, 1_920, 2_880].map((tickStart) => ({
          id: crypto.randomUUID(),
          tickStart,
          durationTicks: 120,
          note,
          velocity: 100,
          extra: null,
        })),
      },
      automation: {},
      songEntries: [],
    });
  };
  restoreEvents();

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setPlaybackMode('sequence');
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  const eventsBeforeErase = (useSequenceStore.getState().events[trackId] ?? []).length;

  // A pass with the pad held over Erase. Losing the notes here is §7.7 working, and it is the
  // control: it proves the erase really did reach the worker.
  useTransportStore.getState().play();
  await delay(150);
  engine.scheduler.setLiveErase(trackId, note, true);
  await delay(2_400);
  useTransportStore.getState().stop();
  await delay(250);
  const eventsAfterHeldPass = (useSequenceStore.getState().events[trackId] ?? []).length;

  // Restore the notes and play again with NOTHING held — the user has finished with Erase and
  // released it, and the worker was never told, because a stop is what releases it. Un-fixed,
  // the arming survived the stop and this pass deleted them all over again (issue #95).
  restoreEvents();
  await delay(150);
  useTransportStore.getState().play();
  await delay(2_400);
  useTransportStore.getState().stop();
  await delay(250);
  const eventsAfterReplay = (useSequenceStore.getState().events[trackId] ?? []).length;

  return {
    freshTick: fresh.currentTick,
    freshStale: fresh.stale,
    tornTick: torn.currentTick,
    tornStale: torn.stale,
    eventsBeforeErase,
    eventsAfterHeldPass,
    eventsAfterReplay,
  };
}

/**
 * A mid-playback tempo change over the real transport, worker and playhead SAB (issue #74).
 *
 * The change goes in through `store/tempo.ts`, which is where a tempo edit enters the model,
 * so this drives the same path the transport bar's knob does. Un-fixed, halving the tempo
 * after four seconds re-read the elapsed playback at the new tempo and the playhead jumped
 * back by half of everything already played.
 */
async function tempoChangeProof(engine: AudioEngine): Promise<TempoChangeResult> {
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqId = crypto.randomUUID();
  const sequence = { ...createDefaultSequence(projectId, 0, 'Tempo probe', seqId), lengthBars: 8 };
  useSequenceStore.getState().hydrate({
    sequences: { [seqId]: sequence },
    tracks: {},
    events: {},
    automation: {},
    songEntries: [],
  });
  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setPlaybackMode('sequence');
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setRecording(false);
  transport.setLoop({ enabled: false, startTick: 0, endTick: 0 });
  commitTempo(160);
  await delay(120);

  useTransportStore.getState().play();
  await delay(4_000); // long enough that a retroactive re-time is unmistakable
  const beforeChange = engine.playheadTick();
  commitTempo(80);
  await delay(150); // one scheduler wake plus slack
  const afterChange = engine.playheadTick();
  await delay(1_000);
  const afterSettling = engine.playheadTick();
  useTransportStore.getState().stop();
  await delay(150);

  return {
    beforeChange,
    afterChange,
    afterSettling,
    bpmAfter: useTransportStore.getState().bpm,
  };
}

/**
 * Every §9.5 bounce, driven over the REAL path and read back (issue #104).
 *
 * The defect was never the render: three of the four variants encoded a correct WAV into
 * `/projects/{id}/bounces/`, which is OPFS — a store no part of the UI browses and no file
 * manager opens. So this asserts the step that was missing, the read-back, for each variant
 * in turn, over real OPFS rather than the unit suite's fake (spec §13.5).
 */
async function bounceReachProof(): Promise<BounceReachResult> {
  const { bounceActiveSequence, bounceSong, bounceTrack, resampleSequenceToSample } =
    await import('@/core/audio/bounceService');
  const { readFile } = await import('@/core/storage/opfs');
  const ctx = sampleEditContext();

  const sequenceId = useTransportStore.getState().activeSequenceId;
  if (!sequenceId) throw new Error('no active sequence to bounce');
  const trackId = Object.values(useSequenceStore.getState().tracks).find(
    (track) => track.sequenceId === sequenceId,
  )?.id;
  if (!trackId) throw new Error('the active sequence has no track to bounce as a stem');

  // Song mode needs an entry, and a fresh project has none (spec §7.9).
  if (useSequenceStore.getState().songEntries.length === 0) {
    useSequenceStore
      .getState()
      .setSongEntries([{ id: crypto.randomUUID(), position: 0, sequenceId, repeats: 1 }]);
  }

  const bytesAt = async (path: string) => (await readFile(path)).size;
  const sequenceBytes = await bytesAt(await bounceActiveSequence('probe-sequence', ctx));
  const songBytes = await bytesAt(await bounceSong('probe-song', ctx));
  const stemBytes = await bytesAt(await bounceTrack(trackId, 'probe-stem', ctx));

  const resampled = await resampleSequenceToSample('probe-resample', ctx);
  const resampledBytes = await bytesAt(resampled.opfs_path);
  // The library query the Browser runs, not the row it was just handed: a resample the user
  // cannot find in the list is as unreachable as a bounce in `/bounces/`.
  const listed = await ctx.repos.samples.listByProject(ctx.projectId);

  return {
    sequenceBytes,
    songBytes,
    stemBytes,
    resampledSampleId: resampled.id,
    resampledBytes,
    resampledIsBrowsable: listed.rows.some((row) => row.id === resampled.id),
  };
}

/**
 * A continuous gesture against the live audio graph (spec §3.3, §4.1, issue #27).
 *
 * `setTransient` used to be an ordinary `set()`, which replaces the `channels` map's identity
 * — so every component selecting it re-rendered on every pointer sample and every rAF-aligned
 * CC frame. This drives sixty samples through the real store, sync layer and graph, counting
 * what React was asked to do and measuring what the master gain actually did.
 */
async function gestureRenderProof(engine: AudioEngine): Promise<GestureRenderResult> {
  const { channelLevelPath } = await import('@/core/audio/params/registry');
  const path = channelLevelPath('master');

  /** The master meter's peak from one demo pad hit — the audible reading (spec §5.8). */
  const peakOfOneHit = async (): Promise<number> => {
    await engine.triggerDemoPad(110);
    let peak = 0;
    const started = performance.now();
    while (performance.now() - started < 400) {
      const slot = engine.meterRegistry.slotOf('master');
      if (slot !== undefined) {
        const reading = engine.meterRegistry.read(slot);
        peak = Math.max(peak, reading.peakL, reading.peakR);
      }
      await delay(10);
    }
    return peak;
  };

  useMixerStore.getState().commit(path, 1);
  await delay(60);
  const peakBefore = await peakOfOneHit();

  let notifications = 0;
  const stop = useMixerStore.subscribe(
    (state) => state.channels,
    () => {
      notifications += 1;
    },
  );

  // A drag from full down to a quarter, at the sample rate a pointer or a §10.4 rAF-aligned
  // encoder produces. Every one of these used to replace the `channels` map's identity.
  const samplesSent = 60;
  for (let sample = 0; sample < samplesSent; sample += 1) {
    useMixerStore.getState().setTransient(path, 1 - (0.75 * (sample + 1)) / samplesSent);
  }
  const notificationsDuringGesture = notifications;
  await delay(60);
  const peakDuringGesture = await peakOfOneHit();

  notifications = 0;
  useMixerStore.getState().commit(path, 1);
  const notificationsAtCommit = notifications;
  stop();
  await delay(60);
  const peakAfterCommit = await peakOfOneHit();

  return {
    notificationsDuringGesture,
    notificationsAtCommit,
    peakBefore,
    peakDuringGesture,
    peakAfterCommit,
    samplesSent,
  };
}

/** The id shape the §6/§9.3 default factories take, so a probe can mint one (spec §1.3.1). */
type Uuid = ReturnType<typeof crypto.randomUUID>;

/** Collect every event the dispatcher realises while the given body runs (spec §11.4). */
async function captureScheduled(engine: AudioEngine, body: () => Promise<void>): Promise<ScheduledEvent[]> {
  const seen: ScheduledEvent[] = [];
  const stop = engine.watchScheduledEvents((event) => seen.push(event));
  try {
    await body();
  } finally {
    stop();
  }
  return seen;
}

/**
 * Create the §9.3 rows a hydrated sequence and track need before anything records into them.
 *
 * `hydrate` is the DB → store load path and marks nothing dirty (spec §4.4), so a track that
 * exists only in memory leaves a recorded take's autosave failing forever on the
 * midi_events → tracks foreign key — see the note on `recordThenPlayback`.
 */
async function createSequenceRows(
  projectId: string,
  sequences: readonly { id: Uuid; name: string }[],
  tracks: readonly { id: Uuid; sequenceId: string; name: string }[],
): Promise<{ sequences: Record<string, Sequence>; tracks: Record<string, Track> }> {
  const repos = getActiveRepositories();
  const seqMap: Record<string, Sequence> = {};
  const trackMap: Record<string, Track> = {};
  for (const [position, spec] of sequences.entries()) {
    const sequence = { ...createDefaultSequence(projectId, position, spec.name, spec.id), lengthBars: 1 };
    seqMap[sequence.id] = sequence;
    await repos.sequences.create({
      id: sequence.id,
      project_id: sequence.projectId,
      position: sequence.position,
      name: sequence.name,
      length_bars: sequence.lengthBars,
      time_sig_numerator: sequence.timeSig.numerator,
      time_sig_denominator: sequence.timeSig.denominator,
      tempo: sequence.tempo,
      swing_amount: sequence.swingAmount,
      swing_division: sequence.swingDivision,
    });
  }
  for (const [position, spec] of tracks.entries()) {
    const track = createDefaultTrack(spec.sequenceId, null, position, spec.name, 'drum', spec.id);
    trackMap[track.id] = track;
    await repos.tracks.create({
      id: track.id,
      sequence_id: track.sequenceId,
      program_id: track.programId,
      position: track.position,
      name: track.name,
      type: track.type,
      mixer: '{}',
    });
  }
  return { sequences: seqMap, tracks: trackMap };
}

/**
 * Song mode does everything sequence mode does (spec §7.9, issue #94), over the real worker.
 *
 * A three-entry song of one-bar sequences — A, B, A — 2 s each at 120 bpm, so 6 s in all. It
 * carries a sequence-scope automation lane on A, a live-erase arm on A's track, and a pad
 * played into the MIDDLE entry. Three entries rather than two, because the per-pass flush
 * fires as the scheduler crosses INTO the next segment: a take played in the last entry has
 * no boundary left to be merged across, so it would prove nothing while the song still rolls.
 *
 * Before the fix `scheduleSong` emitted written notes and nothing else — the ramp count was
 * 0, the erase never fired, and the take stayed uncommitted until the transport stopped, at
 * a tick on the song timeline that its own one-bar pattern could never reach.
 */
async function songParityProof(engine: AudioEngine): Promise<SongParityResult> {
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqA = crypto.randomUUID();
  const seqB = crypto.randomUUID();
  const trackA = crypto.randomUUID();
  const trackB = crypto.randomUUID();
  const rows = await createSequenceRows(
    projectId,
    [
      { id: seqA, name: 'Song probe A' },
      { id: seqB, name: 'Song probe B' },
    ],
    [
      { id: trackA, sequenceId: seqA, name: 'Song probe A' },
      { id: trackB, sequenceId: seqB, name: 'Song probe B' },
    ],
  );

  const target = `mixer.track:${trackA}.level`;
  const lane = automationLaneKey('sequence', seqA, target);
  const erasedNote = 36;
  useSequenceStore.getState().hydrate({
    sequences: rows.sequences,
    tracks: rows.tracks,
    events: {
      [trackA]: [0, 960, 1_920, 2_880].map((tickStart) => ({
        id: crypto.randomUUID(),
        tickStart,
        durationTicks: 120,
        note: erasedNote,
        velocity: 100,
        extra: null,
      })),
    },
    automation: {
      [lane]: [0, 3_840].map((tick, index) => ({
        id: crypto.randomUUID(),
        scope: 'sequence' as const,
        ownerId: seqA,
        targetPath: target,
        tick,
        value: index === 0 ? 0 : 1,
        curve: 'linear' as const,
      })),
    },
    songEntries: [
      { id: crypto.randomUUID(), position: 0, sequenceId: seqA, repeats: 1 },
      { id: crypto.randomUUID(), position: 1, sequenceId: seqB, repeats: 1 },
      { id: crypto.randomUUID(), position: 2, sequenceId: seqA, repeats: 1 },
    ],
  });

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqA);
  transport.setPlaybackMode('song');
  transport.setSongLoopEnabled(false);
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setRecordMode('overdub');
  commitTempo(120);
  await delay(150);

  const eventsBeforeErase = (useSequenceStore.getState().events[trackA] ?? []).length;
  let flushedWhilePlaying = 0;
  let flushedTick = -1;

  const scheduled = await captureScheduled(engine, async () => {
    useTransportStore.getState().setRecording(true);
    // Armed BEFORE the transport rolls, or the first window is already scheduled and swept
    // by the time the arm reaches the worker, leaving the note on tick 0 behind.
    engine.scheduler.setLiveErase(trackA, erasedNote, true);
    useTransportStore.getState().play();
    // The pad is played into the MIDDLE entry (2–4 s), so the per-pass flush has the entry
    // boundary at 4 s to merge it across while the transport is still rolling.
    await delay(2_500);
    engine.scheduler.sendLiveNote(40, 110, true, performance.now(), trackB);
    await delay(200);
    engine.scheduler.sendLiveNote(40, 110, false, performance.now(), trackB);
    await delay(2_100); // past the 4 s boundary, still inside the 6 s song
    const merged = useSequenceStore.getState().events[trackB] ?? [];
    flushedWhilePlaying = merged.length;
    flushedTick = merged[0]?.tickStart ?? -1;
  });

  useTransportStore.getState().stop();
  useTransportStore.getState().setRecording(false);
  engine.scheduler.setLiveErase(trackA, erasedNote, false);
  await delay(250);

  const ramps = scheduled.filter((e) => e.kind === 'automationRamp' && e.target === target);
  return {
    automationRamps: ramps.length,
    firstAutomationValue: ramps[0]?.value ?? -1,
    lastAutomationValue: ramps[ramps.length - 1]?.value ?? -1,
    eventsBeforeErase,
    eventsAfterErase: (useSequenceStore.getState().events[trackA] ?? []).length,
    flushedWhilePlaying,
    flushedTick,
    patternLengthTicks: 3_840,
  };
}

/**
 * A live-erase sweep across the loop end takes the ticks it PASSED (spec §7.7, issue #16).
 *
 * The fix landed in `collectErase` long before this proof did, and every check on it until
 * now was a unit test against `SchedulerCore` with an injected clock. That cannot see the
 * one thing the issue is about: the shape of the window a REAL 25 ms wake at a REAL 100 ms
 * lookahead hands the sweep as the playhead crosses a bar line. Folding the two ends of that
 * window and taking min/max yields its complement, so under the defect the survivors and the
 * victims here swap places — which is why both lists are reported rather than a count.
 */
async function liveEraseWrapProof(engine: AudioEngine): Promise<LiveEraseWrapResult> {
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const rows = await createSequenceRows(
    projectId,
    [{ id: seqId, name: 'Erase probe' }],
    [{ id: trackId, sequenceId: seqId, name: 'Erase probe' }],
  );
  const erasedNote = 36;
  // One bar of 4/4 at 960 PPQN is 3840 ticks and, at 120 bpm, two seconds. Four notes sit
  // well inside the bar and one sits just before its end, so a sweep over the bar line takes
  // the last of them and the first of the next pass and leaves the middle three alone.
  const ticks = [0, 960, 1_920, 2_880, 3_600];
  useSequenceStore.getState().hydrate({
    sequences: rows.sequences,
    tracks: rows.tracks,
    events: {
      [trackId]: ticks.map((tickStart) => ({
        id: crypto.randomUUID(),
        tickStart,
        durationTicks: 120,
        note: erasedNote,
        velocity: 100,
        extra: null,
      })),
    },
    automation: {},
    songEntries: [],
  });

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setPlaybackMode('sequence');
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  commitTempo(120);
  await delay(150);

  const ticksBefore = (useSequenceStore.getState().events[trackId] ?? [])
    .map((e) => e.tickStart)
    .sort((a, b) => a - b);

  useTransportStore.getState().play();
  // Arm just before the bar line at 2.0 s and release just after it. The lookahead runs
  // ~100 ms ahead, so the swept window is roughly ticks 3550 → 4300 — the note at 3600 and,
  // one pass later, the note at 0, with a third of a second of margin either side of the
  // nearest survivor (2880 below, and 960 of the next pass above).
  await delay(1_750);
  engine.scheduler.setLiveErase(trackId, erasedNote, true);
  await delay(400);
  engine.scheduler.setLiveErase(trackId, erasedNote, false);
  await delay(250);
  useTransportStore.getState().stop();
  await delay(200);

  return {
    ticksBefore,
    ticksAfter: (useSequenceStore.getState().events[trackId] ?? [])
      .map((e) => e.tickStart)
      .sort((a, b) => a - b),
    loopLengthTicks: 3_840,
  };
}

/**
 * `songAdvanced { entryIndex }` addresses §7.9's position-sorted ENTRY list (issue #130).
 *
 * The playlist is two entries and three plays: the first entry repeats twice. Before this,
 * `sequencerSync` expanded `repeats` on the main thread, so the worker saw three entries and
 * reported 0, 1, 2 — and §8.5.12's playlist, which has two rows, would have marked a row that
 * does not exist. The proof reads BOTH halves: what the worker reported, and which row the
 * running Song mode actually marked while the repeated entry was still playing.
 */
async function songEntryIndexProof(): Promise<SongEntryIndexResult> {
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqA = crypto.randomUUID();
  const seqB = crypto.randomUUID();
  // A track per sequence, though this proof plays no notes: `hydrate` REPLACES the store, so
  // a probe leaving none behind hands every later step a project with nothing to edit.
  const rows = await createSequenceRows(
    projectId,
    [
      { id: seqA, name: 'Entry probe A' },
      { id: seqB, name: 'Entry probe B' },
    ],
    [
      { id: crypto.randomUUID(), sequenceId: seqA, name: 'Entry probe A' },
      { id: crypto.randomUUID(), sequenceId: seqB, name: 'Entry probe B' },
    ],
  );
  useSequenceStore.getState().hydrate({
    sequences: rows.sequences,
    tracks: rows.tracks,
    events: {},
    automation: {},
    // Written out of `position` order on purpose: §7.9 orders by the field, not the array.
    songEntries: [
      { id: crypto.randomUUID(), position: 1, sequenceId: seqB, repeats: 1 },
      { id: crypto.randomUUID(), position: 0, sequenceId: seqA, repeats: 2 },
    ],
  });

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqA);
  transport.setPlaybackMode('song');
  transport.setSongLoopEnabled(false);
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  commitTempo(120);
  await delay(150);

  // Every distinct value the consumer settled on, in order — the §8.5.12 row is painted
  // from this, so a repeat-expanded index shows up here as a third value.
  const reportedIndices: number[] = [];
  const record = (index: number | null) => {
    if (index !== null && reportedIndices[reportedIndices.length - 1] !== index) {
      reportedIndices.push(index);
    }
  };
  record(useTransportStore.getState().songEntryIndex);
  const unsubscribe = useTransportStore.subscribe((state) => state.songEntryIndex, record);

  let markedRowText = '';
  let markedRowIndex = -1;
  try {
    useTransportStore.getState().play();
    // The first entry occupies 0–4 s (one bar twice at 120 bpm); read the marked row during
    // its SECOND play, where a repeat-expanded index would already have stepped off it.
    await delay(3_000);
    const marked = document.querySelector<HTMLElement>('[data-playing="true"]');
    markedRowText = marked?.textContent?.trim() ?? '';
    markedRowIndex = marked
      ? Number(marked.getAttribute('data-testid')?.replace('song-entry-', '') ?? -1)
      : -1;
    // …then on into the second entry (4–6 s) and past the end of the song.
    await delay(2_500);
  } finally {
    unsubscribe();
    useTransportStore.getState().stop();
    // Back to sequence mode, so a later step meets the transport the rest of the smoke
    // assumes rather than one that stops itself at the end of this probe's song (§7.9).
    useTransportStore.getState().setPlaybackMode('sequence');
  }
  await delay(200);

  return {
    reportedIndices,
    entryCount: useSequenceStore.getState().songEntries.length,
    segmentCount: useSequenceStore.getState().songEntries.reduce((sum, entry) => sum + entry.repeats, 0),
    markedRowText,
    markedRowIndex,
  };
}

/**
 * One pad held on two tracks (spec §7.3, issue #25), over the real worker, in both modes.
 *
 * §1.3.1 maps a pad index straight to a note number, so note 36 held on two tracks is two
 * distinct held entries. Resolving a hit's owner by note number returned the first for both,
 * so the second track sounded nothing and its part was recorded into the first. Song mode is
 * the same test again, where note repeat and the arpeggiator never ran at all (issue #94).
 */
async function noteRepeatOwnerProof(engine: AudioEngine): Promise<NoteRepeatOwnerResult> {
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqId = crypto.randomUUID();
  const one = crypto.randomUUID();
  const two = crypto.randomUUID();
  const rows = await createSequenceRows(
    projectId,
    [{ id: seqId, name: 'Repeat probe' }],
    [
      { id: one, sequenceId: seqId, name: 'Repeat one' },
      { id: two, sequenceId: seqId, name: 'Repeat two' },
    ],
  );
  useSequenceStore.getState().hydrate({
    sequences: rows.sequences,
    tracks: rows.tracks,
    events: {},
    automation: {},
    songEntries: [{ id: crypto.randomUUID(), position: 0, sequenceId: seqId, repeats: 1 }],
  });

  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setMetronomeEnabled(false);
  transport.setCountInBars(0);
  transport.setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  commitTempo(120);

  const note = 36;
  const division = { value: 8, triplet: false } as const;
  /** Hold the same note on both tracks and collect what the worker schedules for a bar. */
  async function heldPass(mode: 'sequence' | 'song'): Promise<ScheduledEvent[]> {
    useTransportStore.getState().setPlaybackMode(mode);
    await delay(150);
    const events = await captureScheduled(engine, async () => {
      useTransportStore.getState().play();
      await delay(100);
      engine.scheduler.setNoteRepeat(true, division);
      engine.scheduler.sendLiveNote(note, 100, true, performance.now(), one);
      engine.scheduler.sendLiveNote(note, 60, true, performance.now(), two);
      await delay(1_500);
      engine.scheduler.sendLiveNote(note, 100, false, performance.now(), one);
      engine.scheduler.sendLiveNote(note, 60, false, performance.now(), two);
      useTransportStore.getState().stop();
      await delay(200);
    });
    engine.scheduler.setNoteRepeat(false, division);
    await delay(150);
    return events;
  }

  const sequenceEvents = await heldPass('sequence');
  const songEvents = await heldPass('song');

  const arpConfig = { mode: 'up' as const, octaves: 1, gate: 0.5, division };
  // A different two-note chord per track, so each track's arp is identifiable by pitch.
  const chords: readonly (readonly [number, string])[] = [
    [60, one],
    [64, one],
    [72, two],
    [76, two],
  ];
  const songArpEvents = await captureScheduled(engine, async () => {
    useTransportStore.getState().setPlaybackMode('song');
    await delay(150);
    useTransportStore.getState().play();
    await delay(100);
    engine.scheduler.setArpeggiator(true, arpConfig);
    for (const [pitch, track] of chords) {
      engine.scheduler.sendLiveNote(pitch, 100, true, performance.now(), track);
    }
    await delay(1_500);
    for (const [pitch, track] of chords) {
      engine.scheduler.sendLiveNote(pitch, 100, false, performance.now(), track);
    }
    useTransportStore.getState().stop();
    await delay(200);
  });
  engine.scheduler.setArpeggiator(false, arpConfig);
  await delay(150);

  const hitsOn = (events: ScheduledEvent[], trackId: string) =>
    events.filter((e) => e.kind === 'noteOn' && e.trackId === trackId && e.note === note);
  const arpOn = (trackId: string) =>
    [
      ...new Set(
        songArpEvents.filter((e) => e.kind === 'noteOn' && e.trackId === trackId).map((e) => e.note ?? -1),
      ),
    ].sort((a, b) => a - b);

  return {
    sequenceHits: { one: hitsOn(sequenceEvents, one).length, two: hitsOn(sequenceEvents, two).length },
    sequenceVelocities: {
      one: [...new Set(hitsOn(sequenceEvents, one).map((e) => e.velocity ?? -1))],
      two: [...new Set(hitsOn(sequenceEvents, two).map((e) => e.velocity ?? -1))],
    },
    songHits: { one: hitsOn(songEvents, one).length, two: hitsOn(songEvents, two).length },
    songArpNotes: { one: arpOn(one), two: arpOn(two) },
  };
}

/**
 * The §7.1.3 worker boundary (issue #96): the handshake carries a version, and the guard is
 * no looser than the store it mirrors. Pure, but run here through the same module the real
 * worker imports, so the check is against the shipped bundle rather than a Node build of it.
 */
function schedulerBoundaryProof(): SchedulerBoundaryResult {
  const handshake = parseSchedulerRequest({
    kind: 'init',
    playheadSab: createPlayheadSab(),
    protocolVersion: SCHEDULER_PROTOCOL_VERSION,
  });
  const refuses = (name: string, value: unknown) => ({
    name,
    refused: parseSchedulerRequest(value) === null,
  });
  return {
    attachedVersion: (handshake?.kind === 'init' ? handshake.protocolVersion : null) ?? null,
    acceptsInRangeTempo: parseSchedulerRequest({ kind: 'tempo', bpm: 128 }) !== null,
    acceptsVersionlessHandshake:
      parseSchedulerRequest({ kind: 'init', playheadSab: createPlayheadSab() }) !== null,
    refusals: [
      refuses('tempo bpm -1', { kind: 'tempo', bpm: -1 }),
      refuses('swing amount 100', { kind: 'swing', amount: 100, division: 16 }),
      refuses('sequenceMeta projectBpm -60', {
        kind: 'sequenceMeta',
        sequences: { a: { lengthBars: 1, timeSigNumerator: 4, timeSigDenominator: 4, tempo: null } },
        projectBpm: -60,
        activeSequenceId: 'a',
        playbackMode: 'sequence',
      }),
      refuses('trackId with a colon', { kind: 'liveErase', trackId: 'track:1', note: 36, active: true }),
    ],
  };
}

/**
 * The §5.4 declick follows a pitch-modulated voice's real end (issue #87).
 *
 * A pitch envelope varies `source.detune` inside the AudioParam, and detune IS the playback
 * rate, so the buffer runs out at a time no base-rate estimate predicts. Sweeping an octave
 * DOWN halves the rate at note-on, so the swept voice must sound audibly longer than the flat
 * one — and still land on near-silence rather than stepping to zero.
 */
async function declickContourProof(): Promise<DeclickContourResult> {
  const build = (semitones: number) => {
    const program = createDefaultDrumProgram('Declick probe');
    const pad = createDefaultPad(0);
    pad.layers = [layer({ sampleId: 'offline' })];
    pad.pitchEnvSemitones = semitones;
    pad.envelopes = {
      ...pad.envelopes,
      // Start a full octave flat and rise back to unity across the note.
      pitch: { attack: 0, hold: 0, decay: 600, sustain: 0, release: 10, curve: 'linear' },
      amp: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 10, curve: 'linear' },
    };
    program.pads = [pad];
    return program;
  };
  const options = { baseFrequency: 300, seconds: 0.9, sampleSeconds: 0.3 } as const;
  const flat = await renderProgramNote(build(0), 0, 100, options);
  const swept = await renderProgramNote(build(-12), 0, 100, options);
  return {
    flatSeconds: flat.soundingSeconds,
    sweptSeconds: swept.soundingSeconds,
    sweptFinalMagnitude: swept.finalMagnitude,
  };
}

/** Live regions in the document, tagged by the `data-testid` that identifies each. */
function liveRegionIds(): string[] {
  return [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].map(
    (element) =>
      element.getAttribute('data-testid') ?? `${element.tagName}[role=${element.getAttribute('role') ?? ''}]`,
  );
}

/** Let React commit and the announcer's effect run before reading the DOM back. */
function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function regionText(testId: string): string {
  return document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
}

/**
 * Spec §8.2 requires ONE announcer. This drives the real toast queue and reads the real
 * DOM back, because the defect issue #34 reports — several regions competing, announcements
 * dropped — is invisible to anything that inspects a component in isolation (spec §13.5).
 *
 * Every message it raises begins with "Probe ", because the severity split it demonstrates
 * needs a real error and a real warning toast, and §11.4 fails the smoke on either. The
 * smoke step that calls this takes its own traffic back out of the toast log.
 */
async function announcementProof(): Promise<AnnouncementResult> {
  const ui = useUIStore.getState();
  for (const toast of ui.toasts) ui.dismissToast(toast.id);
  await settle();
  const regionsIdle = liveRegionIds().length;

  useUIStore.getState().pushToast('Probe error notice', 'error');
  await settle();
  const assertiveAfterError = regionText('live-region-assertive');
  const politeAfterError = regionText('live-region');

  useUIStore.getState().pushToast('Probe advisory notice', 'info');
  await settle();
  const politeAfterInfo = regionText('live-region');
  const assertiveAfterInfo = regionText('live-region-assertive');

  useUIStore.getState().pushToast('Probe warning notice', 'warning');
  await settle();
  const ids = liveRegionIds();
  const result: AnnouncementResult = {
    regionsIdle,
    regionsWithToasts: ids.length,
    toastsOnScreen: document.querySelectorAll('[data-testid="toast"]').length,
    assertiveAfterError,
    politeAfterError,
    politeAfterInfo,
    assertiveAfterInfo,
    strayRegions: ids.filter((id) => id !== 'live-region' && id !== 'live-region-assertive'),
  };

  const after = useUIStore.getState();
  for (const toast of after.toasts) after.dismissToast(toast.id);
  return result;
}

/**
 * Spec §9.7 asks for "a persistent dismissible warning that the browser may evict data".
 * This drives the real §9.7 state through the store the always-mounted gauge publishes to,
 * then reads the shell back — a `title` attribute would satisfy an inspection and fail a
 * keyboard (issue #51).
 */
async function platformNoticeProof(): Promise<PlatformNoticeResult> {
  // Restored at the end: a probe that leaves a FABRICATED refusal behind would have every
  // later step of a smoke run reading a warning the browser never gave.
  const granted = useUIStore.getState().storagePersisted;

  useUIStore.getState().setStoragePersisted(true);
  await settle();
  const noticesWhileGranted = document.querySelectorAll('[data-testid^="platform-notice-"]').length;

  useUIStore.getState().setStoragePersisted(false);
  await settle();
  const notice = document.querySelector('[data-testid="platform-notice-persistentStorage"]');
  const dismiss = notice?.querySelector('button');
  const result = {
    noticesWhileGranted,
    text: notice?.textContent ?? '',
    dismissName: dismiss?.getAttribute('aria-label') ?? '',
    dismissFocusable: dismiss instanceof HTMLElement && dismiss.tabIndex >= 0,
    gaugeTitle: document.querySelector('[data-testid="transport-storage"]')?.getAttribute('title') ?? '',
  };

  if (dismiss instanceof HTMLElement) dismiss.click();
  await settle();
  const noticesAfterDismiss = document.querySelectorAll(
    '[data-testid="platform-notice-persistentStorage"]',
  ).length;

  if (granted !== null) useUIStore.getState().setStoragePersisted(granted);
  return { ...result, noticesAfterDismiss };
}

/**
 * A slot's params are the ones the graph runs, however the slot got there (issue #131).
 *
 * §3.4 requires that "the store value reflects the actual node state", and the two halves are
 * measured separately here because that is the only way the disagreement is visible: the
 * store number is taken through the same fallback every reader uses, and the graph number is
 * an offline render of a delay built from the slot's params VERBATIM — the record
 * `applyInserts` hands `createInsert` (spec §4.3, §11.2).
 *
 * Three slots, because a fix at the creating action alone leaves the third one wrong: one
 * just added, one after a real save and reload, and one written into the §9.3 `tracks.mixer`
 * column the way a build before this fix wrote it.
 */
async function insertDefaultsProof(): Promise<InsertDefaultsResult> {
  const { insertParamPath } = await import('@/core/audio/params/registry');
  const { EFFECT_PARAM_RANGES } = await import('@/core/audio/inserts/effectParams');
  const { undo } = await import('@/store/undo').then((m) => m.useUndoStore.getState());

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load the project fresh, so the strips come off the §9.3 rows rather than from whatever an
  // earlier probe left in the stores.
  await projectService.loadProject(projectId);
  // The MASTER strip, because every project has exactly one and no mode can hide it: a track
  // strip belongs to a sequence, and §8.5.6's Tracks tab shows only the active sequence's.
  // It persists in `projects.payload` (spec §9.3), which is the column the legacy case below
  // rewrites.
  const channelId = 'master';
  const timeFloorMs = EFFECT_PARAM_RANGES.delay.time![0];

  /** The slot's delay time as the store holds it, or the §7.8 floor a reader falls back to. */
  const storedTime = (): { value: number; stored: boolean } => {
    const slot = useMixerStore.getState().channels[channelId]?.inserts.find((s) => s.id === slotId);
    // Exactly what `InsertPanel` draws and what `readScalar` takes as a gesture origin.
    return { value: slot?.params.time ?? timeFloorMs, stored: slot?.params.time !== undefined };
  };

  /** Both halves for that slot, as they stand right now. */
  const agreementNow = async (): Promise<InsertAgreement> => {
    const slot = useMixerStore.getState().channels[channelId]?.inserts.find((s) => s.id === slotId);
    const echo = await renderDelayEchoOffline({ params: slot?.params ?? {} });
    const { value, stored } = storedTime();
    return { storeTimeMs: value, stored, graphTimeMs: echo.echoSeconds * 1000, echoPeak: echo.echoPeak };
  };

  // 1 — a slot the user just added, through the action the §8.5.6 slot picker calls. It is
  // tracked by ID from here on: `replaceInsert` keeps a slot's id and a reload preserves it,
  // so the id is the one handle that survives every step below.
  useMixerStore.getState().addInsert(channelId, 'delay');
  const inserts = useMixerStore.getState().channels[channelId]!.inserts;
  const slotId = inserts.at(-1)!.id;
  // Slots are addressed 1-based in the §7.8 grammar (`slot2`).
  const path = insertParamPath(channelId, inserts.length, 'time');
  const added = await agreementNow();

  // 2 — saved and loaded back through the real §4.4 path, not re-derived in memory.
  await projectService.saveNow();
  await projectService.loadProject(projectId);
  const reloaded = await agreementNow();

  // 3 — the §9.3 column as a build BEFORE this fix wrote it: an effect, and no parameters.
  const repos = getActiveRepositories();
  const row = await repos.projects.getById(projectId);
  if (row === undefined) throw new Error('insertDefaultsProof: the active project has no row.');
  const payload = JSON.parse(row.payload) as { master?: { inserts?: { params: unknown }[] } };
  for (const slot of payload.master?.inserts ?? []) slot.params = {};
  await repos.projects.update(projectId, { payload: JSON.stringify(payload) });
  await projectService.loadProject(projectId);
  const legacy = await agreementNow();

  // 4 — the first touch of that knob, undone. The pre-gesture origin is read from the store,
  // so an absent parameter used to send the delay to its range floor on the very first undo.
  // Last, because it is the only step that puts an undo entry on the stack: an undo landing
  // on the wrong entry would take the slot itself back out from under the steps above.
  useMixerStore.getState().commit(path, 600);
  const touchedToMs = storedTime().value;
  undo();
  const undoneToMs = storedTime().value;

  return { path, added, reloaded, legacy, touchedToMs, undoneToMs };
}

export function installAudioProbe(engine: AudioEngine): void {
  window.__bangerboxAudioProbe = {
    masterPeak: () => {
      const slot = engine.meterRegistry.slotOf('master');
      if (slot === undefined) return 0;
      const reading = engine.meterRegistry.read(slot);
      return Math.max(reading.peakL, reading.peakR);
    },
    liveVoiceCount: () => engine.voicePool.activeVoiceCount(),
    playheadTick: () => engine.playheadTick(),
    churn: async (count) => {
      for (let i = 0; i < count; i++) await engine.triggerDemoPad(100);
    },
    renderEffect: (effectType, options) => renderEffectOffline(effectType, options),
    recordThenPlayback: () => recordThenPlayback(engine),
    velocityLayerPitches,
    keygroupPitches,
    reversedLayerHalves,
    warpDecouplesPitch,
    syncedLfoRates,
    lfoPhaseStart,
    delayEcho: (options) => renderDelayEchoOffline(options),
    packRoundTrip,
    samplePipelineProof: () => samplePipelineProof(engine),
    factoryInstallProof,
    refusedSwitchProof,
    storagePolicyProof,
    modClampProof,
    paramGuardProof,
    wavHeaderProof,
    sequencerGuardProof: () => sequencerGuardProof(engine),
    tempoChangeProof: () => tempoChangeProof(engine),
    bounceReachProof,
    gestureRenderProof: () => gestureRenderProof(engine),
    songParityProof: () => songParityProof(engine),
    liveEraseWrapProof: () => liveEraseWrapProof(engine),
    songEntryIndexProof: () => songEntryIndexProof(),
    insertDefaultsProof: () => insertDefaultsProof(),
    noteRepeatOwnerProof: () => noteRepeatOwnerProof(engine),
    schedulerBoundaryProof,
    declickContourProof,
    announcementProof,
    platformNoticeProof,
  };
}
