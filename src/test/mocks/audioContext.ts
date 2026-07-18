/**
 * Fake Web Audio graph for unit tests — spec §11.3: happy-dom ships no Web Audio, so
 * factory/graph lifecycle and create/destroy call-accounting (spec §5.3, §3.2) run
 * against this mock. It is deliberately behaviour-free (no DSP): it records node
 * creation, `connect`/`disconnect`, and `AudioParam` scheduling so tests can assert the
 * graph is wired and, crucially, fully torn down (no orphaned nodes — spec §3.2).
 *
 * Real DSP correctness is proven separately by OfflineAudioContext renders in the
 * browser (spec §11.2/§11.4), never by this mock.
 */

export interface ParamCall {
  method: string;
  args: number[];
}

class FakeAudioParam {
  value: number;
  readonly calls: ParamCall[] = [];
  constructor(public readonly defaultValue = 0) {
    this.value = defaultValue;
  }
  setValueAtTime(value: number, when: number): this {
    this.value = value;
    this.calls.push({ method: 'setValueAtTime', args: [value, when] });
    return this;
  }
  linearRampToValueAtTime(value: number, when: number): this {
    this.value = value;
    this.calls.push({ method: 'linearRampToValueAtTime', args: [value, when] });
    return this;
  }
  exponentialRampToValueAtTime(value: number, when: number): this {
    this.value = value;
    this.calls.push({ method: 'exponentialRampToValueAtTime', args: [value, when] });
    return this;
  }
  setTargetAtTime(value: number, when: number, timeConstant: number): this {
    this.value = value;
    this.calls.push({ method: 'setTargetAtTime', args: [value, when, timeConstant] });
    return this;
  }
  cancelScheduledValues(when: number): this {
    this.calls.push({ method: 'cancelScheduledValues', args: [when] });
    return this;
  }
  cancelAndHoldAtTime(when: number): this {
    this.calls.push({ method: 'cancelAndHoldAtTime', args: [when] });
    return this;
  }
  setValueCurveAtTime(values: Float32Array, when: number, duration: number): this {
    this.calls.push({ method: 'setValueCurveAtTime', args: [when, duration] });
    return this;
  }
}

let nodeSeq = 0;

class FakeAudioNode {
  readonly id = nodeSeq++;
  readonly outputs: FakeAudioNode[] = [];
  disconnectCount = 0;
  /** True once `disconnect()` has been called with no argument (full teardown). */
  fullyDisconnected = false;

  constructor(
    readonly context: FakeAudioContext,
    readonly nodeType: string,
  ) {
    context.registerNode(this);
  }

  connect<T extends FakeAudioNode | FakeAudioParam>(destination: T): T {
    if (destination instanceof FakeAudioNode) this.outputs.push(destination);
    return destination;
  }

  disconnect(destination?: FakeAudioNode): void {
    this.disconnectCount++;
    if (destination === undefined) {
      this.outputs.length = 0;
      this.fullyDisconnected = true;
      return;
    }
    const index = this.outputs.indexOf(destination);
    if (index >= 0) this.outputs.splice(index, 1);
  }
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1);
  constructor(context: FakeAudioContext) {
    super(context, 'gain');
  }
}
class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam(0);
  constructor(context: FakeAudioContext) {
    super(context, 'stereoPanner');
  }
}
class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  readonly frequency = new FakeAudioParam(350);
  readonly Q = new FakeAudioParam(1);
  readonly gain = new FakeAudioParam(0);
  readonly detune = new FakeAudioParam(0);
  constructor(context: FakeAudioContext) {
    super(context, 'biquad');
  }
}
class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam(0);
  constructor(context: FakeAudioContext) {
    super(context, 'delay');
  }
}
class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam(-24);
  readonly knee = new FakeAudioParam(30);
  readonly ratio = new FakeAudioParam(12);
  readonly attack = new FakeAudioParam(0.003);
  readonly release = new FakeAudioParam(0.25);
  constructor(context: FakeAudioContext) {
    super(context, 'compressor');
  }
}
class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  constructor(context: FakeAudioContext) {
    super(context, 'waveShaper');
  }
}
class FakeConvolverNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
  constructor(context: FakeAudioContext) {
    super(context, 'convolver');
  }
}
class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 2048;
  readonly frequencyBinCount = 1024;
  constructor(context: FakeAudioContext) {
    super(context, 'analyser');
  }
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(0);
  }
}
class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam(440);
  readonly detune = new FakeAudioParam(0);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  constructor(context: FakeAudioContext) {
    super(context, 'oscillator');
  }
  start(_when?: number): void {
    this.started = true;
  }
  stop(_when?: number): void {
    this.stopped = true;
  }
}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeAudioParam(1);
  readonly detune = new FakeAudioParam(0);
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  /** Arguments of the `start()` call, so trim (offset/duration) is assertable — spec §6. */
  startArgs: { when?: number; offset?: number; duration?: number } | null = null;
  constructor(context: FakeAudioContext) {
    super(context, 'bufferSource');
  }
  /** `when` of the `stop()` call, so a fade-then-stop is assertable — spec §5.4. */
  stopWhen: number | undefined;
  start(when?: number, offset?: number, duration?: number): void {
    this.started = true;
    this.startArgs = { when, offset, duration };
  }
  stop(when?: number): void {
    this.stopped = true;
    this.stopWhen = when;
  }
}

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? new Float32Array(this.length);
  }
}

export class FakeAudioContext {
  readonly nodes: FakeAudioNode[] = [];
  readonly destination: FakeAudioNode;
  currentTime = 0;
  state: AudioContextState = 'running';

  constructor(readonly sampleRate = 48_000) {
    this.destination = new FakeAudioNode(this, 'destination');
  }

  registerNode(node: FakeAudioNode): void {
    this.nodes.push(node);
  }

  createGain(): FakeGainNode {
    return new FakeGainNode(this);
  }
  createStereoPanner(): FakeStereoPannerNode {
    return new FakeStereoPannerNode(this);
  }
  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode(this);
  }
  createDelay(_maxDelaySeconds?: number): FakeDelayNode {
    return new FakeDelayNode(this);
  }
  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return new FakeDynamicsCompressorNode(this);
  }
  createWaveShaper(): FakeWaveShaperNode {
    return new FakeWaveShaperNode(this);
  }
  createConvolver(): FakeConvolverNode {
    return new FakeConvolverNode(this);
  }
  createAnalyser(): FakeAnalyserNode {
    return new FakeAnalyserNode(this);
  }
  createBufferSource(): FakeAudioBufferSourceNode {
    return new FakeAudioBufferSourceNode(this);
  }
  createOscillator(): FakeOscillatorNode {
    return new FakeOscillatorNode(this);
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
  }
}

/** How many of `context`'s nodes are still connected (leaked) — spec §3.2. */
export function liveNodeCount(context: FakeAudioContext): number {
  return context.nodes.filter((node) => node.outputs.length > 0 && !node.fullyDisconnected).length;
}

/** Build a fake context typed as a real `AudioContext` for injection into the graph. */
export function createFakeAudioContext(sampleRate = 48_000): {
  context: AudioContext;
  fake: FakeAudioContext;
} {
  const fake = new FakeAudioContext(sampleRate);
  return { context: fake as unknown as AudioContext, fake };
}
