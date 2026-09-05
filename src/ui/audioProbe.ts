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
  createDefaultChannelStrip,
  createDefaultDrumProgram,
  createDefaultKeygroupProgram,
  createDefaultPad,
  createDefaultSequence,
  createDefaultTrack,
  type AutomationPoint,
  type ChannelStrip,
  type EffectType,
  type InsertSlotState,
  automationLaneKey,
  type KeygroupZone,
  type Pad,
  type ProjectPayload,
  type Sequence,
  type Track,
  type VelocityLayer,
} from '@/core/project/schemas';
import {
  useMixerStore,
  useProgramStore,
  useProjectStore,
  useSequenceStore,
  useTransportStore,
  useUIStore,
} from '@/store';
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
  /** A §9.5 bounce renders the §5.2 mixer, not a dry sum of voices (issue #134). */
  bounceMixProof: () => Promise<BounceMixResult>;
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
  /**
   * A channel's insert chain is bounded by §1.3.1 and every slot in it is addressable
   * (issue #135) — measured on the real graph through the §5.8 master tap.
   */
  insertLimitProof: () => Promise<InsertLimitResult>;
  /** A pad's §4.2 strip is reachable and survives a save + reload (§4.2, §6, §9.3, #133). */
  padStripProof: () => Promise<PadStripResult>;
  /** Sequence mode plays ONE sequence, and erases in only that one (§7.7, §7.9, #132). */
  sequenceFilterProof: () => Promise<SequenceFilterResult>;
  /** A deleted track stops sounding and leaves nothing behind (§7.1.3, §7.5, §7.8, #137). */
  trackWithdrawalProof: () => Promise<TrackWithdrawalResult>;
  /** Two tracks on one program each own their §5.2 pad channel (§5.2, §4.2, §6, #141). */
  sharedPadChannelProof: () => Promise<SharedPadChannelResult>;
  /** A §7.8 lane on a §6 sound-design parameter sounds and renders (§6, §7.8, §9.5, #138). */
  padLaneProof: () => Promise<PadLaneResult>;
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

/** Outcome of the §1.3.1 insert-limit proof (see {@link AudioProbe.insertLimitProof}). */
export interface InsertLimitResult {
  /** The §4.2 channel the proof drives, so a failure names the strip it drove. */
  readonly channelId: string;
  /** The §9.3 `projects.insert_limit` in force while the proof ran. */
  readonly limit: number;
  /** How many slots the chain holds after being asked for twelve. */
  readonly slotCount: number;
  /** How many of those hold an effect. */
  readonly occupiedCount: number;
  /** The sentence the store refused the thirteenth add with — empty if it never refused. */
  readonly refusalReason: string;
  /** The 1-based §7.8 slot numbers holding an effect that the grammar REFUSES to address. */
  readonly deadSlots: number[];
  /** The 1-based slot number the audio half drives — the last occupied one. */
  readonly drivenSlot: number;
  /** Master-tap peak with every occupied filter opened to 20 kHz by its §7.8 address. */
  readonly openPeak: number;
  /** The same peak after the driven slot is closed to 80 Hz through the same address. */
  readonly closedPeak: number;
  /** Slots an over-long chain from a §9.6 import still holds after admission — never truncated. */
  readonly admittedOverLongSlots: number;
  /** Whether `replaceInsert` refused to occupy a slot past the limit in that chain. */
  readonly replaceBeyondLimitRefused: boolean;
}

/**
 * The four §4.2 fields issue #133 loses, read from one place — the §6 payload on disk, or
 * the strip in the store. Both sides are read into the same shape so the smoke can compare
 * them without knowing which is which.
 */
export interface PadStripReading {
  readonly level: number;
  readonly pan: number;
  /** Send 2 of the four (spec §1.3.1), index 1 — a send nothing else in the proof touches. */
  readonly send1: number;
  readonly insertType: string | null;
  /** The delay's time in ms, which is also the §5.7 default the slot arrives with (#131). */
  readonly insertTimeMs: number;
}

/** Outcome of the §4.2 pad-strip proof (see {@link AudioProbe.padStripProof}). */
export interface PadStripResult {
  /** The §4.2 channel id the proof drives, so a failure names the strip it drove. */
  readonly padChannel: string;
  /** Whether a project just loaded has a pad strip at all — §8.5.6's Pads tab is dead without one. */
  readonly stripPresentOnLoad: boolean;
  /** The fader position the commit put in the store, so a gesture that reached nothing is visible. */
  readonly committedLevel: number;
  /** The same position after a real save and `loadProject`. */
  readonly reloadedLevel: number;
  /** RMS of a §9.5 bounce with the pad strip at its §4.2 default, over real OPFS. */
  readonly defaultRms: number;
  /** RMS of the same bounce after the −12 dB fader was saved and reloaded. */
  readonly reloadedRms: number;
  /** The four fields as the §9.3 `programs.payload` column holds them after `saveNow()`. */
  readonly onDisk: PadStripReading;
  /** The four fields as the strip reads them after `loadProject()`. */
  readonly afterReload: PadStripReading;
  /** RMS of the same bounce with the TRACK strip soloed, and the pad strips present (§5.2). */
  readonly soloedTrackRms: number;
}

/** Outcome of the §5.2 shared-pad-channel proof (see {@link AudioProbe.sharedPadChannelProof}). */
export interface SharedPadChannelResult {
  /** The §4.2 pad strip both tracks play, so a failure names the channel it drove. */
  readonly padChannel: string;
  /** How many §5.2 pad channels the LIVE graph holds under that one id after both tracks played. */
  readonly liveRealisations: number;
  /** RMS of a §9.5 bounce with both track faders at unity — two voices summing per hit. */
  readonly bothTracksRms: number;
  /** The same bounce with the SECOND track's fader closed. The defect leaves this unchanged. */
  readonly secondFaderClosedRms: number;
  /** The same bounce with the FIRST track's fader closed. The defect renders silence. */
  readonly firstFaderClosedRms: number;
  /** The same bounce with both faders at unity and the PAD strip at 0.8 (−12 dB, §8.5.6). */
  readonly padFaderRms: number;
  /**
   * §5.8 master peak on the FIRST live pass, with an 80 Hz lowpass already in the pad strip's
   * insert rack and the second track's fader already at 0 — both set before either channel
   * existed. Near zero when a freshly built channel is seeded from its §4.2 strip.
   */
  readonly livePeakSeeded: number;
  /** The same pass with that insert bypassed; the second track's fader is still at 0. */
  readonly livePeakSecondClosed: number;
  /** The same pass with the second track's fader opened to unity — two voices, not one. */
  readonly livePeakBoth: number;
}

/** How one beat of a §9.5 bounce sounded (see {@link PadLaneResult}). */
export interface PadLaneBeat {
  /** RMS over the first 40 ms after the hit — whether it sounded at all, and how loudly. */
  readonly headRms: number;
  /**
   * Seconds from the hit to its last audible frame. Detune IS the playback rate on a §5.2
   * stage-1 buffer source, so this is what a §7.8 `pitch` lane moves: a quarter-second region
   * two octaves up is consumed in 88 ms. A level reading cannot tell a louder hit from a
   * faster one, which is why the pitch half is read here rather than in RMS.
   */
  readonly endSeconds: number;
}

/** Outcome of the §7.8 per-voice lane proof (see {@link AudioProbe.padLaneProof}). */
export interface PadLaneResult {
  /** The §7.8 address the cutoff half drives, so a failure names the lane it rode. */
  readonly cutoffPath: string;
  /** The §7.8 address the pitch half drives. */
  readonly pitchPath: string;
  /** First and last beat of a bounce with the pad's §6 lowpass closed and NO lane. */
  readonly unautomated: readonly [PadLaneBeat, PadLaneBeat];
  /** The same bar under a lane sweeping the cutoff 60 Hz → 12 kHz. The defect renders nothing. */
  readonly cutoffSwept: readonly [PadLaneBeat, PadLaneBeat];
  /** First and last beat with the filter open and NO pitch lane — both hits full length. */
  readonly unpitched: readonly [PadLaneBeat, PadLaneBeat];
  /** The same bar under a lane raising the pad two octaves: the last hit is far shorter. */
  readonly pitchSwept: readonly [PadLaneBeat, PadLaneBeat];
  /** §5.8 master peak of a live pass begun AFTER a §7.8 write opened the pad to 12 kHz. */
  readonly liveOpenPeak: number;
  /** The same, begun after a §7.8 write closed it to 60 Hz. The defect leaves the two equal. */
  readonly liveClosedPeak: number;
}

/** Outcome of the §7.1.3 track-withdrawal proof (see {@link AudioProbe.trackWithdrawalProof}). */
export interface TrackWithdrawalResult {
  /** The track the proof deletes mid-transport, so a failure names it. */
  readonly deletedTrackId: string;
  /** The track that must be left alone. */
  readonly keptTrackId: string;
  /** Distinct track ids the worker scheduled while both tracks were in the project. */
  readonly scheduledBefore: string[];
  /** The same, measured after the delete and past one §7.1.4 lookahead window. */
  readonly scheduledAfter: string[];
  /** Peak on the §5.8 master tap with both tracks sounding the same pad in unison. */
  readonly masterPeakBefore: number;
  /** The same peak after the delete — one voice where there were two summing coherently. */
  readonly masterPeakAfter: number;
  /** Whether the §9.3 `tracks` row survived `saveNow()`. */
  readonly trackRowRemains: boolean;
  /** `midi_events` rows still addressing the deleted track after the save (§9.3 cascade). */
  readonly eventRowsRemain: number;
  /** `automation_points` rows still owned by it — the table declares no foreign key (§7.8). */
  readonly automationRowsRemain: number;
  /** Whether `projects.payload.trackGrooveIds` still carries a key for it (§7.5, §9.3). */
  readonly grooveAssignmentRemains: boolean;
  /** Whether the §4.2 `track:<id>` strip left `useMixerStore` with the track (§5.3). */
  readonly stripRemains: boolean;
  /**
   * Whether the §5.2 track channel is still in the graph a full lookahead after the delete
   * (§3.2, §5.3). `graph.removeTrackChannel` destroys it, and a residual note that fell back
   * to the demo sample used to rebuild it and leave it wired to master for the session.
   */
  readonly trackChannelRemains: boolean;
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

/** Outcome of the §7.9 sequence-filter proof (see {@link AudioProbe.sequenceFilterProof}). */
export interface SequenceFilterResult {
  /** The track on the sequence that is active when the transport rolls. */
  readonly activeTrackId: string;
  /** The track on the OTHER sequence — the one that must be silent and must not be erased. */
  readonly otherTrackId: string;
  /** Distinct track ids the worker scheduled notes for, before the active sequence changed. */
  readonly scheduledBeforeSwitch: string[];
  /** The same after switching the active sequence mid-transport, with no events re-sent. */
  readonly scheduledAfterSwitch: string[];
  /** Written ticks on each track before a live erase held over the pad both of them carry. */
  readonly activeTicksBefore: number[];
  readonly otherTicksBefore: number[];
  /** What survived it. Only the active sequence's track may lose anything (spec §7.7). */
  readonly activeTicksAfter: number[];
  readonly otherTicksAfter: number[];
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

/**
 * What one §9.5 render actually contains, measured on the WAV it wrote (issue #134).
 *
 * Every field is read back from `/bounces/` over real OPFS and decoded, so these are the
 * numbers in the file the user gets rather than anything about the graph that made it.
 */
export interface BounceMixSlice {
  readonly rms: number;
  readonly leftRms: number;
  readonly rightRms: number;
  /**
   * RMS of the gap between the first two beats. The hits are shorter than the gap, so this
   * is silence in every render EXCEPT one whose §5.2 sends reach a return that delays them.
   */
  readonly gapRms: number;
  /** RMS of the first and last beats — how a §7.8 lane riding the master fader shows itself. */
  readonly firstBeatRms: number;
  readonly lastBeatRms: number;
}

/** One §9.5 render per §5.2 stage under test (issue #134). */
export interface BounceMixResult {
  /** Neutral strips: the reference every other render is read against. */
  readonly baseline: BounceMixSlice;
  /** The track fader at −12 dB (spec §8.5.6 law) — stage 5. */
  readonly levelled: BounceMixSlice;
  /** The track panned hard right — stage 5. */
  readonly panned: BounceMixSlice;
  /** A lowpass insert on the track, an octave and a half below the tone — stage 6. */
  readonly inserted: BounceMixSlice;
  /** Send 0 open into a return carrying a 300 ms delay — stages 7 and 8. */
  readonly sent: BounceMixSlice;
  /** A §7.8 sequence lane ramping the master fader across the bar — stage 9. */
  readonly automated: BounceMixSlice;
  /**
   * A §7.8 lane on the track insert's own cutoff — the `insert:<channel>:slotN.<param>`
   * half of the §7.8 grammar, which addresses a slot 1-based over the §4.2 slot array.
   */
  readonly insertAutomated: BounceMixSlice;
  /** The §9.5 stem of the one track: sends open, master strip cut and filtered. */
  readonly stem: BounceMixSlice;
  /** The same project as a full mix, so the master strip's absence from the stem is visible. */
  readonly masteredMix: BounceMixSlice;
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

/** RMS of a rendered channel between two times, in seconds. */
function rmsBetween(data: Float32Array, sampleRate: number, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(data.length, Math.ceil(to * sampleRate));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / (end - start));
}

/**
 * Seconds from `from` to the last frame above the noise floor inside `[from, to)` — how long a
 * hit lasted, which is what a §7.8 `pitch` lane moves (spec §5.4, issue #138).
 */
function lastAudibleSeconds(data: Float32Array, sampleRate: number, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(data.length, Math.ceil(to * sampleRate));
  for (let i = end - 1; i >= start; i -= 1) {
    if (Math.abs(data[i]!) > 1e-3) return (i + 1 - start) / sampleRate;
  }
  return 0;
}

/**
 * Every §5.2 stage from the channel strip outward, measured in the WAV a §9.5 bounce wrote
 * (issue #134, spec §11.2, §13.5).
 *
 * `renderSegments` used to connect every voice straight to a bare master gain, so a bounce
 * was a DRY mix: no level, no pan, no send, no insert and no §7.8 mixer automation reached
 * any bounced file, while `bounceTrack`'s "post-insert, pre-master" described a channel the
 * offline context did not have. Voice-level §6 sound design DID render, which is why nothing
 * about the file looked wrong — it just was not the mix.
 *
 * One bar of 4/4 at 120 bpm carries four hits of a 1 kHz tone, one per beat, each a quarter
 * of a second long. That shape is what makes each claim separable: the hits are shorter than
 * the gaps between them, so a send returning through a 300 ms delay lands in silence; and the
 * bar is long enough for a §7.8 lane to be read at its two ends.
 *
 * The probe restores the project it found — `installAudioProbe` runs in production builds, so
 * it may not leave a mixer it rewrote behind. Nothing it changes is ever committed: the
 * strips, programs and events go in through the hydration actions, which mark nothing dirty,
 * and the final `loadProject` puts every store back on the §9.3 rows.
 */
async function bounceMixProof(engine: AudioEngine): Promise<BounceMixResult> {
  const { bounceActiveSequence, bounceTrack } = await import('@/core/audio/bounceService');
  const { readFile } = await import('@/core/storage/opfs');
  const { channelLevelPath, insertParamPath } = await import('@/core/audio/params/registry');

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load it fresh before anything else: the app opens a project asynchronously at start-up,
  // and a probe that hydrated its own arrangement into the middle of that load would have it
  // replaced the moment the load finished.
  await projectService.loadProject(projectId);
  const ctx = sampleEditContext();
  const sampleRate = ctx.projectSampleRate;

  // A quarter-second 1 kHz tone: short enough to leave the beat gaps silent, and high enough
  // above the lowpass under test that the insert's effect is unmistakable rather than subtle.
  const HIT_SECONDS = 0.25;
  const tone = engine.context.createBuffer(1, Math.floor(sampleRate * HIT_SECONDS), sampleRate);
  const toneData = tone.getChannelData(0);
  for (let i = 0; i < toneData.length; i += 1) {
    toneData[i] = 0.6 * Math.sin((2 * Math.PI * 1_000 * i) / sampleRate);
  }
  const sample = await importDecodedSample(tone, 'bounce mix probe', ['probe'], {
    ...ctx,
    context: engine.context,
  });

  // A pad that plays the tone flat: no envelope shaping, so what the render measures is the
  // §5.2 strip and nothing else.
  const program = createDefaultDrumProgram('Bounce mix probe');
  const pad = createDefaultPad(0);
  pad.playbackMode = 'oneShot';
  pad.layers = [layer({ sampleId: sample.id })];
  pad.envelopes = {
    ...pad.envelopes,
    amp: { ...pad.envelopes.amp, attack: 0, hold: 0, decay: 0, sustain: 1, release: 1 },
  };
  program.pads = [pad];
  useProgramStore.getState().setPrograms({ [program.id]: program });

  const seqId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const sequence = { ...createDefaultSequence(projectId, 0, 'Bounce mix probe', seqId), lengthBars: 1 };
  const track = createDefaultTrack(seqId, program.id, 0, 'Bounce mix probe', 'drum', trackId);
  const beats = [0, 960, 1_920, 2_880].map((tickStart) => ({
    id: crypto.randomUUID(),
    tickStart,
    durationTicks: 120,
    note: 0,
    velocity: 100,
    extra: null,
  }));
  const channelId = `track:${trackId}`;

  /** Re-hydrate the arrangement, optionally with one §7.8 lane on it. */
  const hydrate = (automation: Record<string, AutomationPoint[]> = {}): void => {
    useSequenceStore.getState().hydrate({
      sequences: { [seqId]: sequence },
      tracks: { [trackId]: track },
      events: { [trackId]: beats },
      automation,
      songEntries: [],
    });
  };
  hydrate();
  const transport = useTransportStore.getState();
  transport.setActiveSequenceId(seqId);
  transport.setPlaybackMode('sequence');
  transport.setBpm(120);

  /** Every strip back to its §4.2 default, so each render starts from the same place. */
  const neutral = (): void => {
    useMixerStore.getState().setChannels({
      master: createDefaultChannelStrip('master'),
      'return:0': createDefaultChannelStrip('return:0'),
      'return:1': createDefaultChannelStrip('return:1'),
      'return:2': createDefaultChannelStrip('return:2'),
      'return:3': createDefaultChannelStrip('return:3'),
      [channelId]: createDefaultChannelStrip(channelId),
    });
  };

  const setStrip = (id: string, over: Partial<ChannelStrip>): void => {
    const current = useMixerStore.getState().channels[id] ?? createDefaultChannelStrip(id);
    useMixerStore.getState().upsertChannel({ ...current, ...over, id });
  };

  /** One effect in slot 1 of a strip, the other three slots left empty (spec §1.3.1). */
  const withEffect = (
    id: string,
    effectType: EffectType,
    params: Record<string, number>,
  ): InsertSlotState[] => {
    const slots = (useMixerStore.getState().channels[id] ?? createDefaultChannelStrip(id)).inserts;
    return slots.map((slot, index) => (index === 0 ? { ...slot, effectType, enabled: true, params } : slot));
  };

  /** Render, read the WAV back over real OPFS, and measure what is in it. */
  const measure = async (render: () => Promise<string>): Promise<BounceMixSlice> => {
    const bytes = new Uint8Array(await (await readFile(await render())).arrayBuffer());
    const decoded = decodeWav(bytes);
    const left = decoded.channels[0]!;
    const right = decoded.channels[1] ?? left;
    const sr = decoded.sampleRate;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < mono.length; i += 1) mono[i] = (left[i]! + right[i]!) / 2;
    // Beat windows start 20 ms in: the §4.3 dezipper takes `PARAM_RAMP_MS` to reach the first
    // automated value, and that run-in is the graph settling rather than the mix.
    const beat = (index: number): number => rmsBetween(mono, sr, index * 0.5 + 0.02, index * 0.5 + 0.24);
    return {
      rms: rmsBetween(mono, sr, 0, 2),
      leftRms: rmsBetween(left, sr, 0, 2),
      rightRms: rmsBetween(right, sr, 0, 2),
      // Between the first hit's end (0.25 s) and the second hit's start (0.5 s).
      gapRms: rmsBetween(mono, sr, 0.28, 0.48),
      firstBeatRms: beat(0),
      lastBeatRms: beat(3),
    };
  };

  const bounce = (): Promise<string> => bounceActiveSequence('probe-mix', ctx);

  neutral();
  const baseline = await measure(bounce);

  // Stage 5 — the track fader. 0.8 on the §8.5.6 law is −12 dB, a quarter of the amplitude.
  neutral();
  setStrip(channelId, { level: 0.8 });
  const levelled = await measure(bounce);

  // Stage 5 — pan. Hard right empties the left channel outright.
  neutral();
  setStrip(channelId, { pan: 1 });
  const panned = await measure(bounce);

  // Stage 6 — a track insert. A lowpass at 100 Hz against a 1 kHz tone is ~40 dB down.
  neutral();
  setStrip(channelId, {
    inserts: withEffect(channelId, 'filter', { type: 0, cutoff: 100, resonance: 1, mix: 1 }),
  });
  const inserted = await measure(bounce);

  /** Send 0 wide open into a return whose delay is longer than a hit and shorter than a beat. */
  const openSend = (): void => {
    setStrip('return:0', {
      inserts: withEffect('return:0', 'delay', { sync: 0, time: 300, feedback: 0, tone: 18_000, mix: 1 }),
    });
    setStrip(channelId, { sendLevels: [1, 0, 0, 0] });
  };

  // Stages 7 and 8 — a send tap, its return channel, and both merging at the master bus.
  neutral();
  openSend();
  const sent = await measure(bounce);

  // Stage 9 — a §7.8 sequence lane riding the master fader from near silence to unity.
  neutral();
  const masterLevel = channelLevelPath('master');
  const lane = (tick: number, value: number): AutomationPoint => ({
    id: crypto.randomUUID(),
    scope: 'sequence',
    ownerId: seqId,
    targetPath: masterLevel,
    tick,
    value,
    curve: 'linear',
  });
  hydrate({ [automationLaneKey('sequence', seqId, masterLevel)]: [lane(0, 0.3), lane(3_840, 1)] });
  const automated = await measure(bounce);

  // Stage 6 under automation — a §7.8 `insert:<channel>:slot1.cutoff` lane opening the track
  // filter from 20 Hz to 12 kHz across the bar. This is the half of the §7.8 grammar that
  // addresses a SLOT rather than a strip, and it is the one an off-by-one silently drops.
  neutral();
  setStrip(channelId, {
    inserts: withEffect(channelId, 'filter', { type: 0, cutoff: 60, resonance: 1, mix: 1 }),
  });
  const cutoff = insertParamPath(channelId, 1, 'cutoff');
  // An `exp` curve, which is also the only §7.8 curve shape the rest of this proof does not
  // reach: a filter sweep is geometric in Hz, and a linear one spends the first beat already
  // past the tone it is supposed to be holding back.
  const cutoffPoint = (tick: number, value: number): AutomationPoint => ({
    id: crypto.randomUUID(),
    scope: 'sequence',
    ownerId: seqId,
    targetPath: cutoff,
    tick,
    value,
    curve: 'exp',
  });
  hydrate({
    [automationLaneKey('sequence', seqId, cutoff)]: [cutoffPoint(0, 60), cutoffPoint(3_840, 12_000)],
  });
  const insertAutomated = await measure(bounce);
  hydrate();

  // §9.5's stem, and the same project as a full mix. The master strip is cut to −42 dB AND
  // filtered, so a stem that carried stage 9 could not possibly be mistaken for one that did
  // not — while the sends stay open, which is what makes the return's presence in the stem
  // measurable in the same render.
  neutral();
  openSend();
  setStrip('master', {
    level: 0.3,
    inserts: withEffect('master', 'filter', { type: 0, cutoff: 100, resonance: 1, mix: 1 }),
  });
  const stem = await measure(() => bounceTrack(trackId, 'probe-stem-mix', ctx));
  const masteredMix = await measure(bounce);

  // Put the project back: the stores return to the §9.3 rows, taking the probe's arrangement,
  // program and strips with them.
  await projectService.loadProject(projectId);

  return { baseline, levelled, panned, inserted, sent, automated, insertAutomated, stem, masteredMix };
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
 * Sequence mode plays ONE sequence, over the real worker (spec §7.7, §7.9, issue #132).
 *
 * Two one-bar sequences, a track each, both carrying the SAME pad on the same four beats —
 * the shape that makes the defect visible, since a pad held over Erase arms that pad on every
 * track the UI offers it on. The unit tests drive `SchedulerCore` with an injected clock; what
 * they cannot reach is the wire, and the defect lives on both sides of it: the sender forwards
 * every track in the project and the schedule path chose none of them.
 *
 * Three things are read from one continuous session. What sounded before the active sequence
 * changed; what sounded after it changed WITH NO EVENTS RE-SENT, which is the property that
 * makes the worker-side filter the right one; and which track's notes a held erase took. Under
 * the defect both tracks sound in the first window and both lose their notes in the third.
 */
async function sequenceFilterProof(engine: AudioEngine): Promise<SequenceFilterResult> {
  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  const seqA = crypto.randomUUID();
  const seqB = crypto.randomUUID();
  const trackA = crypto.randomUUID();
  const trackB = crypto.randomUUID();
  const rows = await createSequenceRows(
    projectId,
    [
      { id: seqA, name: 'Filter probe A' },
      { id: seqB, name: 'Filter probe B' },
    ],
    [
      { id: trackA, sequenceId: seqA, name: 'Filter probe A' },
      { id: trackB, sequenceId: seqB, name: 'Filter probe B' },
    ],
  );
  // §1.3.1 maps a pad index straight to a note number, so one pad on both tracks is note 36
  // on both. One bar of 4/4 at 960 PPQN is 3840 ticks and, at 120 bpm, two seconds.
  const pad = 36;
  const ticks = [0, 960, 1_920, 2_880];
  const beats = () =>
    ticks.map((tickStart) => ({
      id: crypto.randomUUID(),
      tickStart,
      durationTicks: 120,
      note: pad,
      velocity: 100,
      extra: null,
    }));
  useSequenceStore.getState().hydrate({
    sequences: rows.sequences,
    tracks: rows.tracks,
    events: { [trackA]: beats(), [trackB]: beats() },
    automation: {},
    songEntries: [],
  });

  const transport = () => useTransportStore.getState();
  transport().setPlaybackMode('sequence');
  transport().setMetronomeEnabled(false);
  transport().setCountInBars(0);
  transport().setRecording(false);
  transport().setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  // Both sequences carry an explicit tempo, so switching between them mid-transport is not
  // also a §7.2 tempo change: `createDefaultSequence` leaves `tempo` NULL, and a NULL follows
  // `projects.bpm_default` (§9.3), which the §4.2 mirror would then re-derive at the switch.
  transport().setActiveSequenceId(seqB);
  commitTempo(120);
  transport().setActiveSequenceId(seqA);
  commitTempo(120);
  await delay(150);

  const distinctTracks = (events: ScheduledEvent[]): string[] =>
    [...new Set(events.filter((e) => e.kind === 'noteOn').map((e) => e.trackId ?? ''))].sort();

  transport().play();
  const before = distinctTracks(
    await captureScheduled(engine, async () => {
      await delay(700); // beats 1 and 2 of sequence A's bar, plus the lookahead past them
    }),
  );
  // The ONLY message a switch of active sequence sends is `sequenceMeta` (spec §7.1.3) — no
  // `eventsDiff` follows it, because the worker already holds every track in the project.
  transport().setActiveSequenceId(seqB);
  await delay(250); // one LOOKAHEAD_MS plus wakes: the window already posted is not re-timed
  const after = distinctTracks(
    await captureScheduled(engine, async () => {
      await delay(700);
    }),
  );
  transport().stop();
  await delay(200);

  const ticksOf = (trackId: string): number[] =>
    (useSequenceStore.getState().events[trackId] ?? []).map((e) => e.tickStart).sort((a, b) => a - b);
  const activeTicksBefore = ticksOf(trackA);
  const otherTicksBefore = ticksOf(trackB);

  // A second roll for the erase, so the sweep is read against a known starting set rather than
  // against whatever the switch above left behind. Sequence A is active again, and the pad is
  // armed on BOTH tracks — what the §8.5.7 gesture does when one pad sits on two sequences.
  transport().setActiveSequenceId(seqA);
  await delay(150);
  transport().play();
  await delay(60); // past tick 0, so the arm lands before the beats it is meant to sweep
  engine.scheduler.setLiveErase(trackA, pad, true);
  engine.scheduler.setLiveErase(trackB, pad, true);
  await delay(1_200); // most of the bar: beats 2, 3 and 4 pass under the held erase
  engine.scheduler.setLiveErase(trackA, pad, false);
  engine.scheduler.setLiveErase(trackB, pad, false);
  await delay(250);
  transport().stop();
  await delay(200);

  return {
    activeTrackId: trackA,
    otherTrackId: trackB,
    scheduledBeforeSwitch: before,
    scheduledAfterSwitch: after,
    activeTicksBefore,
    otherTicksBefore,
    activeTicksAfter: ticksOf(trackA),
    otherTicksAfter: ticksOf(trackB),
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

  // The row as it stands before any of this, restored at the end. The proof SAVES a slot and
  // then rewrites the payload to demonstrate the legacy case, and `installAudioProbe` runs in
  // production builds — so a probe that did not put this back would replace a real master
  // chain's tuning with the §5.7 defaults, and grow the chain by a delay on every run.
  const repos = getActiveRepositories();
  const rowBefore = await repos.projects.getById(projectId);
  if (rowBefore === undefined) throw new Error('insertDefaultsProof: the active project has no row.');
  const payloadBefore = rowBefore.payload;

  // 1 — a slot the user just added, through the action the §8.5.6 slot picker calls. It is
  // tracked by ID from here on: `replaceInsert` keeps a slot's id and a reload preserves it,
  // so the id is the one handle that survives every step below.
  useMixerStore.getState().addInsert(channelId, 'delay');
  const inserts = useMixerStore.getState().channels[channelId]!.inserts;
  // An add FILLS the first free slot of the §1.3.1 rack rather than appending past it
  // (issue #135), so the slot it created is found by looking for the effect — never at the
  // end of the chain, and never at `inserts.length`.
  const slotIndex = inserts.findIndex((slot) => slot.effectType === 'delay');
  const slotId = inserts[slotIndex]!.id;
  // Slots are addressed 1-based in the §7.8 grammar (`slot2`).
  const path = insertParamPath(channelId, slotIndex + 1, 'time');
  const added = await agreementNow();

  // 2 — saved and loaded back through the real §4.4 path, not re-derived in memory.
  await projectService.saveNow();
  await projectService.loadProject(projectId);
  const reloaded = await agreementNow();

  // 3 — the §9.3 column as a build BEFORE this fix wrote it: an effect, and no parameters.
  const saved = await repos.projects.getById(projectId);
  if (saved === undefined) throw new Error('insertDefaultsProof: the active project has no row.');
  const payload = JSON.parse(saved.payload) as { master?: { inserts?: { params: unknown }[] } };
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

  // Put the project back. The final `loadProject` is what returns the STORE to the row as
  // well, so neither the added slot nor its undo entries outlive the proof.
  await repos.projects.update(projectId, { payload: payloadBefore });
  await projectService.loadProject(projectId);

  return { path, added, reloaded, legacy, touchedToMs, undoneToMs };
}

/** Both sides of the §6 ↔ §4.2 pair read into one shape, so the smoke compares like with like. */
function padStripReading(
  mixer: { level: number; pan: number; sendLevels: readonly number[] } | undefined,
  inserts: readonly InsertSlotState[] | undefined,
): PadStripReading {
  // The first OCCUPIED slot, not the last one: an add fills the §1.3.1 rack's first free slot
  // rather than appending past it, so the empty slots sit after the effect (issue #135).
  const slot = inserts?.find((candidate) => candidate.effectType !== null);
  return {
    level: mixer?.level ?? -1,
    pan: mixer?.pan ?? -1,
    send1: mixer?.sendLevels[1] ?? -1,
    insertType: slot?.effectType ?? null,
    insertTimeMs: slot?.params.time ?? -1,
  };
}

/**
 * A pad's mixer strip is REACHABLE and it PERSISTS (issue #133, spec §4.2, §6, §9.3, §9.5).
 *
 * Two halves, because the defect had two. §8.5.6's Pads tab was inert on a freshly loaded
 * project — nothing published a `pad:` strip, so `useMixerStore.commit` found none and
 * returned before it wrote anything — and where a strip did exist, `flushProgram` serialised
 * a `useProgramStore` the edit had never reached, so the save reported success and stored the
 * pad unchanged.
 *
 * The bounce is what makes the second half AUDIBLE rather than a claim about a JSON column
 * (spec §11.2, §13.5). One bar carries four hits of a 1 kHz tone on pad 0; the pad fader is
 * committed to 0.8, which the §8.5.6 law maps to −12 dB; the project is SAVED and RELOADED;
 * and the same bounce is measured again. Only a strip that survived the reload can move that
 * number, because §9.5 renders committed store state and the reload rebuilt every store from
 * the §9.3 rows.
 *
 * The proof owns its whole arrangement as real §9.3 ROWS — a program, a sequence and a track
 * of its own — because a save and a reload are the two things it is about, so nothing it
 * measures may be hydrated into the stores and left there. It cannot borrow the project's own
 * track either: by the time the §11.4 run reaches this step, earlier steps have opened
 * imported and factory projects, and what a track points at is no longer predictable. The
 * three rows are deleted at the end and the project reloaded — `installAudioProbe` runs in
 * production builds, so it may not leave an arrangement behind.
 */
async function padStripProof(engine: AudioEngine): Promise<PadStripResult> {
  const { bounceActiveSequence } = await import('@/core/audio/bounceService');
  const { readFile } = await import('@/core/storage/opfs');
  const { channelLevelPath, channelPanPath, channelSendPath } = await import('@/core/audio/params/registry');

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load it fresh before anything else: the app opens a project asynchronously at start-up,
  // and a probe reaching the stores mid-load would have its own work replaced by that load.
  await projectService.loadProject(projectId);
  const repos = getActiveRepositories();
  const ctx = sampleEditContext();
  const sampleRate = ctx.projectSampleRate;

  // A quarter-second 1 kHz tone through a pad with no envelope shaping, so what a render
  // measures is the strip and nothing else.
  const HIT_SECONDS = 0.25;
  const tone = engine.context.createBuffer(1, Math.floor(sampleRate * HIT_SECONDS), sampleRate);
  const toneData = tone.getChannelData(0);
  for (let i = 0; i < toneData.length; i += 1) {
    toneData[i] = 0.6 * Math.sin((2 * Math.PI * 1_000 * i) / sampleRate);
  }
  const sample = await importDecodedSample(tone, 'pad strip probe', ['probe'], {
    ...ctx,
    context: engine.context,
  });

  const program = createDefaultDrumProgram('Pad strip probe');
  const pad = createDefaultPad(0, 'Pad strip probe');
  pad.playbackMode = 'oneShot';
  pad.layers = [layer({ sampleId: sample.id })];
  pad.envelopes = {
    ...pad.envelopes,
    amp: { ...pad.envelopes.amp, attack: 0, hold: 0, decay: 0, sustain: 1, release: 1 },
  };
  program.pads = [pad];
  const padChannel = `pad:${program.id}:0`;

  const sequence = { ...createDefaultSequence(projectId, 99, 'Pad strip probe'), lengthBars: 1 };
  const trackId = crypto.randomUUID();

  await repos.programs.create({
    id: program.id,
    project_id: projectId,
    name: program.name,
    type: 'drum',
    payload: JSON.stringify(program),
  });
  await repos.sequences.create({
    id: sequence.id,
    project_id: projectId,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: 120,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });
  await repos.tracks.create({
    id: trackId,
    sequence_id: sequence.id,
    program_id: program.id,
    position: 0,
    name: 'Pad strip probe',
    type: 'drum',
    mixer: JSON.stringify(createDefaultChannelStrip(`track:${trackId}`)),
  });
  await repos.midiEvents.replaceTrack(
    trackId,
    [0, 960, 1_920, 2_880].map((tick) => ({
      id: crypto.randomUUID(),
      track_id: trackId,
      tick_start: tick,
      duration_ticks: 120,
      note: 0,
      velocity: 100,
      extra: null,
    })),
  );

  /** Re-read every row, then select the probe's own program and sequence (spec §4.4). */
  const reload = async (): Promise<void> => {
    await projectService.loadProject(projectId);
    useProgramStore.getState().setActiveProgram(program.id);
    const transport = useTransportStore.getState();
    transport.setActiveSequenceId(sequence.id);
    transport.setPlaybackMode('sequence');
    transport.setBpm(120);
  };
  await reload();

  // 1 — is there a strip at all? The project has just been loaded and the program selected
  // exactly as hydration selects one; nothing has switched away from it and back.
  const stripPresentOnLoad = useMixerStore.getState().channels[padChannel] !== undefined;

  /** Render the active sequence and measure the WAV back over real OPFS (spec §9.5, §11.2). */
  const measure = async (): Promise<number> => {
    const path = await bounceActiveSequence('probe-pad-strip', ctx);
    const decoded = decodeWav(new Uint8Array(await (await readFile(path)).arrayBuffer()));
    const left = decoded.channels[0]!;
    const right = decoded.channels[1] ?? left;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < mono.length; i += 1) mono[i] = (left[i]! + right[i]!) / 2;
    return rmsBetween(mono, decoded.sampleRate, 0, 2);
  };

  const defaultRms = await measure();

  // 2 — §5.2 solo-in-place, with the pad strips this work made permanent. A pad channel feeds
  // its TRACK's input (stage 5), so a solo evaluated across ONE group would mute every pad of
  // the soloed track and render it silent. Measured rather than inspected (spec §11.2), and
  // measured HERE so the strips are still at their §4.2 defaults: the render above is the
  // same one with the solo off, which makes the solo the only variable between the two.
  const soloTrack = useMixerStore.getState().channels[`track:${trackId}`];
  useMixerStore.getState().setSolo(`track:${trackId}`, true);
  const soloedTrackRms = await measure();
  if (soloTrack !== undefined) useMixerStore.getState().setSolo(`track:${trackId}`, soloTrack.solo);

  // 3 — the audible half. 0.8 on the §8.5.6 fader law is −12 dB, a quarter of the amplitude.
  useMixerStore.getState().commit(channelLevelPath(padChannel), 0.8);
  const committedLevel = useMixerStore.getState().channels[padChannel]?.level ?? -1;
  await projectService.saveNow();
  await reload();
  const reloadedLevel = useMixerStore.getState().channels[padChannel]?.level ?? -1;
  const reloadedRms = await measure();

  // 4 — the other three fields, into the §9.3 column and back onto the strip.
  const mixer = useMixerStore.getState();
  mixer.commit(channelPanPath(padChannel), -0.5);
  mixer.commit(channelSendPath(padChannel, 1), 0.6);
  mixer.addInsert(padChannel, 'delay');
  await projectService.saveNow();

  const savedRow = await repos.programs.getById(program.id);
  if (savedRow === undefined) throw new Error('padStripProof: the probe program lost its row.');
  const savedPad = (JSON.parse(savedRow.payload) as { pads: Pad[] }).pads.find(
    (candidate) => candidate.padIndex === 0,
  );
  const onDisk = padStripReading(savedPad?.mixer, savedPad?.inserts);

  await reload();
  const strip = useMixerStore.getState().channels[padChannel];
  const afterReload = padStripReading(strip, strip?.inserts);

  // Put the project back: the probe's own rows go, and the load takes its stores with them.
  // The sequence cascades to the track and the track to its events (spec §9.3).
  await repos.sequences.remove(sequence.id);
  await repos.programs.remove(program.id);
  await projectService.loadProject(projectId);

  return {
    padChannel,
    stripPresentOnLoad,
    committedLevel,
    reloadedLevel,
    defaultRms,
    reloadedRms,
    onDisk,
    afterReload,
    soloedTrackRms,
  };
}

/**
 * A deleted track stops sounding, and leaves nothing behind (spec §7.1.3, §7.5, §7.8, #137).
 *
 * `subscribeSequencerSync`'s events subscriber only ever iterated the keys it was handed, so
 * `removeTrack` told the worker nothing and the worker kept scheduling the track's notes for
 * the rest of the session. The unit tests drive `SchedulerCore` with an injected clock; what
 * they cannot reach is the wire, and this defect was on the far side of it.
 *
 * Two tracks play the SAME pad on the same four beats, so their voices sum coherently at the
 * §5.2 master bus: deleting one halves the peak, which is an audio measurement of "the track
 * stopped sounding" rather than an inspection of it (spec §11.2, §13.5). The delete happens
 * WHILE THE TRANSPORT ROLLS, which is the case §7.9's lookahead makes interesting — the
 * measurement is taken after one `LOOKAHEAD_MS` window has passed, because notes already
 * posted into it sound, exactly as a §7.7 live erase leaves the notes under the playhead.
 *
 * The second half is what the save leaves on disk. The §9.3 `midi_events` rows cascade from
 * the `tracks` row, but `automation_points` declares no foreign key at all and the §7.5
 * groove assignment lives in `projects.payload` — so both are the track's own to take.
 *
 * The probe owns its arrangement as real §9.3 ROWS and creates them rather than borrowing the
 * project's, then deletes them and reloads: `installAudioProbe` runs in production builds.
 */
async function trackWithdrawalProof(engine: AudioEngine): Promise<TrackWithdrawalResult> {
  const { deleteTrack } = await import('@/features/main/projectCrud');
  const { channelLevelPath } = await import('@/core/audio/params/registry');

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load it fresh before anything else: the app opens a project asynchronously at start-up,
  // and a probe reaching the stores mid-load would have its own work replaced by that load.
  await projectService.loadProject(projectId);
  const repos = getActiveRepositories();
  const ctx = sampleEditContext();
  const sampleRate = ctx.projectSampleRate;
  // The §9.3 payload exactly as the probe found it. It gains a §7.5 groove template below,
  // and `flushProject` writes the whole column from the stores — so clearing the ASSIGNMENT
  // would still leave the template in the real project's Grid picker. Putting the column
  // back verbatim is the `insertDefaultsProof` pattern: `installAudioProbe` runs in
  // production builds, so a proof that rewrites `projects.payload` restores it.
  const payloadBefore = (await repos.projects.getById(projectId))?.payload ?? '{}';

  /**
   * A tenth-second 1 kHz tone at a given amplitude, through a pad with no envelope shaping,
   * so what the master tap measures is which voices are sounding and nothing else.
   *
   * The two tracks are deliberately UNEQUAL. Two equal voices at the same instant sum, but
   * not coherently enough to halve the measured peak reliably — the first draft read ×0.665
   * against a ×1.0 defect, which is too little separation to trust a live meter with. A loud
   * track and a quiet one make the fall unmistakable, and the quiet one's survival is then
   * an assertion in its own right rather than a rounding error.
   */
  const buildTone = async (name: string, amplitude: number): Promise<string> => {
    const tone = engine.context.createBuffer(1, Math.floor(sampleRate * 0.1), sampleRate);
    const toneData = tone.getChannelData(0);
    for (let i = 0; i < toneData.length; i += 1) {
      toneData[i] = amplitude * Math.sin((2 * Math.PI * 1_000 * i) / sampleRate);
    }
    const imported = await importDecodedSample(tone, name, ['probe'], { ...ctx, context: engine.context });
    return imported.id;
  };

  /**
   * One program per track, NOT one shared between them. A §5.2 pad channel is keyed
   * `pad:<programId>:<padIndex>` and `ensurePadChannel` wires it to the input of whichever
   * track triggered it first, so two tracks on ONE program share a pad channel and the
   * second track's hits already sum into the first track's strip. Deleting the first would
   * then take the second's audio path with it, and this proof would be measuring that
   * instead of the withdrawal. Filed as issue #141; kept out of the measurement here.
   */
  const buildProgram = (name: string, sampleId: string) => {
    const program = createDefaultDrumProgram(name);
    const pad = createDefaultPad(0, name);
    pad.playbackMode = 'oneShot';
    pad.layers = [layer({ sampleId })];
    pad.envelopes = {
      ...pad.envelopes,
      amp: { ...pad.envelopes.amp, attack: 0, hold: 0, decay: 0, sustain: 1, release: 1 },
    };
    program.pads = [pad];
    return program;
  };
  // A is the track that goes, and it is the loud one; B stays and is a fifth of it.
  const programs = [
    buildProgram('Withdrawal probe A', await buildTone('withdrawal probe A', 0.6)),
    buildProgram('Withdrawal probe B', await buildTone('withdrawal probe B', 0.12)),
  ];

  const sequence = { ...createDefaultSequence(projectId, 98, 'Track withdrawal probe'), lengthBars: 1 };
  const deletedTrackId = crypto.randomUUID();
  const keptTrackId = crypto.randomUUID();
  const targetPath = channelLevelPath(`track:${deletedTrackId}`);

  for (const program of programs) {
    await repos.programs.create({
      id: program.id,
      project_id: projectId,
      name: program.name,
      type: 'drum',
      payload: JSON.stringify(program),
    });
  }
  await repos.sequences.create({
    id: sequence.id,
    project_id: projectId,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: 120,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });
  for (const [position, id] of [deletedTrackId, keptTrackId].entries()) {
    await repos.tracks.create({
      id,
      sequence_id: sequence.id,
      program_id: programs[position]!.id,
      position,
      name: `Withdrawal probe ${position === 0 ? 'A' : 'B'}`,
      type: 'drum',
      mixer: JSON.stringify(createDefaultChannelStrip(`track:${id}`)),
    });
    // §1.3.1 maps a pad index straight to a note number, so pad 0 is note 0 on both tracks.
    // One bar of 4/4 at 960 PPQN is 3840 ticks and, at 120 bpm, two seconds.
    await repos.midiEvents.replaceTrack(
      id,
      [0, 960, 1_920, 2_880].map((tick) => ({
        id: crypto.randomUUID(),
        track_id: id,
        tick_start: tick,
        duration_ticks: 120,
        note: 0,
        velocity: 100,
        extra: null,
      })),
    );
  }
  // The two things a `tracks` row does not cascade, written as real rows and a real payload
  // key so the save can be read back rather than reasoned about.
  await repos.automation.replaceTarget('track', deletedTrackId, targetPath, [
    {
      id: crypto.randomUUID(),
      scope: 'track',
      owner_id: deletedTrackId,
      target_path: targetPath,
      tick: 0,
      value: 0.9,
      curve: 'linear',
    },
  ]);

  await projectService.loadProject(projectId);
  const transport = () => useTransportStore.getState();
  transport().setActiveSequenceId(sequence.id);
  transport().setPlaybackMode('sequence');
  transport().setMetronomeEnabled(false);
  transport().setCountInBars(0);
  transport().setRecording(false);
  transport().setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  commitTempo(120);
  // A §7.5 assignment for the doomed track, which persists in `projects.payload` rather than
  // on the track row — the other thing nothing else takes with it.
  useSequenceStore.getState().setGrooveTemplate('Withdrawal probe groove', {
    ppqn: 960,
    lengthTicks: 3_840,
    division: 16,
    points: [{ gridTick: 0, offsetTicks: 0, velocityScale: 1 }],
  });
  useSequenceStore.getState().assignTrackGroove(deletedTrackId, 'Withdrawal probe groove');
  await projectService.saveNow();
  await delay(150);

  const distinctTracks = (events: ScheduledEvent[]): string[] =>
    [...new Set(events.filter((e) => e.kind === 'noteOn').map((e) => e.trackId ?? ''))].sort();

  /** Highest §5.8 master-tap peak over `ms`, sampled at roughly frame rate. */
  const peakOver = async (ms: number): Promise<number> => {
    const slot = engine.meterRegistry.slotOf('master');
    let peak = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (slot !== undefined) {
        const reading = engine.meterRegistry.read(slot);
        peak = Math.max(peak, reading.peakL, reading.peakR);
      }
      await delay(16);
    }
    return peak;
  };

  transport().play();
  await delay(300); // past the first beat, so the meter is reading programme material
  let masterPeakBefore = 0;
  const scheduledBefore = distinctTracks(
    await captureScheduled(engine, async () => {
      masterPeakBefore = await peakOver(1_400);
    }),
  );

  // The delete happens with the transport still rolling. Everything already posted into the
  // §7.1.4 window still sounds, so the measurement waits one lookahead plus a wake before it
  // begins — the same allowance §7.7's live erase makes for the notes under the playhead.
  deleteTrack(deletedTrackId);
  await delay(400);
  let masterPeakAfter = 0;
  const scheduledAfter = distinctTracks(
    await captureScheduled(engine, async () => {
      masterPeakAfter = await peakOver(1_400);
    }),
  );
  transport().stop();
  await delay(200);

  const stripRemains = useMixerStore.getState().channels[`track:${deletedTrackId}`] !== undefined;
  const trackChannelRemains = engine.graph.channelsFor(`track:${deletedTrackId}`).length > 0;
  await projectService.saveNow();

  const trackRowRemains = (await repos.tracks.getById(deletedTrackId)) !== undefined;
  const eventRowsRemain = (await repos.midiEvents.listByTrack(deletedTrackId)).rows.length;
  const automationRowsRemain = (await repos.automation.listByOwner('track', deletedTrackId)).rows.length;
  const projectRow = await repos.projects.getById(projectId);
  const savedPayload = projectRow ? (JSON.parse(projectRow.payload) as ProjectPayload) : {};
  const grooveAssignmentRemains = (savedPayload.trackGrooveIds ?? {})[deletedTrackId] !== undefined;

  // Put the project back: the probe's own rows go and the load takes its stores with them.
  // The sequence cascades to the surviving track and that track to its events (spec §9.3).
  // `automation_points` does not cascade, which is the whole point of the reading above — so
  // the lane the probe wrote is cleared by name whether or not the fix took it.
  await repos.automation.replaceTarget('track', deletedTrackId, targetPath, []);
  await repos.sequences.remove(sequence.id);
  for (const program of programs) await repos.programs.remove(program.id);
  // The payload column last, AFTER the save above, so nothing the probe put in the stores
  // is written over the top of it; the reload then takes the stores back with it.
  await repos.projects.update(projectId, { payload: payloadBefore });
  await projectService.loadProject(projectId);

  return {
    deletedTrackId,
    keptTrackId,
    scheduledBefore,
    scheduledAfter,
    masterPeakBefore,
    masterPeakAfter,
    trackRowRemains,
    eventRowsRemain,
    automationRowsRemain,
    grooveAssignmentRemains,
    stripRemains,
    trackChannelRemains,
  };
}

/**
 * A channel's insert chain is bounded, and every slot in it is REACHABLE (issue #135).
 *
 * §1.3.1 gives every channel 4 insert slots, "configurable 1–8 via `globalInsertLimit`", and
 * `addInsert` appended without consulting it — so a chain grew without end. Past slot 8 the
 * §7.8 grammar stops parsing (`GLOBAL_INSERT_LIMIT_RANGE` bounds `slotN`), and the effect
 * goes on SOUNDING while the §8.5.6 panel's own knobs, every automation lane and every
 * §10.3 Q-Link binding on it address nothing.
 *
 * "It still sounds" and "the knob does nothing" are both audio claims, so both are measured
 * rather than inspected (spec §11.2, §13.5). A 1 kHz tone is fed into the §5.2 master input
 * — the real graph, the real §4.3 sync layer, the real insert chain — and the §5.8 master tap
 * is read. Every occupied slot is opened to 20 kHz through its own §7.8 address, then the
 * LAST occupied one is closed to 80 Hz through the same address. Two octaves above an 80 Hz
 * lowpass is inaudible, so the peak collapses — unless the address reaches nothing, which is
 * the defect: on the unfixed build five adds put the fifth filter on slot 9, the write lands
 * nowhere, and the two readings are the same number.
 *
 * The master strip is used because every project has exactly one, no mode can hide it, and it
 * persists in the §9.3 `projects.payload` column the restore below puts back verbatim —
 * `installAudioProbe` runs in production builds, so a proof that adds inserts to a real
 * project may not leave them there.
 */
async function insertLimitProof(engine: AudioEngine): Promise<InsertLimitResult> {
  const { insertParamPath, isAutomatable } = await import('@/core/audio/params/registry');

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load it fresh before anything else: the app opens a project asynchronously at start-up,
  // and a probe reaching the stores mid-load would have its own work replaced by that load.
  await projectService.loadProject(projectId);
  const repos = getActiveRepositories();
  // BOTH §9.3 columns this proof writes, captured before it writes either. `flushProject`
  // writes `insert_limit` from the store as well as `payload`, so a restore that put only the
  // payload back would leave a user who had chosen 8 slots on the 4 this proof sets — and
  // `installAudioProbe` runs in production builds.
  const rowBefore = await repos.projects.getById(projectId);
  if (rowBefore === undefined) throw new Error('insertLimitProof: the active project has no row.');
  const payloadBefore = rowBefore.payload;
  const insertLimitBefore = rowBefore.insert_limit;

  const channelId = 'master';
  const mixer = () => useMixerStore.getState();
  // The §1.3.1 default, set explicitly so the numbers below do not depend on the row the
  // probe happened to find. Both columns are put back at the end.
  const limit = 4;
  useProjectStore.getState().setGlobalInsertLimit(limit);

  /** The §1.3.1 rack, empty — the strip a project starts every channel with. */
  const resetChain = (): void => {
    const strip = mixer().channels[channelId];
    if (strip === undefined) return;
    mixer().upsertChannel({ ...strip, inserts: createDefaultChannelStrip(channelId, limit).inserts });
  };

  /** 1-based §7.8 slot numbers holding an effect, in chain order (spec §7.8 `slot2`). */
  const occupiedSlotNumbers = (): number[] =>
    mixer()
      .channels[channelId]!.inserts.map((slot, index) => (slot.effectType === null ? 0 : index + 1))
      .filter((n) => n > 0);

  // 1 — ask for twelve inserts on a four-slot rack and see what the store allows.
  resetChain();
  let refusalReason = '';
  for (let i = 0; i < 12; i += 1) {
    const result = mixer().addInsert(channelId, 'filter');
    if (!result.ok && refusalReason === '') refusalReason = result.reason;
  }
  const slotCount = mixer().channels[channelId]!.inserts.length;
  const occupied = occupiedSlotNumbers();
  const deadSlots = occupied.filter((n) => !isAutomatable(insertParamPath(channelId, n, 'cutoff')));
  const drivenSlot = occupied.at(-1) ?? 0;

  // 2 — the audio half, on the real graph. A looping 1 kHz tone straight into the §5.2
  // master input (stage 8), so what the §5.8 tap reads is the master insert chain and
  // nothing else — no transport, no voices, no arrangement to leave behind.
  const sampleRate = engine.context.sampleRate;
  const tone = engine.context.createBuffer(1, Math.floor(sampleRate * 0.25), sampleRate);
  const toneData = tone.getChannelData(0);
  for (let i = 0; i < toneData.length; i += 1) {
    toneData[i] = 0.5 * Math.sin((2 * Math.PI * 1_000 * i) / sampleRate);
  }
  const source = engine.context.createBufferSource();
  source.buffer = tone;
  source.loop = true;
  source.connect(engine.graph.master.input);

  /** Highest §5.8 master-tap peak over `ms`, sampled at roughly frame rate. */
  const peakOver = async (ms: number): Promise<number> => {
    const slot = engine.meterRegistry.slotOf(channelId);
    let peak = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (slot !== undefined) {
        const reading = engine.meterRegistry.read(slot);
        peak = Math.max(peak, reading.peakL, reading.peakR);
      }
      await delay(16);
    }
    return peak;
  };

  // Every occupied slot wide open, each through its OWN §7.8 address — so the chain is
  // transparent and each address has been exercised before the one that matters.
  for (const n of occupied) mixer().commit(insertParamPath(channelId, n, 'cutoff'), 20_000);
  source.start();
  await delay(200);
  const openPeak = await peakOver(400);

  // The last occupied slot alone, closed two octaves below the tone.
  if (drivenSlot > 0) mixer().commit(insertParamPath(channelId, drivenSlot, 'cutoff'), 80);
  await delay(200);
  const closedPeak = await peakOver(400);

  source.stop();
  source.disconnect();

  // 3 — a chain a §9.6 import or a project saved before the fix can carry: nine slots, every
  // one of them occupied. It is admitted WHOLE (§14 (ap): the stored value always wins), and
  // `replaceInsert` still refuses to occupy a position the limit forbids.
  const overLong = {
    ...mixer().channels[channelId]!,
    inserts: Array.from({ length: 9 }, () => ({
      id: crypto.randomUUID(),
      effectType: 'filter' as const,
      enabled: true,
      params: {},
    })),
  };
  mixer().upsertChannel(overLong);
  const admittedOverLongSlots = mixer().channels[channelId]!.inserts.length;
  const beyond = mixer().channels[channelId]!.inserts[8]!;
  const replaceBeyondLimitRefused = !mixer().replaceInsert(channelId, beyond.id, 'delay').ok;

  // Put the project back. The save flushes the probe's own strips into the row, both columns
  // are then rewritten verbatim, and the reload takes the STORES back with them — including
  // the §1.3.1 limit this proof set (issue #135).
  await projectService.saveNow();
  await repos.projects.update(projectId, { payload: payloadBefore, insert_limit: insertLimitBefore });
  await projectService.loadProject(projectId);

  return {
    channelId,
    limit,
    slotCount,
    occupiedCount: occupied.length,
    refusalReason,
    deadSlots,
    drivenSlot,
    openPeak,
    closedPeak,
    admittedOverLongSlots,
    replaceBeyondLimitRefused,
  };
}

/**
 * Two tracks that play ONE program each get their own §5.2 pad channel (issue #141).
 *
 * A pad channel is keyed `pad:<programId>:<padIndex>` — no track in the id — and
 * `ensurePadChannel` wired it to the input of whichever track triggered it FIRST. §5.2 stage
 * 5 places "all pad outputs of the program on a track" at that track's input, so the second
 * track's voices arrived at the first track's strip and its own fader, pan, mute, solo, sends
 * and inserts were bypassed for every pad the two shared. Deleting the first track then took
 * the node the second was sounding through.
 *
 * "The second track's fader does nothing" is an audio claim, so it is measured rather than
 * inspected (spec §11.2, §13.5). Both tracks hit the same pad on the same four beats, so each
 * hit is two coherent voices summing, and each §9.5 bounce is read back from `/bounces/` over
 * real OPFS. Closing ONE track's fader must halve the render:
 *
 *   - the second track's fader, against the defect's ×1.0 — its audio was never on that strip;
 *   - the first track's fader, against the defect's ×0 — that strip carried BOTH tracks.
 *
 * The pad strip's own fader is the guard on the other side of the decision: one §6 `Pad`
 * record, one §4.2 strip, one §7.8 address, N realisations. −12 dB there must reach both, or
 * the fix would trade one silent strip for another.
 *
 * The live half is measured too, because `bounceService` and `AudioEngine` build the graph
 * through the same factories but on their own paths. It also measures the OTHER thing a
 * lazily built channel needs: every track and pad channel is created on its first note, long
 * after the one `resyncAll` that `startAudioEngine` runs, so both a track's saved fader and a
 * pad's insert rack reach it only through `AudioBridge.seedChannel`.
 *
 * The probe owns its arrangement as real §9.3 ROWS and creates them rather than borrowing the
 * project's, then deletes them and reloads: `installAudioProbe` runs in production builds.
 */
async function sharedPadChannelProof(engine: AudioEngine): Promise<SharedPadChannelResult> {
  const { bounceActiveSequence } = await import('@/core/audio/bounceService');
  const { readFile } = await import('@/core/storage/opfs');
  const { channelLevelPath, insertParamPath } = await import('@/core/audio/params/registry');

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load it fresh before anything else: the app opens a project asynchronously at start-up,
  // and a probe reaching the stores mid-load would have its own work replaced by that load.
  await projectService.loadProject(projectId);
  const repos = getActiveRepositories();
  const ctx = sampleEditContext();
  const sampleRate = ctx.projectSampleRate;

  // A tenth-second 1 kHz tone through a pad with no envelope shaping, so what a render
  // measures is which voices reached the master and nothing else. 0.3 leaves headroom for
  // two of them summing — a §9.5 WAV is written at the §9.3 bit depth and would clip at 1.0,
  // which would cost the linearity every ratio below depends on.
  const tone = engine.context.createBuffer(1, Math.floor(sampleRate * 0.1), sampleRate);
  const toneData = tone.getChannelData(0);
  for (let i = 0; i < toneData.length; i += 1) {
    toneData[i] = 0.3 * Math.sin((2 * Math.PI * 1_000 * i) / sampleRate);
  }
  const sample = await importDecodedSample(tone, 'shared pad channel probe', ['probe'], {
    ...ctx,
    context: engine.context,
  });

  // ONE program, deliberately: it is the whole subject of the proof.
  const program = createDefaultDrumProgram('Shared pad probe');
  const pad = createDefaultPad(0, 'Shared pad probe');
  pad.playbackMode = 'oneShot';
  pad.layers = [layer({ sampleId: sample.id })];
  pad.envelopes = {
    ...pad.envelopes,
    amp: { ...pad.envelopes.amp, attack: 0, hold: 0, decay: 0, sustain: 1, release: 1 },
  };
  program.pads = [pad];
  const padChannel = `pad:${program.id}:0`;

  const sequence = { ...createDefaultSequence(projectId, 97, 'Shared pad probe'), lengthBars: 1 };
  const firstTrackId = crypto.randomUUID();
  const secondTrackId = crypto.randomUUID();

  await repos.programs.create({
    id: program.id,
    project_id: projectId,
    name: program.name,
    type: 'drum',
    payload: JSON.stringify(program),
  });
  await repos.sequences.create({
    id: sequence.id,
    project_id: projectId,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: 120,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });
  for (const [position, id] of [firstTrackId, secondTrackId].entries()) {
    await repos.tracks.create({
      id,
      sequence_id: sequence.id,
      program_id: program.id, // BOTH tracks, one program — the defect's own arrangement
      position,
      name: `Shared pad probe ${position === 0 ? 'first' : 'second'}`,
      type: 'drum',
      mixer: JSON.stringify(createDefaultChannelStrip(`track:${id}`)),
    });
    // §1.3.1 maps a pad index straight to a note number, so pad 0 is note 0 on both tracks.
    // One bar of 4/4 at 960 PPQN is 3840 ticks and, at 120 bpm, two seconds. The two tracks
    // hit in UNISON so every hit is two coherent voices, and removing one halves the render.
    await repos.midiEvents.replaceTrack(
      id,
      [0, 960, 1_920, 2_880].map((tick) => ({
        id: crypto.randomUUID(),
        track_id: id,
        tick_start: tick,
        duration_ticks: 120,
        note: 0,
        velocity: 100,
        extra: null,
      })),
    );
  }

  await projectService.loadProject(projectId);
  useProgramStore.getState().setActiveProgram(program.id);
  const transport = () => useTransportStore.getState();
  transport().setActiveSequenceId(sequence.id);
  transport().setPlaybackMode('sequence');
  transport().setMetronomeEnabled(false);
  transport().setCountInBars(0);
  transport().setRecording(false);
  transport().setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  commitTempo(120);

  /** Render the active sequence and measure the WAV back over real OPFS (spec §9.5, §11.2). */
  const measure = async (): Promise<number> => {
    const path = await bounceActiveSequence('probe-shared-pad', ctx);
    const decoded = decodeWav(new Uint8Array(await (await readFile(path)).arrayBuffer()));
    const left = decoded.channels[0]!;
    const right = decoded.channels[1] ?? left;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < mono.length; i += 1) mono[i] = (left[i]! + right[i]!) / 2;
    return rmsBetween(mono, decoded.sampleRate, 0, 2);
  };
  const setFader = (channelId: string, level: number): void => {
    useMixerStore.getState().commit(channelLevelPath(channelId), level);
  };

  const bothTracksRms = await measure();

  // The defect, stated as a measurement: the second track's voices were on the FIRST track's
  // strip, so closing the second track's fader changed nothing at all.
  setFader(`track:${secondTrackId}`, 0);
  const secondFaderClosedRms = await measure();
  setFader(`track:${secondTrackId}`, 1);

  // The same defect from the other side: the first track's strip carried both tracks, so
  // closing it rendered silence rather than half.
  setFader(`track:${firstTrackId}`, 0);
  const firstFaderClosedRms = await measure();
  setFader(`track:${firstTrackId}`, 1);

  // The guard on the decision, not a regression test: one §4.2 strip supplies every
  // realisation, so §8.5.6's single pad fader still moves both tracks. 0.8 is −12 dB.
  setFader(padChannel, 0.8);
  const padFaderRms = await measure();
  setFader(padChannel, 1);

  // The live path. `bounceService` and `AudioEngine` build the same graph through the same
  // factories, but by their own routes, so the §5.8 master tap is read as well as the file.
  //
  // Nothing has played live yet — every bounce above built its own offline graph — so the
  // engine holds no channel for either track and no realisation of this pad. TWO edits go in
  // before the first note, and the pass that follows measures both seeds in turn:
  //
  //   - an 80 Hz lowpass in the PAD strip's insert rack, two octaves below the tone. §6
  //     carries a pad's inserts but `ResolvedVoice` does not, so the payload seed cannot
  //     supply them — only `AudioBridge.seedChannel` can.
  //   - the second TRACK's fader at 0. `startAudioEngine` ran its one `resyncAll` before any
  //     track channel existed and `mixerSync` pushes only what CHANGED, so without the same
  //     seed the channel arrives at unity and the fader is inert until it is moved again.
  //
  // The bounces above are taken before both, on a clean rack and unity faders.
  const mixer = () => useMixerStore.getState();
  const addedFilter = mixer().addInsert(padChannel, 'filter');
  // `addInsert` fills the §1.3.1 rack's first FREE slot, which is not `inserts.at(-1)`.
  const filterIndex =
    mixer().channels[padChannel]?.inserts.findIndex((slot) => slot.effectType !== null) ?? -1;
  const filterSlotId = mixer().channels[padChannel]?.inserts[filterIndex]?.id;
  if (!addedFilter.ok || filterIndex < 0 || filterSlotId === undefined) {
    throw new Error(
      'sharedPadChannelProof: the pad strip refused an insert, so the seeding half cannot run.',
    );
  }
  // §7.8 numbers a slot 1-based over the §4.2 array (spec §7.8, §14 (ar)).
  mixer().commit(insertParamPath(padChannel, filterIndex + 1, 'cutoff'), 80);
  setFader(`track:${secondTrackId}`, 0);

  const peakOver = async (ms: number): Promise<number> => {
    const slot = engine.meterRegistry.slotOf('master');
    let peak = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (slot !== undefined) {
        const reading = engine.meterRegistry.read(slot);
        peak = Math.max(peak, reading.peakL, reading.peakR);
      }
      await delay(16);
    }
    return peak;
  };

  transport().play();
  await delay(300); // past the first beat, so the meter is reading programme material
  const livePeakSeeded = await peakOver(1_400);
  // Bypassed rather than removed: `removeInsert` still shrinks the rack (issue #142), and
  // this proof has no business depending on that. §5.7's bypass is true bypass via routing.
  mixer().setInsertEnabled(padChannel, filterSlotId, false);
  await delay(300);
  const livePeakSecondClosed = await peakOver(1_400);
  // The second track's fader, opened for the first time — its channel was built with the 0
  // it was loaded with, so this is the reading that says the seed took.
  setFader(`track:${secondTrackId}`, 1);
  await delay(300);
  const livePeakBoth = await peakOver(1_400);
  transport().stop();
  await delay(200);

  // How many channels the live graph holds under the one §4.2 id — one per track that played
  // the program, which is the structural half of the same statement.
  const liveRealisations = engine.graph.channelsFor(padChannel).length;

  // Put the project back: the probe's own rows go, and the load takes its stores with them.
  // The sequence cascades to both tracks and each track to its events (spec §9.3). The save
  // first, because §14 (aj) makes `loadProject` REFUSE over unsaved work and the fader
  // commits above marked the project dirty.
  await projectService.saveNow();
  await repos.sequences.remove(sequence.id);
  await repos.programs.remove(program.id);
  await projectService.loadProject(projectId);

  return {
    padChannel,
    liveRealisations,
    bothTracksRms,
    secondFaderClosedRms,
    firstFaderClosedRms,
    padFaderRms,
    livePeakSeeded,
    livePeakSecondClosed,
    livePeakBoth,
  };
}

/**
 * A §7.8 lane on a §6 sound-design parameter, measured in the WAV a §9.5 bounce wrote and on
 * the §5.8 master tap of a live pass (issue #138, spec §11.2, §13.5).
 *
 * `program:<id>.pad:<idx>.filter.cutoff`, `…filter.resonance` and `…pitch` used to be written
 * onto each SOUNDING voice, which reaches only the voices that exist at the moment of the
 * write. That has two consequences and this proof measures both:
 *
 *   - a §9.5 render builds every voice of the whole span before it applies any ramp, so
 *     "the voices sounding now" was all of them at once and the render was given no voice
 *     pool at all — the lane rendered as NOTHING;
 *   - live, a pad struck between two automation windows was built from the §6 payload, so
 *     the lane never reached the note at all until the next window.
 *
 * One bar of 4/4 at 120 bpm carries four hits of a 1 kHz tone, one per beat, each a quarter
 * of a second long — `bounceMixProof`'s own shape, for the same reason: the hits are shorter
 * than the gaps, so each beat can be read on its own and the bar is long enough for a lane to
 * be read at its two ends.
 *
 * The two halves are measured differently on purpose. A cutoff lane is a LEVEL claim: a 1 kHz
 * tone through a lowpass opening from 60 Hz to 12 kHz is near-silent on the first beat and open
 * on the last. A pitch lane is a RATE claim, and a level reading cannot tell a louder hit from
 * a faster one — so each beat also reports how LONG it sounded: two octaves up, a
 * quarter-second region is consumed in 88 ms.
 *
 * The probe restores the project it found — `installAudioProbe` runs in production builds.
 * Nothing it changes is committed: the program, arrangement and lanes go in through the
 * hydration actions, which mark nothing dirty, and the final `loadProject` puts every store
 * back on the §9.3 rows.
 */
async function padLaneProof(engine: AudioEngine): Promise<PadLaneResult> {
  const { bounceActiveSequence } = await import('@/core/audio/bounceService');
  const { readFile } = await import('@/core/storage/opfs');
  const { programParamPath } = await import('@/core/audio/params/registry');

  const projectId = useProjectStore.getState().projectId || (await loadOrCreateActiveProject());
  // Load it fresh before anything else: the app opens a project asynchronously at start-up,
  // and a probe reaching the stores mid-load would have its own work replaced by that load.
  await projectService.loadProject(projectId);
  const ctx = sampleEditContext();
  const sampleRate = ctx.projectSampleRate;

  // A quarter-second 1 kHz tone: an octave above the lowpass's open end is what makes the
  // sweep unmistakable, and its length is what makes a rate change readable as a shorter hit.
  const HIT_SECONDS = 0.25;
  const tone = engine.context.createBuffer(1, Math.floor(sampleRate * HIT_SECONDS), sampleRate);
  const toneData = tone.getChannelData(0);
  for (let i = 0; i < toneData.length; i += 1) {
    toneData[i] = 0.5 * Math.sin((2 * Math.PI * 1_000 * i) / sampleRate);
  }
  const sample = await importDecodedSample(tone, 'pad lane probe', ['probe'], {
    ...ctx,
    context: engine.context,
  });

  const programId = crypto.randomUUID();
  const seqId = crypto.randomUUID();
  const trackId = crypto.randomUUID();
  const cutoffPath = programParamPath(programId, 0, 'filter.cutoff');
  const pitchPath = programParamPath(programId, 0, 'pitch');

  /** The probe's pad, with whichever §6 filter the half being measured needs. */
  const publishProgram = (cutoff: number): void => {
    const program = { ...createDefaultDrumProgram('Pad lane probe'), id: programId };
    const pad = createDefaultPad(0, 'Pad lane probe');
    pad.playbackMode = 'oneShot'; // note-off is ignored, so each hit plays its region out
    pad.layers = [layer({ sampleId: sample.id })];
    // No envelope shaping at all, so what a render measures is the lane and nothing else.
    pad.envelopes = {
      ...pad.envelopes,
      amp: { ...pad.envelopes.amp, attack: 0, hold: 0, decay: 0, sustain: 1, release: 1 },
    };
    pad.filter = { type: 'lp', cutoff, resonance: 1, envDepth: 0 };
    program.pads = [pad];
    useProgramStore.getState().setPrograms({ [programId]: program });
  };

  // The sequence carries its OWN §9.3 tempo rather than leaning on the transport's: every
  // window below is placed in seconds, and an earlier probe leaving a different project tempo
  // behind would move all four beats out from under them.
  const sequence = {
    ...createDefaultSequence(projectId, 0, 'Pad lane probe', seqId),
    lengthBars: 1,
    tempo: 120,
  };
  const track = createDefaultTrack(seqId, programId, 0, 'Pad lane probe', 'drum', trackId);
  // §1.3.1 maps a pad index straight to a note number, so pad 0 is note 0. One bar of 4/4 at
  // 960 PPQN is 3840 ticks and, at 120 bpm, two seconds — a beat every half-second.
  const beats = [0, 960, 1_920, 2_880].map((tickStart) => ({
    id: crypto.randomUUID(),
    tickStart,
    durationTicks: 120,
    note: 0,
    velocity: 100,
    extra: null,
  }));

  /** Re-hydrate the arrangement, optionally with one §7.8 lane on it. */
  const hydrate = (automation: Record<string, AutomationPoint[]> = {}): void => {
    useSequenceStore.getState().hydrate({
      sequences: { [seqId]: sequence },
      tracks: { [trackId]: track },
      events: { [trackId]: beats },
      automation,
      songEntries: [],
    });
  };

  /** A two-point §7.8 sequence lane across the whole bar. */
  const sweep = (
    targetPath: string,
    from: number,
    to: number,
    curve: 'linear' | 'exp',
  ): Record<string, AutomationPoint[]> => ({
    [automationLaneKey('sequence', seqId, targetPath)]: [0, 3_840].map((tick, index) => ({
      id: crypto.randomUUID(),
      scope: 'sequence' as const,
      ownerId: seqId,
      targetPath,
      tick,
      value: index === 0 ? from : to,
      curve,
    })),
  });

  hydrate();
  const transport = () => useTransportStore.getState();
  transport().setActiveSequenceId(seqId);
  transport().setPlaybackMode('sequence');
  transport().setMetronomeEnabled(false);
  transport().setCountInBars(0);
  transport().setRecording(false);
  transport().setLoop({ enabled: true, startTick: 0, endTick: 3_840 });
  commitTempo(120);

  // Every §5.2 strip back to its §4.2 default, `bounceMixProof`'s own `neutral()`: this proof
  // is about what reaches the VOICE, and a send, a return delay or a master insert left in the
  // stores by an earlier step smears every hit into the next and makes a length unreadable.
  // Nothing here is committed, so the closing `loadProject` puts the project's own strips back.
  useMixerStore.getState().setChannels({
    master: createDefaultChannelStrip('master'),
    'return:0': createDefaultChannelStrip('return:0'),
    'return:1': createDefaultChannelStrip('return:1'),
    'return:2': createDefaultChannelStrip('return:2'),
    'return:3': createDefaultChannelStrip('return:3'),
    [`track:${trackId}`]: createDefaultChannelStrip(`track:${trackId}`),
  });

  /**
   * Render the bar and read the first and last beat back from `/bounces/` over real OPFS.
   *
   * Both windows start 20 ms into the beat: the §4.3 dezipper takes `PARAM_RAMP_MS` to reach
   * the first automated value, and that run-in is the graph settling rather than the mix.
   */
  const measure = async (): Promise<readonly [PadLaneBeat, PadLaneBeat]> => {
    const path = await bounceActiveSequence('probe-pad-lane', ctx);
    const decoded = decodeWav(new Uint8Array(await (await readFile(path)).arrayBuffer()));
    const left = decoded.channels[0]!;
    const right = decoded.channels[1] ?? left;
    const sr = decoded.sampleRate;
    const mono = new Float32Array(left.length);
    for (let i = 0; i < mono.length; i += 1) mono[i] = (left[i]! + right[i]!) / 2;
    const beat = (index: number): PadLaneBeat => ({
      headRms: rmsBetween(mono, sr, index * 0.5 + 0.02, index * 0.5 + 0.06),
      endSeconds: lastAudibleSeconds(mono, sr, index * 0.5, index * 0.5 + 0.5),
    });
    return [beat(0), beat(3)];
  };

  // --- the cutoff half: a level claim, with the pad's own filter nearly shut ---------------
  publishProgram(60);
  hydrate();
  const unautomated = await measure();
  hydrate(sweep(cutoffPath, 60, 12_000, 'exp'));
  const cutoffSwept = await measure();

  // --- the pitch half: a rate claim, with the filter open so the tone sounds ---------------
  publishProgram(20_000);
  hydrate();
  const unpitched = await measure();
  // Two octaves across the bar, so the last beat sits at +18 semitones and its quarter-second
  // region is consumed in 88 ms — well inside the 160 ms its tail window begins at.
  hydrate(sweep(pitchPath, 0, 24, 'linear'));
  const pitchSwept = await measure();
  hydrate();

  // --- the live half ----------------------------------------------------------------------
  //
  // Every render above built its own offline graph, so nothing has sounded live yet. Each §7.8
  // write below is made with the transport STOPPED and no voice sounding, so the only way it
  // can reach the pass that follows is through a value the next voice is BUILT against.
  // Writing each sounding voice reached nothing at all here, and every note of the pass was
  // built from the §6 payload's 60 Hz — which is why the two peaks used to be equal.
  publishProgram(60);
  const peakOver = async (ms: number): Promise<number> => {
    const slot = engine.meterRegistry.slotOf('master');
    let peak = 0;
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (slot !== undefined) {
        const reading = engine.meterRegistry.read(slot);
        peak = Math.max(peak, reading.peakL, reading.peakR);
      }
      await delay(16);
    }
    return peak;
  };
  const livePass = async (cutoff: number): Promise<number> => {
    engine.bridge.applyParam(cutoffPath, cutoff);
    transport().play();
    await delay(300); // past the first beat, so the meter is reading programme material
    const peak = await peakOver(1_400);
    transport().stop();
    await delay(200);
    return peak;
  };
  const liveOpenPeak = await livePass(12_000);
  const liveClosedPeak = await livePass(60);

  // Put the project back: the stores return to the §9.3 rows, taking the probe's program,
  // arrangement and lanes with them.
  await projectService.loadProject(projectId);

  return {
    cutoffPath,
    pitchPath,
    unautomated,
    cutoffSwept,
    unpitched,
    pitchSwept,
    liveOpenPeak,
    liveClosedPeak,
  };
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
    bounceMixProof: () => bounceMixProof(engine),
    gestureRenderProof: () => gestureRenderProof(engine),
    songParityProof: () => songParityProof(engine),
    liveEraseWrapProof: () => liveEraseWrapProof(engine),
    songEntryIndexProof: () => songEntryIndexProof(),
    insertDefaultsProof: () => insertDefaultsProof(),
    insertLimitProof: () => insertLimitProof(engine),
    padStripProof: () => padStripProof(engine),
    sequenceFilterProof: () => sequenceFilterProof(engine),
    trackWithdrawalProof: () => trackWithdrawalProof(engine),
    sharedPadChannelProof: () => sharedPadChannelProof(engine),
    padLaneProof: () => padLaneProof(engine),
    noteRepeatOwnerProof: () => noteRepeatOwnerProof(engine),
    schedulerBoundaryProof,
    declickContourProof,
    announcementProof,
    platformNoticeProof,
  };
}
