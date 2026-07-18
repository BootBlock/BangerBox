/**
 * TypeScript wrapper for the `lookaheadLimiter` WASM kernel (spec §5.6.4 / §5.7). Owns the
 * memory views (via {@link StreamingKernel}) and exposes the limiter's typed params; its
 * reported {@link latencySamples} feeds plugin-delay compensation (spec §5.7.3).
 */
import { StreamingKernel, type StreamingKernelExports } from './kernelBase';

interface LimiterExports extends StreamingKernelExports {
  setCeiling(handle: number, dbfs: number): void;
  setRelease(handle: number, releaseMs: number): void;
  latencySamples(handle: number): number;
}

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

  static fromModule(module: WebAssembly.Module, sampleRate: number, maxBlock: number): LookaheadLimiterKernel {
    const { exports, handle, inPtr, outPtr } = StreamingKernel.allocate<LimiterExports>(
      module,
      sampleRate,
      maxBlock,
    );
    return new LookaheadLimiterKernel(exports, handle, inPtr, outPtr, maxBlock);
  }

  /** Output ceiling in dBFS (spec §5.7: −6..0). */
  setCeiling(dbfs: number): void {
    this.assertLive();
    this.exports.setCeiling(this.handle, dbfs);
  }

  /** Release time in ms (spec §5.7: 10..500). */
  setRelease(releaseMs: number): void {
    this.assertLive();
    this.exports.setRelease(this.handle, releaseMs);
  }
}
