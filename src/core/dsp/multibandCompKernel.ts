/**
 * TypeScript wrapper for the `multibandComp` WASM kernel (spec §5.6.4 / §5.7). Owns the
 * memory views (via {@link StreamingKernel}) and exposes the 3-band compressor's typed params.
 * Native latency is zero (no lookahead), so PDC (spec §5.7.3) reports 0 for this insert.
 */
import {
  clampKernelParam,
  StreamingKernel,
  type KernelRange,
  type StreamingKernelExports,
} from './kernelBase';

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

/**
 * The §5.7 bounds this wrapper clamps against — see `LIMITER_RANGES` for why they live here.
 * The three bands share one set, which is what the §5.7 table declares for all of them.
 */
export const MULTIBAND_RANGES = {
  crossoverLowMid: [40, 500] as KernelRange,
  crossoverMidHigh: [500, 8_000] as KernelRange,
  threshold: [-60, 0] as KernelRange,
  ratio: [1, 20] as KernelRange,
  attack: [0.1, 100] as KernelRange,
  release: [10, 1_000] as KernelRange,
  makeup: [0, 24] as KernelRange,
};

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

  /** Band crossover frequencies in Hz (spec §5.7: 40–500 / 500–8k), clamped (issue #97). */
  setCrossovers(lowMid: number, midHigh: number): void {
    this.assertLive();
    this.exports.setCrossovers(
      this.handle,
      clampKernelParam(lowMid, MULTIBAND_RANGES.crossoverLowMid),
      clampKernelParam(midHigh, MULTIBAND_RANGES.crossoverMidHigh),
    );
  }

  /**
   * Per-band compressor parameters (spec §5.7). The values are clamped; the band index is
   * REFUSED, because writing band 7 of a three-band kernel is a caller bug with no defensible
   * band to substitute — and inside linear memory it is an out-of-bounds write (issue #97).
   */
  setBand(band: Band, params: BandParams): void {
    this.assertLive();
    if (band !== 0 && band !== 1 && band !== 2) {
      throw new Error(`MultibandCompKernel: band must be 0, 1 or 2, got ${band}`);
    }
    this.exports.setBand(
      this.handle,
      band,
      clampKernelParam(params.thresholdDb, MULTIBAND_RANGES.threshold),
      clampKernelParam(params.ratio, MULTIBAND_RANGES.ratio),
      clampKernelParam(params.attackMs, MULTIBAND_RANGES.attack),
      clampKernelParam(params.releaseMs, MULTIBAND_RANGES.release),
      clampKernelParam(params.makeupDb, MULTIBAND_RANGES.makeup),
    );
  }
}
