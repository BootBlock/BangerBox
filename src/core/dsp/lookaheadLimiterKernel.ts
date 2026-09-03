/**
 * TypeScript wrapper for the `lookaheadLimiter` WASM kernel (spec §5.6.4 / §5.7). Owns the
 * memory views (via {@link StreamingKernel}) and exposes the limiter's typed params; its
 * reported {@link latencySamples} feeds plugin-delay compensation (spec §5.7.3).
 */
import { kernelParam, StreamingKernel, type KernelRange, type StreamingKernelExports } from './kernelBase';

interface LimiterExports extends StreamingKernelExports {
  setCeiling(handle: number, dbfs: number): void;
  setRelease(handle: number, releaseMs: number): void;
  latencySamples(handle: number): number;
}

/**
 * The §5.7 bounds this wrapper clamps against (issue #97). Declared here rather than imported
 * from `effectParams.ts`, because this module is loaded inside the DSP-effect worklet (§5.6.2)
 * and importing the effect table there would drag `@/core/project/schemas` — and Zod behind it
 * — into the render thread. `kernelRanges.test.ts` is what stops the two copies drifting.
 */
export const LIMITER_RANGES = {
  ceiling: [-6, 0] as KernelRange,
  release: [10, 500] as KernelRange,
};

/** URL of the built kernel binary (emitted by `npm run build:wasm` — spec §5.6). */
export function lookaheadLimiterWasmUrl(): URL {
  return new URL('./dist/lookaheadLimiter.wasm', import.meta.url);
}

export class LookaheadLimiterKernel extends StreamingKernel<LimiterExports> {
  /** Fixed lookahead in samples — reported as latency for PDC (spec §5.7.3). */
  readonly latencySamples: number;

  private constructor(
    exports: LimiterExports,
    handle: number,
    inPtr: number,
    outPtr: number,
    maxBlock: number,
  ) {
    super(exports, handle, inPtr, outPtr, maxBlock);
    this.latencySamples = exports.latencySamples(handle);
  }

  static fromModule(
    module: WebAssembly.Module,
    sampleRate: number,
    maxBlock: number,
  ): LookaheadLimiterKernel {
    const { exports, handle, inPtr, outPtr } = StreamingKernel.allocate<LimiterExports>(
      module,
      sampleRate,
      maxBlock,
    );
    return new LookaheadLimiterKernel(exports, handle, inPtr, outPtr, maxBlock);
  }

  /** Output ceiling in dBFS (spec §5.7: −6..0). Clamped in range, refused if not a number. */
  setCeiling(dbfs: number): void {
    this.assertLive();
    const ceiling = kernelParam(dbfs, LIMITER_RANGES.ceiling);
    if (ceiling === null) return;
    this.exports.setCeiling(this.handle, ceiling);
  }

  /** Release time in ms (spec §5.7: 10..500). Clamped in range, refused if not a number. */
  setRelease(releaseMs: number): void {
    this.assertLive();
    const release = kernelParam(releaseMs, LIMITER_RANGES.release);
    if (release === null) return;
    this.exports.setRelease(this.handle, release);
  }
}
