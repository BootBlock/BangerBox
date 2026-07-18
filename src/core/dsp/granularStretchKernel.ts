/**
 * TypeScript wrapper for the `granularStretch` WASM kernel (spec §5.6.4 / §5.7.9). A one-shot
 * offline render: independent time-stretch (`rate`) and pitch-shift (`pitchSemitones`). Used by
 * the sample editor's Time-stretch tool and per-pad warp pre-render (spec §5.7.9). Owns its
 * module + memory (spec §5.6.3); the output buffer is sized for the maximum 4× expansion.
 */

interface GranularStretchExports {
  memory: WebAssembly.Memory;
  create(sampleRate: number, maxBlock: number): number;
  allocateBuffer(frames: number): number;
  freeBuffer(ptr: number): void;
  render(
    handle: number,
    inPtr: number,
    inFrames: number,
    outPtr: number,
    outCapacity: number,
    rate: number,
    pitchSemitones: number,
  ): number;
  free(handle: number): void;
}

/** URL of the built kernel binary (emitted by `npm run build:wasm` — spec §5.6). */
export function granularStretchWasmUrl(): URL {
  return new URL('./dist/granularStretch.wasm', import.meta.url);
}

export interface StretchParams {
  /** Time-stretch factor 0.25–4× (output length ≈ input / rate) — spec §5.7.9. */
  rate: number;
  /** Pitch shift in semitones ±24 — spec §5.7.9. */
  pitchSemitones: number;
}

export class GranularStretchKernel {
  private disposed = false;
  private readonly inView: Float32Array;
  private readonly outView: Float32Array;

  private constructor(
    private readonly exports: GranularStretchExports,
    private readonly handle: number,
    private readonly inPtr: number,
    private readonly outPtr: number,
    private readonly inCapacity: number,
    private readonly outCapacity: number,
  ) {
    this.inView = new Float32Array(exports.memory.buffer, inPtr, inCapacity);
    this.outView = new Float32Array(exports.memory.buffer, outPtr, outCapacity);
  }

  /** Allocate for up to `maxInputFrames`; the output buffer holds the 4× worst-case expansion. */
  static fromModule(
    module: WebAssembly.Module,
    sampleRate: number,
    maxInputFrames: number,
  ): GranularStretchKernel {
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as GranularStretchExports;
    const handle = exports.create(sampleRate, maxInputFrames);
    const outCapacity = Math.ceil(maxInputFrames / 0.25) + 1; // rate 0.25 → 4× length
    const inPtr = exports.allocateBuffer(maxInputFrames);
    const outPtr = exports.allocateBuffer(outCapacity);
    return new GranularStretchKernel(exports, handle, inPtr, outPtr, maxInputFrames, outCapacity);
  }

  /** Render `input` through the kernel, returning a freshly-sized stretched buffer. */
  render(input: Float32Array, { rate, pitchSemitones }: StretchParams): Float32Array {
    this.assertLive();
    const inFrames = Math.min(input.length, this.inCapacity);
    for (let i = 0; i < inFrames; i++) this.inView[i] = input[i] as number;
    const outFrames = this.exports.render(
      this.handle,
      this.inPtr,
      inFrames,
      this.outPtr,
      this.outCapacity,
      rate,
      pitchSemitones,
    );
    return this.outView.slice(0, outFrames);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.freeBuffer(this.inPtr);
    this.exports.freeBuffer(this.outPtr);
    this.exports.free(this.handle);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GranularStretchKernel used after destroy()');
  }
}
