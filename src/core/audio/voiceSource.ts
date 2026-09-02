/**
 * The sound source of one voice — spec §5.2 stage 1, which names two of them: an
 * `AudioBufferSourceNode` for ordinary sample playback, and a worklet source for the
 * §5.7.9 time-stretch engine a warp pad plays through.
 *
 * The voice pool builds its whole chain against this interface so the two are
 * interchangeable: both carry a `detune` AudioParam in cents, so the §6 pitch envelope,
 * keygroup glide, pitch-routed LFOs and the §10.2 bend node all write to one address
 * whichever source is underneath.
 *
 * The two differ in one way the pool must know about, and {@link VoiceSource.pitchCoupled}
 * names it: on a buffer source detune IS the playback rate, so pitch and duration move
 * together and the §5.4 declick has to integrate the whole detune contour to find where the
 * region ends (issue #87). On the warp source they are independent by construction, so the
 * end is simply the start plus the source's own length — and a later retune does not move it.
 */
import { GRANULAR_SOURCE_PROCESSOR, type GranularSourceMessage } from './worklets/granularSourceProtocol';
import type { PlayRegion } from './voicePool';

export interface VoiceSource {
  /** The node feeding the voice's amp gain (spec §5.2 stage 2). */
  readonly node: AudioNode;
  /** Pitch offset in cents — the address every §6 pitch modulator writes to. */
  readonly detune: AudioParam;
  /** True when detune is also the playback rate (spec §5.5 coupled repitch). */
  readonly pitchCoupled: boolean;
  /**
   * Seconds the source sounds. For a coupled source these are BUFFER seconds, consumed
   * faster or slower as detune moves; for an uncoupled one they are output seconds, fixed.
   */
  readonly sourceSeconds: number;
  start(when: number): void;
  stop(when?: number): void;
  /** Called once when the source reaches its natural end (spec §3.2 teardown). */
  setOnEnded(handler: (() => void) | null): void;
  /** Every param the source automates, for the §3.2 cancel-before-teardown sweep. */
  automatedParams(): AudioParam[];
  /** Disconnect and release everything the source owns (spec §3.2, §5.6.3). */
  destroy(): void;
}

/** The ordinary §5.2 stage-1 source: an `AudioBufferSourceNode` over a trimmed region. */
export function createBufferVoiceSource(
  context: BaseAudioContext,
  buffer: AudioBuffer,
  region: PlayRegion,
): VoiceSource {
  const source = context.createBufferSource();
  source.buffer = buffer;
  return {
    node: source,
    detune: source.detune,
    pitchCoupled: true,
    sourceSeconds: region.durationSeconds,
    start: (when) => source.start(when, region.offsetSeconds, region.durationSeconds),
    stop: (when) => source.stop(when),
    setOnEnded: (handler) => {
      source.onended = handler;
    },
    automatedParams: () => [source.detune, source.playbackRate],
    destroy: () => {
      source.onended = null;
      try {
        source.disconnect();
      } catch {
        // Never connected / already gone.
      }
    },
  };
}

/**
 * The §5.7.9 warp source: an `AudioWorkletNode` running the `granularStretch` kernel over
 * the voice's region, so detune shifts pitch and leaves the duration alone.
 *
 * The region is sliced per voice because `processorOptions` are structured-cloned and a
 * `subarray` view would clone the whole sample behind it. That is one copy of the region
 * per note, on the main thread — never in `process()` (spec §5.5).
 */
export function createGranularVoiceSource(
  context: BaseAudioContext,
  module: WebAssembly.Module,
  buffer: AudioBuffer,
  region: PlayRegion,
  startAt: number,
  rate = 1,
): VoiceSource {
  const startFrame = Math.round(region.offsetSeconds * buffer.sampleRate);
  const frames = Math.max(1, Math.round(region.durationSeconds * buffer.sampleRate));
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channels.push(buffer.getChannelData(channel).slice(startFrame, startFrame + frames));
  }

  const node = new AudioWorkletNode(context, GRANULAR_SOURCE_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels.length],
    processorOptions: { module, channels, rate, startTime: startAt, maxBlock: 128 },
  });
  const detune = node.parameters.get('detune');
  if (!detune) throw new Error('granular-source exposes no detune parameter');

  let ended: (() => void) | null = null;
  node.port.onmessage = (event: MessageEvent) => {
    const message = event.data as GranularSourceMessage | null;
    if (message?.kind === 'ended') ended?.();
  };

  return {
    node,
    detune,
    pitchCoupled: false,
    sourceSeconds: region.durationSeconds / rate,
    // The start time went in with the processor options, because a worklet source begins
    // producing the moment its node exists and a scheduled note may be up to
    // `LOOKAHEAD_MS` away (spec §7.1.4); the processor holds silence until its frame.
    start: () => {},
    // Steal, choke and release all cut a voice short (spec §5.4). On a buffer source that
    // is `stop(when)`; here it is a message the processor acts on at the matching frame.
    stop: (when) => {
      const message: GranularSourceMessage = { kind: 'stop', when: when ?? context.currentTime };
      node.port.postMessage(message);
    },
    setOnEnded: (handler) => {
      ended = handler;
    },
    automatedParams: () => [detune],
    destroy: () => {
      ended = null;
      node.port.onmessage = null;
      // Free the kernel memory BEFORE the node is disconnected (spec §5.6.3).
      const dispose: GranularSourceMessage = { kind: 'dispose' };
      node.port.postMessage(dispose);
      node.disconnect();
    },
  };
}
