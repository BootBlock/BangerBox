/**
 * TypeScript wrapper for the `fdnReverb` WASM kernel (spec §5.6.4 / §5.7). Owns the memory
 * views (via {@link StreamingKernel}) and exposes the reverb's typed params. Outputs the wet
 * signal only; the insert wrapper mixes dry/wet (spec §5.7). Native latency is zero for PDC.
 */
import { StreamingKernel, type StreamingKernelExports } from './kernelBase';

interface FdnReverbExports extends StreamingKernelExports {
  setSize(handle: number, seconds: number): void;
  setDamping(handle: number, amount: number): void;
  setPredelay(handle: number, ms: number): void;
}

/** URL of the built kernel binary (emitted by `npm run build:wasm` — spec §5.6). */
export function fdnReverbWasmUrl(): URL {
  return new URL('./dist/fdnReverb.wasm', import.meta.url);
}

export class FdnReverbKernel extends StreamingKernel<FdnReverbExports> {
  static fromModule(module: WebAssembly.Module, sampleRate: number, maxBlock: number): FdnReverbKernel {
    const { exports, handle, inPtr, outPtr } = StreamingKernel.allocate<FdnReverbExports>(
      module,
      sampleRate,
      maxBlock,
    );
    return new FdnReverbKernel(exports, handle, inPtr, outPtr, maxBlock);
  }

  /** Reverb decay time in seconds (spec §5.7: 0.2–10 s). */
  setSize(seconds: number): void {
    this.assertLive();
    this.exports.setSize(this.handle, seconds);
  }

  /** High-frequency damping, 0..1 (spec §5.7). */
  setDamping(amount: number): void {
    this.assertLive();
    this.exports.setDamping(this.handle, amount);
  }

  /** Pre-delay in ms (spec §5.7: 0–200 ms). */
  setPredelay(ms: number): void {
    this.assertLive();
    this.exports.setPredelay(this.handle, ms);
  }
}
