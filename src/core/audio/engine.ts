/**
 * AudioEngine — the audio core orchestrator (spec §5, §7). Owns the single AudioContext's
 * graph (§5.2), the voice pool (§5.4), the meter registry + taps (§5.8), the metronome and
 * preview channel (§5.9), the sample cache (§9.4), and — new in Phase 4 — the sequencer
 * {@link SchedulerClient} (§7.1) plus the dispatcher that realises its scheduled batches on
 * the graph (§7.1.4) and the playhead pump that reads the scheduler SAB each frame (§7.1.4).
 * Construction builds the (silent) graph synchronously; {@link initialise} loads the worklet
 * modules during the start gate (§5.1), starts the scheduler, and publishes the meter
 * registry. Every owned resource is released by {@link dispose} (spec §3.2).
 */
import { useProgramStore, useProjectStore, useSequenceStore, useTransportStore } from '@/store';
import { createDefaultEnvelope } from '@/core/project/schemas';
import { samplePath } from '@/core/storage/opfs';
import {
  createPlayheadSab,
  PlayheadReader,
  SchedulerClient,
  tickToBarBeatTick,
  type ScheduledEvent,
} from '@/core/sequencer';
import { meterScope } from '@/ui/primitives/meterScope';
import { createAudioBridge, type AudioBridge } from './audioBridge';
import { loadAudioWorklets } from './context';
import { ensureDemoSampleInOpfs } from './demoSample';
import type { ChannelHandle } from './factory';
import { MixerGraph } from './graph';
import { MeterRegistry } from './metering';
import { Metronome } from './metronome';
import { PreviewChannel } from './preview';
import { resolvedVoiceToTrigger, resolveVoice, type ResolvedVoice } from './programVoice';
import { SampleCache } from './sampleCache';
import { VoicePool } from './voicePool';

/** Identity of the Phase 3 demo pad/track used by the test UI + smoke (not shipped). */
const DEMO_PROGRAM_ID = 'phase3-demo';
const DEMO_TRACK_ID = 'phase3-demo';
const DEMO_PAD_INDEX = 0;
const DEMO_PAD_CHANNEL = `pad:${DEMO_PROGRAM_ID}:${DEMO_PAD_INDEX}`;

/** Coarse position readout is refreshed at most this often (spec §4.2 ≤ 4×/second). */
const COARSE_POSITION_INTERVAL_MS = 250;

export class AudioEngine {
  readonly graph: MixerGraph;
  readonly voicePool: VoicePool;
  readonly meterRegistry: MeterRegistry;
  readonly metronome: Metronome;
  readonly preview: PreviewChannel;
  readonly sampleCache: SampleCache;
  readonly bridge: AudioBridge;
  readonly scheduler: SchedulerClient;

  private readonly playheadReader: PlayheadReader;
  private readonly meterNodes: AudioWorkletNode[] = [];
  private readonly meterSinks: GainNode[] = [];
  /** Decoded program sample buffers keyed by sampleId (spec §9.4 decode-once). */
  private readonly programBuffers = new Map<string, AudioBuffer>();
  /** Pad/program channels whose §6 mixer has been pushed to the graph (apply once). */
  private readonly channelMixerApplied = new Set<string>();
  /** Preloaded demo sample the scheduler dispatch triggers per note (Phase 4 instrument). */
  private demoBuffer: AudioBuffer | null = null;
  private playheadRaf: number | null = null;
  private lastCoarseAt = 0;
  /** Count of scheduled notes the dispatcher has realised (test probe, §11.4). */
  private scheduledNotes = 0;
  private initialised = false;

  constructor(readonly context: AudioContext) {
    this.graph = new MixerGraph(context);
    this.voicePool = new VoicePool(context);
    this.meterRegistry = new MeterRegistry();
    this.metronome = new Metronome(context, this.graph.monitorBus);
    this.preview = new PreviewChannel(context, this.graph.monitorBus);
    this.sampleCache = new SampleCache(context);
    this.bridge = createAudioBridge({ graph: this.graph, context });
    const playheadSab = createPlayheadSab();
    this.playheadReader = new PlayheadReader(playheadSab);
    this.scheduler = new SchedulerClient({
      playheadSab,
      getClockPair: () => this.clockPair(),
      dispatch: (event) => this.dispatchScheduledEvent(event),
      onRecorded: (trackId, events) =>
        useSequenceStore
          .getState()
          .commitRecordedTake(trackId, events, useTransportStore.getState().recordMode),
      onErased: (trackId, eventIds) => useSequenceStore.getState().removeEvents(trackId, eventIds),
    });
  }

  /** Load worklets (start gate, §5.1), preload the demo instrument, start the scheduler. */
  async initialise(): Promise<void> {
    if (this.initialised) return;
    await loadAudioWorklets(this.context);
    this.attachMeterTap('master', this.graph.master.meterPoint);
    meterScope.setRegistry(this.meterRegistry);
    await this.preloadDemoInstrument();
    this.scheduler.start();
    this.startPlayheadPump();
    this.initialised = true;
  }

  /**
   * Play the bundled demo pluck from OPFS through a real voice → pad → track → master →
   * destination path (spec §12 audible proof; §5.4 pad playback from OPFS samples).
   */
  async triggerDemoPad(velocity = 110): Promise<void> {
    const projectId = useProjectStore.getState().projectId || DEMO_PROGRAM_ID;
    const path = await ensureDemoSampleInOpfs(projectId);
    const buffer = await this.sampleCache.get(path);
    const track = this.graph.ensureTrackChannel(DEMO_TRACK_ID);
    const pad = this.graph.ensurePadChannel(DEMO_PAD_CHANNEL, track.input);
    this.voicePool.trigger({
      id: crypto.randomUUID(),
      buffer,
      destination: pad.input,
      when: this.context.currentTime,
      velocity,
      playbackMode: 'oneShot', // a drum-style one-shot hit (spec §5.4)
      chokeGroup: 0,
      programId: DEMO_PROGRAM_ID,
      padKey: `${DEMO_PROGRAM_ID}:${DEMO_PAD_INDEX}`,
      amp: createDefaultEnvelope(),
      gainDb: 0,
      tuneSemitones: 0,
      tuneCents: 0,
    });
  }

  /** Sound one metronome click now (test UI); the scheduler drives this in Phase 4. */
  clickMetronome(accented = true): void {
    this.metronome.click(this.context.currentTime, accented);
  }

  /** Latest playhead reading from the scheduler SAB (spec §7.1.4) — for the test probe. */
  playheadTick(): number {
    return this.playheadReader.read().currentTick;
  }

  /** Total scheduled notes realised by the dispatcher — for the §11.4 record/play smoke. */
  scheduledNoteCount(): number {
    return this.scheduledNotes;
  }

  dispose(): void {
    if (this.playheadRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.playheadRaf);
    }
    this.playheadRaf = null;
    this.scheduler.dispose();
    meterScope.setRegistry(null);
    for (const node of this.meterNodes) node.disconnect();
    for (const sink of this.meterSinks) sink.disconnect();
    this.meterNodes.length = 0;
    this.meterSinks.length = 0;
    this.voicePool.destroy();
    this.metronome.destroy();
    this.preview.destroy();
    this.graph.destroy();
    this.sampleCache.clear();
    this.programBuffers.clear();
    this.channelMixerApplied.clear();
    this.demoBuffer = null;
  }

  // --------------------------------------------------------------- internals ---

  /**
   * Clock sync source for the worker (spec §7.1.2). `performanceTime` is sent in the
   * absolute-epoch domain (`timeOrigin + performance.now()`) so the offset survives the
   * worker's independent `performance.timeOrigin` — the worker estimates in the same
   * absolute domain (see `scheduler.worker.ts`). See spec §14 (2026-07-17 (f)).
   */
  private clockPair(): { contextTime: number; performanceTime: number } {
    const timestamp = this.context.getOutputTimestamp();
    return {
      contextTime: timestamp.contextTime ?? this.context.currentTime,
      performanceTime: performance.timeOrigin + (timestamp.performanceTime ?? performance.now()),
    };
  }

  /** Realise one scheduled event on the audio graph (spec §7.1.4 dispatcher). */
  private dispatchScheduledEvent(event: ScheduledEvent): void {
    switch (event.kind) {
      case 'noteOn':
        this.triggerScheduledNote(event);
        return;
      case 'click':
        this.metronome.click(event.when, event.accented ?? false);
        return;
      case 'automationRamp':
        if (event.target !== undefined && event.value !== undefined) {
          this.bridge.applyAutomation(event.target, event.value, event.when, event.rampEnd ?? event.when);
        }
        return;
      case 'noteOff':
        // Sequenced note lifetime is carried by `durationSec` on the noteOn (Phase 4 demo);
        // explicit note-off dispatch arrives with keygroup sustain in Phase 5.
        return;
    }
  }

  /**
   * Trigger one scheduled note (spec §7.1.4) by resolving the track's program → pad/zone →
   * layer into a real voice (spec §6, {@link resolveVoice}). Tracks with no program (or a
   * note that resolves to nothing, e.g. the Phase 4 demo track) fall back to the bundled
   * demo sample so the record-then-playback smoke stays audible (spec §12).
   */
  private triggerScheduledNote(event: ScheduledEvent): void {
    if (event.trackId === undefined || event.note === undefined) return;
    const resolved = this.resolveNote(event.trackId, event.note, event.velocity ?? 100);
    if (resolved) this.soundResolvedVoice(event.trackId, resolved, event);
    else this.triggerFallbackDemo(event);
  }

  /** Resolve a track's note to a §6 voice via its program, or null if nothing sounds. */
  private resolveNote(trackId: string, note: number, velocity: number): ResolvedVoice | null {
    const track = useSequenceStore.getState().tracks[trackId];
    if (!track?.programId) return null;
    const program = useProgramStore.getState().programs[track.programId];
    if (!program) return null;
    return resolveVoice(program, note, velocity);
  }

  /** Sound a resolved §6 voice, decoding its sample once and applying the §6 pad mixer. */
  private soundResolvedVoice(trackId: string, resolved: ResolvedVoice, event: ScheduledEvent): void {
    const projectId = useProjectStore.getState().projectId || DEMO_PROGRAM_ID;
    const programId = useSequenceStore.getState().tracks[trackId]?.programId ?? trackId;
    const channel = this.ensureProgramChannel(trackId, resolved);
    const play = (buffer: AudioBuffer): void => {
      this.scheduledNotes++;
      this.voicePool.trigger(
        resolvedVoiceToTrigger(resolved, {
          id: crypto.randomUUID(),
          buffer,
          destination: channel.input,
          when: event.when,
          velocity: event.velocity ?? 100,
          programId,
        }),
      );
    };
    const cached = this.programBuffers.get(resolved.sampleId);
    if (cached) {
      play(cached);
      return;
    }
    void this.sampleCache
      .get(samplePath(projectId, resolved.sampleId))
      .then((buffer) => {
        this.programBuffers.set(resolved.sampleId, buffer);
        play(buffer);
      })
      .catch(() => {
        // Missing/undecodable sample — the note is silently skipped, never a crash (spec §5.1).
      });
  }

  /**
   * The pad/program channel for a resolved voice, created under the track group and — on
   * first use — seeded with the §6 pad mixer (level/pan/sends). Live pad-mixer editing to
   * the graph is Mixer-mode work (Phase 7); here the stored §6 values are made audible.
   */
  private ensureProgramChannel(trackId: string, resolved: ResolvedVoice): ChannelHandle {
    const track = this.graph.ensureTrackChannel(trackId);
    const pad = this.graph.ensurePadChannel(resolved.channelId, track.input);
    if (!this.channelMixerApplied.has(resolved.channelId)) {
      this.channelMixerApplied.add(resolved.channelId);
      const now = this.context.currentTime;
      pad.setLevel(resolved.mixer.level, now, false);
      pad.setPan(resolved.mixer.pan, now, false);
      resolved.mixer.sendLevels.forEach((level, index) => pad.setSendGain(index, level, now, false));
    }
    return pad;
  }

  /** The Phase 4 demo instrument: one demo pad channel per (track, note) — the smoke path. */
  private triggerFallbackDemo(event: ScheduledEvent): void {
    if (!this.demoBuffer || event.trackId === undefined || event.note === undefined) return;
    this.scheduledNotes++;
    const track = this.graph.ensureTrackChannel(event.trackId);
    const pad = this.graph.ensurePadChannel(`pad:${event.trackId}:${event.note}`, track.input);
    this.voicePool.trigger({
      id: crypto.randomUUID(),
      buffer: this.demoBuffer,
      destination: pad.input,
      when: event.when,
      velocity: event.velocity ?? 100,
      playbackMode: 'oneShot',
      chokeGroup: 0,
      programId: event.trackId,
      padKey: `${event.trackId}:${event.note}`,
      amp: createDefaultEnvelope(),
      gainDb: 0,
      tuneSemitones: 0,
      tuneCents: 0,
    });
  }

  private async preloadDemoInstrument(): Promise<void> {
    const projectId = useProjectStore.getState().projectId || DEMO_PROGRAM_ID;
    const path = await ensureDemoSampleInOpfs(projectId);
    this.demoBuffer = await this.sampleCache.get(path);
  }

  /** Read the playhead SAB each frame and refresh the coarse readout ≤ 4×/s (spec §7.1.4). */
  private startPlayheadPump(): void {
    if (typeof requestAnimationFrame !== 'function') return;
    const pump = (): void => {
      const reading = this.playheadReader.read();
      const now = performance.now();
      if (now - this.lastCoarseAt >= COARSE_POSITION_INTERVAL_MS) {
        this.lastCoarseAt = now;
        this.publishCoarsePosition(reading.currentTick);
      }
      this.playheadRaf = requestAnimationFrame(pump);
    };
    this.playheadRaf = requestAnimationFrame(pump);
  }

  private publishCoarsePosition(currentTick: number): void {
    const { activeSequenceId } = useTransportStore.getState();
    const sequence = activeSequenceId ? useSequenceStore.getState().sequences[activeSequenceId] : undefined;
    const timeSig = sequence?.timeSig ?? { numerator: 4, denominator: 4 };
    const { bar, beat } = tickToBarBeatTick(currentTick, timeSig);
    useTransportStore.getState().setCoarsePosition({ bar, beat });
  }

  /**
   * Branch a `meter-tap` worklet off `tapPoint` into its own slot. Its output feeds a
   * silenced sink → destination so the node stays scheduled (and thus keeps writing the
   * SAB) without doubling the audible signal (spec §5.8).
   */
  private attachMeterTap(meterId: string, tapPoint: AudioNode): void {
    const slot = this.meterRegistry.allocate(meterId);
    const node = new AudioWorkletNode(this.context, 'meter-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sab: this.meterRegistry.sab, slot },
    });
    const sink = this.context.createGain();
    sink.gain.value = 0;
    tapPoint.connect(node);
    node.connect(sink);
    sink.connect(this.context.destination);
    this.meterNodes.push(node);
    this.meterSinks.push(sink);
  }
}
