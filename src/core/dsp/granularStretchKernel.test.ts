import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { GranularStretchKernel } from './granularStretchKernel';

const SAMPLE_RATE = 48_000;

function sine(frames: number, hz: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  return out;
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / data.length);
}

/** Dominant frequency by autocorrelation over the steady middle of a signal. */
function detectPitch(data: Float32Array, sampleRate: number): number {
  const mid = data.subarray(Math.floor(data.length * 0.25), Math.floor(data.length * 0.75));
  if (rms(mid) < 1e-3) return 0;
  const minLag = Math.floor(sampleRate / 1200);
  const maxLag = Math.floor(sampleRate / 80);
  // Length-normalised autocorrelation, referenced to the zero-lag energy.
  let energy0 = 0;
  for (let i = 0; i < mid.length; i++) energy0 += mid[i]! * mid[i]!;
  energy0 /= mid.length;
  const corr = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < mid.length - lag; i++) sum += mid[i]! * mid[i + lag]!;
    corr[lag] = sum / (mid.length - lag);
  }
  // The fundamental period is the FIRST local maximum whose correlation reaches at least half
  // the zero-lag energy — avoids the small-lag bias and octave errors toward subharmonics.
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag]! >= 0.5 * energy0 && corr[lag]! >= corr[lag - 1]! && corr[lag]! > corr[lag + 1]!) {
      return sampleRate / lag;
    }
  }
  return 0;
}

let module: WebAssembly.Module;
beforeAll(() => {
  module = loadBuiltKernel('granularStretch');
});

describe('GranularStretchKernel — §5.6.4 / §5.7.9 independent time/pitch over the built wasm', () => {
  it('stretches duration by 1/rate without shifting pitch', () => {
    const input = sine(48_000, 200);
    const kernel = GranularStretchKernel.fromModule(module, SAMPLE_RATE, input.length);

    const slower = kernel.render(input, { rate: 0.5, pitchSemitones: 0 });
    expect(slower.length).toBeCloseTo(input.length * 2, -3); // ≈ 2× longer
    expect(detectPitch(slower, SAMPLE_RATE)).toBeCloseTo(200, -1); // pitch unchanged (~200 Hz)

    const faster = kernel.render(input, { rate: 2, pitchSemitones: 0 });
    expect(faster.length).toBeCloseTo(input.length / 2, -3); // ≈ half as long
    expect(detectPitch(faster, SAMPLE_RATE)).toBeCloseTo(200, -1);
    kernel.destroy();
  });

  it('shifts pitch by an octave without changing duration', () => {
    const input = sine(48_000, 200);
    const kernel = GranularStretchKernel.fromModule(module, SAMPLE_RATE, input.length);

    const up = kernel.render(input, { rate: 1, pitchSemitones: 12 });
    expect(up.length).toBe(input.length); // duration preserved (rate 1)
    expect(detectPitch(up, SAMPLE_RATE)).toBeCloseTo(400, -1.4); // one octave up ≈ 400 Hz

    const down = kernel.render(input, { rate: 1, pitchSemitones: -12 });
    expect(detectPitch(down, SAMPLE_RATE)).toBeCloseTo(100, -1.4); // one octave down ≈ 100 Hz
    kernel.destroy();
  });

  it('is near-identity at rate 1, pitch 0 (same length, same pitch, audible level)', () => {
    const input = sine(24_000, 300);
    const kernel = GranularStretchKernel.fromModule(module, SAMPLE_RATE, input.length);
    const out = kernel.render(input, { rate: 1, pitchSemitones: 0 });
    expect(out.length).toBe(input.length);
    expect(detectPitch(out, SAMPLE_RATE)).toBeCloseTo(300, -1);
    expect(rms(out)).toBeGreaterThan(0.5); // Hann OLA at 50 % preserves level
    kernel.destroy();
  });

  it('is unusable after destroy() (spec §5.6.3)', () => {
    const kernel = GranularStretchKernel.fromModule(module, SAMPLE_RATE, 1000);
    kernel.destroy();
    expect(() => kernel.render(new Float32Array(10), { rate: 1, pitchSemitones: 0 })).toThrow(/after destroy/);
  });
});
