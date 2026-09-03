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
  type KeygroupZone,
  type VelocityLayer,
} from '@/core/project/schemas';
import { useMixerStore, useProjectStore, useSequenceStore, useTransportStore } from '@/store';
import { commitTempo } from '@/store/tempo';
import { decodeWav, encodeWav } from '@/core/audio/wav';
import { createPlayheadSab, PlayheadReader, PlayheadWriter } from '@/core/sequencer';
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
  };
}
