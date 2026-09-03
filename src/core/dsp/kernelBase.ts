/**
 * Shared kernel-wrapper base (spec §5.6.1) — the common memory-view plumbing every streaming
 * WASM kernel wrapper needs: an owned handle, pre-allocated in/out linear-memory buffers, and
 * Float32 views created once after all allocations (a later `heap.alloc` growth can no longer
 * detach them, and `process()` allocates nothing — spec §5.5, §5.6.3). Concrete wrappers
 * (limiter, multiband, reverb, …) extend this and add their typed param setters, so the kernel
 * seam stays uniform and the implementation language remains swappable (§1.3 #5).
 *
 * A wrapper is the last TypeScript before linear memory, so it is where §5.7 ranges are
 * enforced (issue #97). An out-of-range `f64` is not an error inside an AssemblyScript kernel
 * — it is a coefficient, so a NaN release time becomes a NaN state variable and the kernel
 * outputs NaN for the rest of its life, silencing every node downstream. The policy is
 * therefore **clamp the value, refuse the structure**: {@link clampKernelParam} coerces a
 * numeric parameter into its declared range, while a bad block size, sample rate or band index
 * throws, because there is no defensible value to substitute for one of those.
 */

/** A kernel parameter's inclusive bounds, mirroring the §5.7 table (see `kernelRanges.test.ts`). */
export type KernelRange = readonly [min: number, max: number];

/**
 * Coerce a §5.7 parameter into its declared range before it crosses into linear memory
 * (issue #97). A non-finite value collapses to the range floor, which for every parameter
 * these wrappers expose is the quietest, least destructive end of its travel.
 */
export function clampKernelParam(value: number, [min, max]: KernelRange): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Reject a structural argument that has no sane substitute (issue #97). */
export function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/** Reject a sample rate that would make every kernel coefficient meaningless (issue #97). */
export function assertSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`kernel sampleRate must be finite and positive, got ${sampleRate}`);
  }
  return sampleRate;
}

/** The lifecycle exports every streaming kernel module shares (spec §5.6.1). */
export interface StreamingKernelExports {
  memory: WebAssembly.Memory;
  create(sampleRate: number, maxBlock: number): number;
  allocateBuffer(frames: number): number;
  freeBuffer(ptr: number): void;
  process(handle: number, inPtr: number, outPtr: number, frames: number): void;
  free(handle: number): void;
}

export abstract class StreamingKernel<TExports extends StreamingKernelExports> {
  private disposed = false;
  private readonly inView: Float32Array;
  private readonly outView: Float32Array;

  protected constructor(
    protected readonly exports: TExports,
    protected readonly handle: number,
    private readonly inPtr: number,
    private readonly outPtr: number,
    private readonly maxBlock: number,
  ) {
    this.inView = new Float32Array(exports.memory.buffer, inPtr, maxBlock);
    this.outView = new Float32Array(exports.memory.buffer, outPtr, maxBlock);
  }

  /** Allocate the handle + I/O buffers for a precompiled module (spec §5.6.2 constructor path). */
  protected static allocate<TExports extends StreamingKernelExports>(
    module: WebAssembly.Module,
    sampleRate: number,
    maxBlock: number,
  ): { exports: TExports; handle: number; inPtr: number; outPtr: number } {
    assertSampleRate(sampleRate);
    assertPositiveInteger('kernel maxBlock', maxBlock);
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as TExports;
    const handle = exports.create(sampleRate, maxBlock);
    const inPtr = exports.allocateBuffer(maxBlock);
    const outPtr = exports.allocateBuffer(maxBlock);
    return { exports, handle, inPtr, outPtr };
  }

  /** Process `input` into `output` through the kernel; copies use index loops (no allocation). */
  process(input: Float32Array, output: Float32Array): void {
    this.assertLive();
    const frames = Math.min(input.length, output.length, this.maxBlock);
    for (let i = 0; i < frames; i++) this.inView[i] = input[i] as number;
    this.exports.process(this.handle, this.inPtr, this.outPtr, frames);
    for (let i = 0; i < frames; i++) output[i] = this.outView[i] as number;
  }

  /** Free all kernel linear memory — MUST be called when the owner is destroyed (spec §5.6.3). */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.freeBuffer(this.inPtr);
    this.exports.freeBuffer(this.outPtr);
    this.exports.free(this.handle);
  }

  protected assertLive(): void {
    if (this.disposed) throw new Error(`${this.constructor.name} used after destroy()`);
  }
}
