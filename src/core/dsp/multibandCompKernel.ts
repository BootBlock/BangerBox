/**
 * TypeScript wrapper for the `multibandComp` WASM kernel (spec §5.6.4 / §5.7). Owns the
 * memory views (via {@link StreamingKernel}) and exposes the 3-band compressor's typed params.
 * Native latency is zero (no lookahead), so PDC (spec §5.7.3) reports 0 for this insert.
 */
import { StreamingKernel, type StreamingKernelExports } from './kernelBase';

interface MultibandExports extends StreamingKernelExports {
  setCrossovers(handle: number, lowMid: number, midHigh: number): void;
  setBand(
    handle: number,
    band: number,
    thresholdDb: number,
    ratio: number,
    attackMs: number,
    releaseMs: number,
    makeupDb: number,
  ): void;
}

export type Band = 0 | 1 | 2; // low, mid, high (spec §5.7)

export interface BandParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/** URL of the built kernel binary (emitted by `npm run build:wasm` — spec §5.6). */
export function multibandCompWasmUrl(): URL {
  return new URL('./dist/multibandComp.wasm', import.meta.url);
}

export class MultibandCompKernel extends StreamingKernel<MultibandExports> {
  static fromModule(module: WebAssembly.Module, sampleRate: number, maxBlock: number): MultibandCompKernel {
    const { exports, handle, inPtr, outPtr } = StreamingKernel.allocate<MultibandExports>(
      module,
      sampleRate,
      maxBlock,
    );
    return new MultibandCompKernel(exports, handle, inPtr, outPtr, maxBlock);
  }

  /** Band crossover frequencies in Hz (spec §5.7: 40–500 / 500–8k). */
  setCrossovers(lowMid: number, midHigh: number): void {
    this.assertLive();
    this.exports.setCrossovers(this.handle, lowMid, midHigh);
  }

  /** Per-band compressor parameters (spec §5.7). */
  setBand(band: Band, params: BandParams): void {
    this.assertLive();
    this.exports.setBand(
      this.handle,
      band,
      params.thresholdDb,
      params.ratio,
      params.attackMs,
      params.releaseMs,
      params.makeupDb,
    );
  }
}
