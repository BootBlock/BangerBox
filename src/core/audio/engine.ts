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
import { useProjectStore, useSequenceStore, useTransportStore } from '@/store';
import { createDefaultEnvelope } from '@/core/project/schemas';
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
import { MixerGraph } from './graph';
import { MeterRegistry } from './metering';
import { Metronome } from './metronome';
import { PreviewChannel } from './preview';
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
  /** Preloaded demo sample the scheduler dispatch triggers per note (Phase 4 instrument). */
  private demoBuffer: AudioBuffer | null = null;
  private playheadRaf: number | null = null;
  private lastCoarseAt = 0;
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
    this.demoBuffer = null;
  }

  // --------------------------------------------------------------- internals ---

  /** Clock sync source for the worker (spec §7.1.2). */
  private clockPair(): { contextTime: number; performanceTime: number } {
    const timestamp = this.context.getOutputTimestamp();
    return {
      contextTime: timestamp.contextTime ?? this.context.currentTime,
      performanceTime: timestamp.performanceTime ?? performance.now(),
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
   * Trigger one scheduled note through the Phase 4 demo instrument. Real program → pad →
   * layer resolution is Phase 5; here every (track, note) sounds the bundled demo sample so
   * the record-then-playback path is audible (spec §12 exit criterion).
   */
  private triggerScheduledNote(event: ScheduledEvent): void {
    if (!this.demoBuffer || event.trackId === undefined || event.note === undefined) return;
    const track = this.graph.ensureTrackChannel(event.trackId);
    // STUB(phase-5): one demo pad channel per (track, note) — real program routing follows.
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
