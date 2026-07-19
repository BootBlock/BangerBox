/**
 * Looper capture (spec §8.5.8) — resamples the master bus into a lock-free {@link RingBuffer}
 * (via the `looper-recorder` worklet, §5.5), drains it on the main thread, and saves the take as
 * a new mono sample (WAV worker → OPFS, spec §8.5.8). One capture at a time. The recorder worklet
 * writes nothing while stopped, so the node can stay attached across takes.
 *
 * A capture may be bar-locked: given a target frame count derived from the transport tempo and
 * time signature, the drain loop stops itself on the bar line and the take is written at exactly
 * that length, so successive overdubs stay phase-aligned. Overdub sums onto the held take;
 * `clear` discards it. Mic-source capture remains Phase 7 Looper-mode polish.
 */
import { RingBuffer } from '@/core/dsp/ringBuffer';
import type { SampleRow } from '@/core/storage/repositories';
import { saveChannelsAsSample, type SampleWriteContext } from './sampleImport';

/**
 * Ring headroom in seconds (spec §8.5.8). This bounds how far the drain loop may fall behind the
 * worklet before the ring wraps — not the length of a take, which accumulates on the main thread.
 */
const MAX_CAPTURE_SECONDS = 30;

/**
 * Fold a drained capture into the held take (spec §8.5.8). A bar-locked capture is written
 * into a buffer of exactly `targetFrames` — silence-padded if the worklet's 128-frame quanta
 * came up short, truncated if they overran — so overdub layers stay phase-aligned across
 * takes. Overdubbing sums onto the base and may exceed unity; the WAV encoder clamps on write.
 * Pure, so the length and layering rules are unit-testable without an AudioContext (§7.1.5).
 */
export function foldCaptureIntoTake(
  chunks: readonly Float32Array[],
  base: Float32Array | null,
  targetFrames: number,
): Float32Array | null {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total === 0) return base;
  const length = targetFrames > 0 ? targetFrames : total;
  const captured = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const slice = offset + chunk.length <= length ? chunk : chunk.subarray(0, length - offset);
    captured.set(slice, offset);
    offset += slice.length;
  }
  if (!base) return captured;
  const merged = new Float32Array(Math.max(base.length, captured.length));
  merged.set(base);
  for (let i = 0; i < captured.length; i += 1) merged[i]! += captured[i]!;
  return merged;
}

export interface LooperCaptureOptions {
  /**
   * Bar-locked capture length in frames; the capture stops itself once reached and the take is
   * written at exactly this length. Omit (or 0) to capture open-ended until stopped by hand.
   */
  readonly targetFrames?: number;
  /** Sum onto the held take instead of replacing it (spec §8.5.8 overdub). */
  readonly overdub?: boolean;
  /**
   * Called on every drain frame with 0..1 capture progress. It rides the drain loop that already
   * runs while recording, so the progress ring costs no second rAF (spec §8.4), and the value
   * goes straight to the caller rather than through React state (spec §3.3).
   */
  readonly onProgress?: (progress: number) => void;
  /** Called once the bar-locked length is reached and the capture has stopped itself. */
  readonly onComplete?: () => void;
}

export class Looper {
  private readonly ring: RingBuffer;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private drainRaf: number | null = null;
  private recording = false;
  /** The held take: what overdub layers onto and what `save` writes. */
  private take: Float32Array | null = null;
  private capturedFrames = 0;
  private targetFrames = 0;
  private overdub = false;
  private onProgress: ((progress: number) => void) | null = null;
  private onComplete: (() => void) | null = null;
  /** Frames the ring can hold — the yardstick for open-ended progress. */
  private readonly ringFrames: number;
  /** Pre-allocated pull buffer for draining the ring (reused each rAF). */
  private readonly pull = new Float32Array(8192);

  constructor(
    private readonly context: AudioContext,
    private readonly masterTap: AudioNode,
    sampleRate: number,
  ) {
    this.ringFrames = MAX_CAPTURE_SECONDS * sampleRate;
    this.ring = RingBuffer.create(this.ringFrames + 1);
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

  /** True once a take is held, so it can be overdubbed onto, saved, or cleared. */
  get hasTake(): boolean {
    return this.take !== null;
  }

  /**
   * Capture progress, 0..1. A bar-locked capture measures against its target length; an
   * open-ended one against the ring headroom, which is the only bound it has.
   */
  get progress(): number {
    if (!this.recording) return 0;
    const span = this.targetFrames > 0 ? this.targetFrames : this.ringFrames;
    return Math.min(1, this.capturedFrames / span);
  }

  startRecording(options: LooperCaptureOptions = {}): void {
    if (this.recording) return;
    this.targetFrames = Math.max(0, Math.floor(options.targetFrames ?? 0));
    // Overdub without a take to layer onto is just a fresh capture.
    this.overdub = options.overdub === true && this.take !== null;
    this.onProgress = options.onProgress ?? null;
    this.onComplete = options.onComplete ?? null;
    // Discard whatever the worklet left in the ring between takes before counting frames.
    this.drainRing();
    this.chunks = [];
    this.capturedFrames = 0;
    this.recording = true;
    this.node?.port.postMessage({ kind: 'record', on: true });

    const drain = (): void => {
      this.drainRing();
      this.onProgress?.(this.progress);
      if (this.targetFrames > 0 && this.capturedFrames >= this.targetFrames) {
        // The bar line is reached: stop ourselves and tell the caller once the take is folded in.
        this.drainRaf = null;
        const notify = this.onComplete;
        void this.stopRecording().then(() => notify?.());
        return;
      }
      this.drainRaf = requestAnimationFrame(drain);
    };
    this.drainRaf = requestAnimationFrame(drain);
  }

  /**
   * Stop the capture and fold it into the held take — replacing it, or summing when
   * overdubbing. Resolves false when the capture produced no audio, in which case any take
   * already held is left alone rather than being destroyed by an empty pass.
   */
  async stopRecording(): Promise<boolean> {
    if (!this.recording) return false;
    this.recording = false;
    this.node?.port.postMessage({ kind: 'record', on: false });
    if (this.drainRaf !== null) cancelAnimationFrame(this.drainRaf);
    this.drainRaf = null;
    // Let the last render quanta reach the ring, then drain the remainder.
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.drainRing();
    const folded = foldCaptureIntoTake(this.chunks, this.overdub ? this.take : null, this.targetFrames);
    const captured = this.chunks.length > 0;
    this.chunks = [];
    if (folded) this.take = folded;
    this.onProgress?.(0);
    return captured;
  }

  /** Discard the held take without saving it (spec §8.5.8 clear). */
  clear(): void {
    this.take = null;
    this.chunks = [];
    this.capturedFrames = 0;
  }

  /**
   * Save the held take as a mono sample and return its row, or null when nothing is held. The
   * take survives the save, so it can be overdubbed further or saved again as a second sample.
   */
  async save(sampleRate: number, ctx: SampleWriteContext): Promise<SampleRow | null> {
    const take = this.take;
    if (!take || take.length === 0) return null;
    return saveChannelsAsSample([take], sampleRate, 'Looper take', ['looper', 'recorded'], ctx);
  }

  private drainRing(): void {
    let read = this.ring.pull(this.pull);
    while (read > 0) {
      this.chunks.push(this.pull.slice(0, read));
      this.capturedFrames += read;
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
    this.take = null;
    this.onProgress = null;
    this.onComplete = null;
  }
}
