import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { LookaheadLimiterKernel } from './lookaheadLimiterKernel';

function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]!));
  return max;
}

let module: WebAssembly.Module;
beforeAll(() => {
  module = loadBuiltKernel('lookaheadLimiter');
});

describe('LookaheadLimiterKernel — §5.6.4 / §5.7 brickwall limiter over the built wasm', () => {
  it('reports a non-zero lookahead latency of ~1.5 ms (spec §5.7.3 PDC)', () => {
    const kernel = LookaheadLimiterKernel.fromModule(module, 48_000, 512);
    // 1.5 ms at 48 kHz ≈ 72 samples.
    expect(kernel.latencySamples).toBeGreaterThan(50);
    expect(kernel.latencySamples).toBeLessThan(100);
    kernel.destroy();
  });

  it('holds the output below a −6 dBFS ceiling for a hot input', () => {
    const kernel = LookaheadLimiterKernel.fromModule(module, 48_000, 4096);
    kernel.setCeiling(-6); // ≈ 0.5012 linear
    kernel.setRelease(50);
    const sampleRate = 48_000;
    const input = new Float32Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = 0.9 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    const output = new Float32Array(4096);
    kernel.process(input, output);
    const ceilingLinear = Math.pow(10, -6 / 20);
    // Allow a small floating-point margin over the exact ceiling.
    expect(peak(output)).toBeLessThanOrEqual(ceilingLinear * 1.02);
    // After the lookahead priming it must still pass audible signal (not silence).
    expect(peak(output.subarray(1024))).toBeGreaterThan(0.1);
    kernel.destroy();
  });

  it('passes a quiet signal essentially untouched (delayed by the lookahead)', () => {
    const kernel = LookaheadLimiterKernel.fromModule(module, 48_000, 2048);
    kernel.setCeiling(0);
    const input = new Float32Array(2048);
    for (let i = 0; i < input.length; i++) input[i] = 0.2 * Math.sin((2 * Math.PI * 110 * i) / 48_000);
    const output = new Float32Array(2048);
    kernel.process(input, output);
    // Quiet input never engages the limiter → same peak, just delayed.
    expect(peak(output)).toBeCloseTo(0.2, 2);
    kernel.destroy();
  });

  it('is unusable after destroy() (spec §5.6.3)', () => {
    const kernel = LookaheadLimiterKernel.fromModule(module, 48_000, 64);
    kernel.destroy();
    expect(() => kernel.process(new Float32Array(4), new Float32Array(4))).toThrow(/after destroy/);
  });
});
