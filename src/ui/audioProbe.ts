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
  renderLfoPhaseOffline,
  renderLfoRateOffline,
  renderProgramNote,
  type DelayEchoResult,
  type EffectRenderResult,
} from '@/core/audio/offlineTest';
import { getActiveRepositories, projectService } from '@/core/project';
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
import { useProjectStore, useSequenceStore, useTransportStore } from '@/store';

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
  };
}
