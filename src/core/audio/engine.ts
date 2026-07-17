/**
 * AudioEngine — the Phase 3 audio core orchestrator (spec §5). Owns the single
 * AudioContext's graph (§5.2), the voice pool (§5.4), the meter registry + taps (§5.8),
 * the metronome and preview channel (§5.9), and the sample cache (§9.4). Construction
 * builds the (silent) graph synchronously; {@link initialise} loads the worklet modules
 * during the start gate (§5.1) and publishes the meter registry to the shared rAF loop.
 * Every owned resource is released by {@link dispose} (spec §3.2).
 */
import { useProjectStore } from '@/store';
import { createDefaultEnvelope } from '@/core/project/schemas';
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

export class AudioEngine {
  readonly graph: MixerGraph;
  readonly voicePool: VoicePool;
  readonly meterRegistry: MeterRegistry;
  readonly metronome: Metronome;
  readonly preview: PreviewChannel;
  readonly sampleCache: SampleCache;
  readonly bridge: AudioBridge;

  private readonly meterNodes: AudioWorkletNode[] = [];
  private readonly meterSinks: GainNode[] = [];
  private initialised = false;

  constructor(readonly context: AudioContext) {
    this.graph = new MixerGraph(context);
    this.voicePool = new VoicePool(context);
    this.meterRegistry = new MeterRegistry();
    this.metronome = new Metronome(context, this.graph.monitorBus);
    this.preview = new PreviewChannel(context, this.graph.monitorBus);
    this.sampleCache = new SampleCache(context);
    this.bridge = createAudioBridge({ graph: this.graph, context });
  }

  /** Load worklet modules (start gate, §5.1), attach the master meter, publish the SAB. */
  async initialise(): Promise<void> {
    if (this.initialised) return;
    await loadAudioWorklets(this.context);
    this.attachMeterTap('master', this.graph.master.meterPoint);
    meterScope.setRegistry(this.meterRegistry);
    this.initialised = true;
  }

  /**
   * Play the bundled demo pluck from OPFS through a real voice → pad → track → master →
   * destination path (spec §12 audible proof; §5.4 pad playback from OPFS samples).
   */
  async triggerDemoPad(velocity = 110): Promise<void> {
    const projectId = useProjectStore.getState().projectId;
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

  dispose(): void {
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
