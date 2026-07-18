import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { slicesFromOnsets } from '@/core/audio/chop';
import { TransientDetectKernel } from './transientDetectKernel';

const SAMPLE_RATE = 48_000;

/**
 * Synthesise a drum-like fixture: sharp-attack, exponentially-decaying bursts of a tone at the
 * given frame positions — the transient-chop accuracy fixture (spec §12 exit, §8.5.4).
 */
function drumFixture(length: number, onsets: readonly number[]): Float32Array {
  const signal = new Float32Array(length);
  for (const onset of onsets) {
    const burst = 2400; // 50 ms
    for (let i = 0; i < burst && onset + i < length; i++) {
      const decay = Math.exp(-i / 400);
      signal[onset + i] = 0.9 * decay * Math.sin((2 * Math.PI * 180 * i) / SAMPLE_RATE);
    }
  }
  return signal;
}

/** Nearest detected onset to a target, or Infinity distance if none within reach. */
function nearestDistance(detected: readonly number[], target: number): number {
  let best = Infinity;
  for (const d of detected) best = Math.min(best, Math.abs(d - target));
  return best;
}

let module: WebAssembly.Module;
beforeAll(() => {
  module = loadBuiltKernel('transientDetect');
});

describe('TransientDetectKernel — §5.6.4 / §7.5 onset detection over the built wasm', () => {
  it('detects transients at their true positions within one analysis hop (accuracy fixture)', () => {
    const truth = [4_000, 14_000, 24_000, 36_000];
    const signal = drumFixture(48_000, truth);
    const kernel = TransientDetectKernel.fromModule(module, SAMPLE_RATE, signal.length);
    const detected = kernel.detect(signal, { sensitivity: 0.6, minSpacingMs: 40 });
    kernel.destroy();

    expect(detected.length).toBe(truth.length);
    for (const position of truth) {
      // Position is refined to the sharpest transition → within a few ms of the true attack.
      expect(nearestDistance(detected, position)).toBeLessThanOrEqual(200);
    }
  });

  it('feeds Chop: detected onsets slice the sample into one region per transient', () => {
    const truth = [6_000, 18_000, 30_000];
    const signal = drumFixture(40_000, truth);
    const kernel = TransientDetectKernel.fromModule(module, SAMPLE_RATE, signal.length);
    const detected = kernel.detect(signal, { sensitivity: 0.6, minSpacingMs: 40 });
    kernel.destroy();
    // One region per transient (regions start at each onset; the lead-in is dropped).
    const slices = slicesFromOnsets(signal.length, detected);
    expect(slices.length).toBe(truth.length);
    expect(slices[0]!.startFrame).toBe(detected[0]);
    expect(slices[slices.length - 1]!.endFrame).toBe(signal.length);
  });

  it('respects the minimum spacing, merging closely-packed transients', () => {
    const signal = drumFixture(48_000, [10_000, 10_500, 30_000]); // first two ~10 ms apart
    const kernel = TransientDetectKernel.fromModule(module, SAMPLE_RATE, signal.length);
    const detected = kernel.detect(signal, { sensitivity: 0.7, minSpacingMs: 100 });
    kernel.destroy();
    // 100 ms spacing collapses the close pair into one onset → two total.
    expect(detected.length).toBe(2);
  });

  it('finds nothing in silence', () => {
    const kernel = TransientDetectKernel.fromModule(module, SAMPLE_RATE, 20_000);
    const detected = kernel.detect(new Float32Array(20_000));
    kernel.destroy();
    expect(detected).toEqual([]);
  });
});
