/**
 * Looper capture (spec §8.5.8) — resamples the master bus into a lock-free {@link RingBuffer}
 * (via the `looper-recorder` worklet, §5.5), drains it on the main thread, and saves the take as
 * a new mono sample (WAV worker → OPFS, spec §8.5.8). One capture at a time. The recorder worklet
 * writes nothing while stopped, so the node can stay attached across takes. Mic-source capture and
 * the tempo-locked bar length are Phase 7 Looper-mode polish; this proves the capture path.
 */
import { RingBuffer } from '@/core/dsp/ringBuffer';
import type { SampleRow } from '@/core/storage/repositories';
import { saveChannelsAsSample, type SampleWriteContext } from './sampleImport';

/** Maximum capture length before the ring wraps (spec §8.5.8 — generous default). */
const MAX_CAPTURE_SECONDS = 30;

export class Looper {
  private readonly ring: RingBuffer;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private drainRaf: number | null = null;
  private recording = false;
  /** Pre-allocated pull buffer for draining the ring (reused each rAF). */
  private readonly pull = new Float32Array(8192);

  constructor(
    private readonly context: AudioContext,
    private readonly masterTap: AudioNode,
    sampleRate: number,
  ) {
    this.ring = RingBuffer.create(MAX_CAPTURE_SECONDS * sampleRate + 1);
  }

  /** Attach the recorder worklet to the master bus (spec §8.5.8). */
  attach(): void {
    this.node = new AudioWorkletNode(this.context, 'looper-recorder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sab: this.ring.sab },
    });
    // A silenced sink keeps the node scheduled without doubling audio (like the meter taps).
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.masterTap.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  get isRecording(): boolean {
    return this.recording;
  }

  startRecording(): void {
    if (this.recording) return;
    this.chunks = [];
    this.drainRing();
    this.recording = true;
    this.node?.port.postMessage({ kind: 'record', on: true });
    const drain = (): void => {
      this.drainRing();
      if (this.recording) this.drainRaf = requestAnimationFrame(drain);
    };
    this.drainRaf = requestAnimationFrame(drain);
  }

  /** Stop, save the take as a mono sample, and return its row (or null if nothing captured). */
  async stopRecording(sampleRate: number, ctx: SampleWriteContext): Promise<SampleRow | null> {
    if (!this.recording) return null;
    this.recording = false;
    this.node?.port.postMessage({ kind: 'record', on: false });
    if (this.drainRaf !== null) cancelAnimationFrame(this.drainRaf);
    this.drainRaf = null;
    // Let the last render quanta reach the ring, then drain the remainder.
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.drainRing();

    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total === 0) return null;
    const captured = new Float32Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      captured.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    return saveChannelsAsSample([captured], sampleRate, 'Looper take', ['looper', 'recorded'], ctx);
  }

  private drainRing(): void {
    let read = this.ring.pull(this.pull);
    while (read > 0) {
      this.chunks.push(this.pull.slice(0, read));
      read = this.ring.pull(this.pull);
    }
  }

  destroy(): void {
    if (this.drainRaf !== null) cancelAnimationFrame(this.drainRaf);
    this.drainRaf = null;
    this.node?.disconnect();
    this.sink?.disconnect();
    this.node = null;
    this.sink = null;
    this.chunks = [];
  }
}
