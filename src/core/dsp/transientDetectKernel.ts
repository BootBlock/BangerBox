/**
 * TypeScript wrapper for the `transientDetect` WASM kernel (spec §5.6.4 / §7.5). An analysis
 * kernel (not a streaming effect): it copies a mono signal into linear memory, runs onset
 * detection, and reads back the detected frame indices. Runs in a plain worker over an OPFS
 * `.wav` (spec §7.5); each instance owns its module + memory (spec §5.6.3).
 */

interface TransientDetectExports {
  memory: WebAssembly.Memory;
  create(sampleRate: number, maxFrames: number): number;
  allocateBuffer(frames: number): number;
  freeBuffer(ptr: number): void;
  analyse(handle: number, inPtr: number, frames: number, sensitivity: number, minSpacingMs: number): number;
  onsetAt(handle: number, index: number): number;
  count(handle: number): number;
  free(handle: number): void;
}

/** URL of the built kernel binary (emitted by `npm run build:wasm` — spec §5.6). */
export function transientDetectWasmUrl(): URL {
  return new URL('./dist/transientDetect.wasm', import.meta.url);
}

export interface DetectOptions {
  /** 0..1 — higher finds more onsets (spec §8.5.4 sensitivity slider). */
  sensitivity?: number;
  /** Minimum spacing between onsets in ms (spec §7.5). */
  minSpacingMs?: number;
}

export class TransientDetectKernel {
  private disposed = false;
  private readonly inView: Float32Array;

  private constructor(
    private readonly exports: TransientDetectExports,
    private readonly handle: number,
    private readonly inPtr: number,
    private readonly maxFrames: number,
  ) {
    this.inView = new Float32Array(exports.memory.buffer, inPtr, maxFrames);
  }

  static fromModule(
    module: WebAssembly.Module,
    sampleRate: number,
    maxFrames: number,
  ): TransientDetectKernel {
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as TransientDetectExports;
    const handle = exports.create(sampleRate, maxFrames);
    const inPtr = exports.allocateBuffer(maxFrames);
    return new TransientDetectKernel(exports, handle, inPtr, maxFrames);
  }

  /** Detect onset frame indices in `samples` (spec §7.5, §8.5.4). */
  detect(samples: Float32Array, { sensitivity = 0.5, minSpacingMs = 30 }: DetectOptions = {}): number[] {
    this.assertLive();
    const frames = Math.min(samples.length, this.maxFrames);
    for (let i = 0; i < frames; i++) this.inView[i] = samples[i] as number;
    const count = this.exports.analyse(this.handle, this.inPtr, frames, sensitivity, minSpacingMs);
    const onsets: number[] = [];
    for (let i = 0; i < count; i++) onsets.push(this.exports.onsetAt(this.handle, i));
    return onsets;
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.freeBuffer(this.inPtr);
    this.exports.free(this.handle);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('TransientDetectKernel used after destroy()');
  }
}
