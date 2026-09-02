/**
 * TypeScript wrappers for the `granularStretch` WASM kernel (spec §5.6.4 / §5.7.9),
 * covering both of the kernel's entry points:
 *
 *  - {@link GranularStretchKernel} — the one-shot offline render behind the sample editor's
 *    Time-stretch tool: independent time-stretch (`rate`) and pitch-shift (`pitchSemitones`).
 *  - {@link GranularSourceKernel} — the real-time §5.7.9 warp source, producing one render
 *    quantum at a time from a resident region so a warp pad plays with pitch and duration
 *    decoupled (spec §5.2 stage 1, §5.5).
 *
 * Both own their module + memory (spec §5.6.3) and hide the pointers from consumers, so the
 * implementation language stays swappable (spec §5.6.1, §1.3 #5).
 */

interface GranularStretchExports {
  memory: WebAssembly.Memory;
  create(sampleRate: number, maxBlock: number): number;
  createStream(sampleRate: number, maxBlock: number): number;
  prepareStream(handle: number, inPtr: number, inFrames: number, rate: number): number;
  streamBlock(handle: number, outPtr: number, frames: number, detuneCents: number): number;
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

/**
 * The §5.7.9 warp source: a granular stream over one resident region, block by block.
 *
 * The whole region lives in this instance's own linear memory. That is what lets
 * {@link process} allocate nothing and touch no main-thread object (spec §5.5), and it costs
 * one Float32 copy of the region per voice — the price of a real-time source that can read
 * the region at a different rate from the one it writes at.
 *
 * `rate` is fixed at construction because the §5.4 declick is laid against the resulting
 * length at note-on; `detuneCents` is per block, so §6 pitch modulation and the §7.8 pad
 * detune still reach a warp voice.
 */
export class GranularSourceKernel {
  private disposed = false;
  private readonly outView: Float32Array;

  private constructor(
    private readonly exports: GranularStretchExports,
    private readonly handle: number,
    private readonly regionPtr: number,
    private readonly outPtr: number,
    private readonly maxBlock: number,
    /** Output frames the stream will produce in total — the voice's true region length. */
    readonly totalFrames: number,
  ) {
    this.outView = new Float32Array(exports.memory.buffer, outPtr, maxBlock);
  }

  /**
   * Bind one channel of a region to a fresh kernel instance. `region` is copied into the
   * kernel's memory, so the caller's array is free to be reused or dropped afterwards.
   */
  static fromModule(
    module: WebAssembly.Module,
    sampleRate: number,
    maxBlock: number,
    region: Float32Array,
    rate: number,
  ): GranularSourceKernel {
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as GranularStretchExports;
    const handle = exports.createStream(sampleRate, maxBlock);
    const frames = Math.max(1, region.length);
    // Every allocation happens before any view is taken: `allocateBuffer` may grow the heap,
    // which detaches views built against the old buffer (spec §5.6.3).
    const regionPtr = exports.allocateBuffer(frames);
    const outPtr = exports.allocateBuffer(maxBlock);
    const regionView = new Float32Array(exports.memory.buffer, regionPtr, frames);
    regionView.set(region.subarray(0, frames));
    const totalFrames = exports.prepareStream(handle, regionPtr, region.length, rate);
    return new GranularSourceKernel(exports, handle, regionPtr, outPtr, maxBlock, totalFrames);
  }

  /**
   * Fill `output` with the next block, shifted by `detuneCents`, and return how many frames
   * were written. Zero means the region has run out; the caller silences the rest.
   */
  process(output: Float32Array, detuneCents: number): number {
    this.assertLive();
    const frames = Math.min(output.length, this.maxBlock);
    const written = this.exports.streamBlock(this.handle, this.outPtr, frames, detuneCents);
    for (let i = 0; i < written; i++) output[i] = this.outView[i] as number;
    for (let i = written; i < output.length; i++) output[i] = 0;
    return written;
  }

  /** Free the kernel's linear memory — MUST be called when the node is destroyed (§5.6.3). */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.freeBuffer(this.regionPtr);
    this.exports.freeBuffer(this.outPtr);
    this.exports.free(this.handle);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GranularSourceKernel used after destroy()');
  }
}
