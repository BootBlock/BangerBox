/**
 * Looper recorder AudioWorkletProcessor — spec §8.5.8 / §5.5. Captures the master bus into a
 * lock-free {@link RingBuffer} (worklet → main drain, §5.5) while recording; the main thread
 * drains the ring, encodes WAV in a worker, and writes OPFS (spec §8.5.8). It down-mixes to mono
 * and allocates nothing in `process()` (a pre-allocated scratch block, spec §5.5). Recording is
 * toggled over the port.
 */
import { RingBuffer } from '../../dsp/ringBuffer';

interface RecorderOptions {
  sab: SharedArrayBuffer;
}

type RecorderMessage = { kind: 'record'; on: boolean } | { kind: 'dispose' };

class RecorderProcessor extends AudioWorkletProcessor {
  private ring: RingBuffer | null;
  private recording = false;
  /** Pre-allocated mono scratch for one render quantum (128 frames) — no allocation in process. */
  private readonly scratch = new Float32Array(128);

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { sab } = options.processorOptions as unknown as RecorderOptions;
    this.ring = new RingBuffer(sab);
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as RecorderMessage | null;
      if (message?.kind === 'record') this.recording = message.on;
      else if (message?.kind === 'dispose') {
        // Drop the ring and stop capturing; `process` then releases the processor (§3.2, §5.6.3).
        this.recording = false;
        this.ring = null;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ring = this.ring;
    if (!ring) return false; // disposed — release the processor (§3.2)
    if (!this.recording) return true;
    const input = inputs[0];
    const left = input?.[0];
    if (!left) return true;
    const right = input[1] ?? left;
    const frames = Math.min(left.length, this.scratch.length);
    for (let i = 0; i < frames; i++) this.scratch[i] = (left[i]! + right[i]!) * 0.5;
    // Push exactly the frames captured this quantum (a view — no buffer allocation, §5.5).
    ring.push(frames === this.scratch.length ? this.scratch : this.scratch.subarray(0, frames));
    return true;
  }
}

registerProcessor('looper-recorder', RecorderProcessor);
