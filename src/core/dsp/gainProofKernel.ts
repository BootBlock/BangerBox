/**
 * TypeScript wrapper for the `gainProof` WASM kernel — the Phase 0 exemplar of the
 * kernel seam (spec §5.6.1): the wrapper owns memory views and hides pointers from
 * consumers, so the implementation language stays swappable (§1.3 #5).
 */

/** The exact export surface of the compiled gainProof.wasm module (spec §5.6.1). */
interface GainProofExports {
  memory: WebAssembly.Memory;
  create(sampleRate: number, maxBlock: number): number;
  setGain(handle: number, gain: number): void;
  allocateBuffer(frames: number): number;
  freeBuffer(ptr: number): void;
  process(handle: number, inPtr: number, outPtr: number, frames: number): void;
  free(handle: number): void;
}

/** The proof message the gain-proof worklet posts after its construction-time render. */
export interface GainProofResultMessage {
  kind: 'proofResult';
  input: number[];
  output: number[];
}

/** Message asking the worklet to free its kernel memory before disconnect (spec §5.6.3). */
export interface KernelDisposeMessage {
  kind: 'dispose';
}

export class GainProofKernel {
  private disposed = false;

  private constructor(
    private readonly exports: GainProofExports,
    private readonly handle: number,
    private readonly inPtr: number,
    private readonly outPtr: number,
    private readonly maxBlock: number,
    private readonly inView: Float32Array,
    private readonly outView: Float32Array,
  ) {}

  /**
   * Instantiate from a precompiled module — synchronous, so it is callable from an
   * AudioWorkletProcessor constructor after the module arrives via processorOptions
   * (spec §5.6.2). Each instantiation gets its own linear memory (§5.6.3).
   */
  static fromModule(module: WebAssembly.Module, sampleRate: number, maxBlock: number): GainProofKernel {
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports as unknown as GainProofExports;
    const handle = exports.create(sampleRate, maxBlock);
    const inPtr = exports.allocateBuffer(maxBlock);
    const outPtr = exports.allocateBuffer(maxBlock);
    // Views are created once, after ALL allocations, so a heap.alloc-triggered memory
    // growth can no longer detach them (no allocation happens in process — §5.5).
    const inView = new Float32Array(exports.memory.buffer, inPtr, maxBlock);
    const outView = new Float32Array(exports.memory.buffer, outPtr, maxBlock);
    return new GainProofKernel(exports, handle, inPtr, outPtr, maxBlock, inView, outView);
  }

  setGain(gain: number): void {
    this.assertLive();
    this.exports.setGain(this.handle, gain);
  }

  /**
   * Process `input` through the kernel into `output`. Copies use index loops, not
   * subarray views, so the render quantum allocates nothing (spec §5.5).
   */
  process(input: Float32Array, output: Float32Array): void {
    this.assertLive();
    const frames = Math.min(input.length, output.length, this.maxBlock);
    for (let i = 0; i < frames; i++) this.inView[i] = input[i] as number;
    this.exports.process(this.handle, this.inPtr, this.outPtr, frames);
    for (let i = 0; i < frames; i++) output[i] = this.outView[i] as number;
  }

  /** Free all kernel linear memory — MUST be called when the owner is destroyed (§5.6.3). */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.exports.freeBuffer(this.inPtr);
    this.exports.freeBuffer(this.outPtr);
    this.exports.free(this.handle);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GainProofKernel used after destroy()');
  }
}
