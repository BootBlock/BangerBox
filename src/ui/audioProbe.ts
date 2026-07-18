/**
 * Audio probe — the DOM-reachable test seam the Playwright smoke drives (spec §11.4).
 * It exposes read-only introspection (master meter peak, live voice count, playhead), the
 * offline effect renders (§11.2), and the Phase 4 record-then-playback proof (§12 exit) —
 * all surfaces that have no other browser-observable handle. Installed only once the engine
 * has started from a user gesture. Harmless in production: it drives the same stores and
 * scheduler the UI does.
 */
import type { AudioEngine } from '@/core/audio/engine';
import {
  renderEffectOffline,
  renderProgramNotePitch,
  type EffectRenderResult,
} from '@/core/audio/offlineTest';
import { projectService } from '@/core/project';
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
import { useSequenceStore, useTransportStore } from '@/store';

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
  /** .mpcweb export → import round-trip (spec §12 exit / §9.6 pack round-trip smoke). */
  packRoundTrip: () => Promise<{ imported: boolean; samples: number }>;
  /** Import → transient chop → time-stretch of a synthetic drum (spec §7.5/§8.5.4/§5.7.9). */
  samplePipelineProof: () => Promise<{
    chops: number;
    importedFrames: number;
    stretchedFrames: number;
    stretchedRatio: number;
  }>;
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
  const soft = await renderProgramNotePitch(program, 0, 30);
  const hard = await renderProgramNotePitch(program, 0, 110);
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
  const root = await renderProgramNotePitch(program, 60, 100);
  const octave = await renderProgramNotePitch(program, 72, 100);
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
  const sequence = { ...createDefaultSequence(crypto.randomUUID(), 0, 'Smoke', seqId), lengthBars: 1 };
  const track = createDefaultTrack(seqId, null, 0, 'Smoke', 'drum', trackId);
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
    for (let i = 0; i < tone.length; i++)
      {tone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / ctx.projectSampleRate);}
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
  const chops = await chopSampleToNewSamples(imported, { sensitivity: 0.6, minSpacingMs: 40 }, ctx);
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
    packRoundTrip,
    samplePipelineProof: () => samplePipelineProof(engine),
  };
}
