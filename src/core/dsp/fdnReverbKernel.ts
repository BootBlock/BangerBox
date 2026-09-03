/**
 * TypeScript wrapper for the `fdnReverb` WASM kernel (spec §5.6.4 / §5.7). Owns the memory
 * views (via {@link StreamingKernel}) and exposes the reverb's typed params. Outputs the wet
 * signal only; the insert wrapper mixes dry/wet (spec §5.7). Native latency is zero for PDC.
 */
import { kernelParam, StreamingKernel, type KernelRange, type StreamingKernelExports } from './kernelBase';

interface FdnReverbExports extends StreamingKernelExports {
  setSize(handle: number, seconds: number): void;
  setDamping(handle: number, amount: number): void;
  setPredelay(handle: number, ms: number): void;
}

/** The §5.7 bounds this wrapper clamps against — see `LIMITER_RANGES` for why they live here. */
export const FDN_REVERB_RANGES = {
  size: [0.2, 10] as KernelRange,
  damping: [0, 1] as KernelRange,
  predelay: [0, 200] as KernelRange,
};

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

  /** Reverb decay time in seconds (spec §5.7: 0.2–10 s). Clamped in range, else refused. */
  setSize(seconds: number): void {
    this.assertLive();
    const size = kernelParam(seconds, FDN_REVERB_RANGES.size);
    if (size === null) return;
    this.exports.setSize(this.handle, size);
  }

  /** High-frequency damping, 0..1 (spec §5.7). Clamped in range, else refused. */
  setDamping(amount: number): void {
    this.assertLive();
    const damping = kernelParam(amount, FDN_REVERB_RANGES.damping);
    if (damping === null) return;
    this.exports.setDamping(this.handle, damping);
  }

  /** Pre-delay in ms (spec §5.7: 0–200 ms). Clamped in range, else refused. */
  setPredelay(ms: number): void {
    this.assertLive();
    const predelay = kernelParam(ms, FDN_REVERB_RANGES.predelay);
    if (predelay === null) return;
    this.exports.setPredelay(this.handle, predelay);
  }
}
