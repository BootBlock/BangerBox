import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { MultibandCompKernel } from './multibandCompKernel';

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / data.length);
}

function sine(frames: number, hz: number, amp: number, sampleRate = 48_000): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

const UNITY = { thresholdDb: 0, ratio: 1, attackMs: 10, releaseMs: 100, makeupDb: 0 } as const;

let module: WebAssembly.Module;
beforeAll(() => {
  module = loadBuiltKernel('multibandComp');
});

describe('MultibandCompKernel — §5.6.4 / §5.7 3-band compressor over the built wasm', () => {
  it('is a true passthrough at unity settings (complementary crossovers reconstruct)', () => {
    const kernel = MultibandCompKernel.fromModule(module, 48_000, 2048);
    kernel.setCrossovers(200, 2000);
    for (const band of [0, 1, 2] as const) kernel.setBand(band, UNITY);
    const input = sine(2048, 440, 0.5);
    const output = new Float32Array(2048);
    kernel.process(input, output);
    for (let i = 0; i < input.length; i++) expect(output[i]).toBeCloseTo(input[i]!, 4);
    kernel.destroy();
  });

  it('reduces the level of a band driven above its threshold', () => {
    const kernel = MultibandCompKernel.fromModule(module, 48_000, 4096);
    kernel.setCrossovers(200, 2000);
    // Heavily compress the mid band a 440 Hz tone lands in; leave low/high at unity.
    kernel.setBand(1, { thresholdDb: -30, ratio: 10, attackMs: 1, releaseMs: 50, makeupDb: 0 });
    kernel.setBand(0, UNITY);
    kernel.setBand(2, UNITY);
    const input = sine(4096, 440, 0.8);
    const output = new Float32Array(4096);
    kernel.process(input, output);
    // Measure past the attack transient.
    const inTail = input.subarray(2048);
    const outTail = output.subarray(2048);
    expect(rms(outTail)).toBeLessThan(rms(inTail) * 0.85);
    for (let i = 0; i < output.length; i++) expect(Number.isFinite(output[i]!)).toBe(true);
    kernel.destroy();
  });

  it('leaves a signal below threshold essentially unchanged', () => {
    const kernel = MultibandCompKernel.fromModule(module, 48_000, 2048);
    kernel.setCrossovers(200, 2000);
    for (const band of [0, 1, 2] as const) kernel.setBand(band, { ...UNITY, thresholdDb: -6, ratio: 4 });
    const input = sine(2048, 440, 0.1); // −20 dBFS, below the −6 threshold
    const output = new Float32Array(2048);
    kernel.process(input, output);
    expect(rms(output.subarray(1024))).toBeCloseTo(rms(input.subarray(1024)), 2);
    kernel.destroy();
  });
});
