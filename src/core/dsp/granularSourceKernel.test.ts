/**
 * The §5.7.9 warp source over the built wasm — the streaming half of `granularStretch`.
 *
 * These assertions are what make warp more than a persisted boolean (issue #84): a warp
 * voice must keep the region's duration while detune moves its pitch, which is exactly the
 * opposite of what `AudioBufferSourceNode.detune` does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { GranularSourceKernel } from './granularStretchKernel';

const SAMPLE_RATE = 48_000;
const BLOCK = 128;

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

/** Dominant frequency of the steady middle of a signal, by zero-crossing rate. */
function detectPitch(data: Float32Array): number {
  const from = Math.floor(data.length * 0.3);
  const to = Math.floor(data.length * 0.7);
  const mid = data.subarray(from, to);
  if (rms(mid) < 1e-3) return 0;
  let crossings = 0;
  for (let i = 1; i < mid.length; i++) {
    if (mid[i - 1]! <= 0 && mid[i]! > 0) crossings++;
  }
  return (crossings * SAMPLE_RATE) / mid.length;
}

/** Drain the whole stream into one array, block by block, as the worklet does. */
function drain(kernel: GranularSourceKernel, detuneCents = 0): Float32Array {
  const out: number[] = [];
  const block = new Float32Array(BLOCK);
  for (let guard = 0; guard < 20_000; guard++) {
    const written = kernel.process(block, detuneCents);
    if (written === 0) break;
    for (let i = 0; i < written; i++) out.push(block[i]!);
  }
  return Float32Array.from(out);
}

let module: WebAssembly.Module;
beforeAll(() => {
  module = loadBuiltKernel('granularStretch');
});

describe('GranularSourceKernel — the §5.7.9 warp source', () => {
  it('reports and produces the region length at rate 1', () => {
    const input = sine(24_000, 300);
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    expect(kernel.totalFrames).toBe(input.length);
    expect(drain(kernel)).toHaveLength(input.length);
    kernel.destroy();
  });

  it('passes the region through unchanged at rate 1 with no detune', () => {
    const input = sine(24_000, 300);
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    const out = drain(kernel);
    // Hann grains at 50 % overlap sum to unity, so warp with nothing to do is a passthrough.
    let worst = 0;
    for (let i = 0; i < out.length - 1; i++) worst = Math.max(worst, Math.abs(out[i]! - input[i]!));
    expect(worst).toBeLessThan(0.02);
    kernel.destroy();
  });

  it('shifts pitch by an octave WITHOUT changing the duration (spec §5.7.9)', () => {
    const input = sine(24_000, 300);
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    const up = drain(kernel, 1200);
    // The whole point of warp: an octave up, same length. A plain playback-rate repitch
    // would have halved the length instead.
    expect(up).toHaveLength(input.length);
    expect(detectPitch(up)).toBeGreaterThan(520);
    expect(detectPitch(up)).toBeLessThan(680);
    kernel.destroy();

    const down = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    const lowered = drain(down, -1200);
    expect(lowered).toHaveLength(input.length);
    expect(detectPitch(lowered)).toBeGreaterThan(120);
    expect(detectPitch(lowered)).toBeLessThan(180);
    down.destroy();
  });

  it('stretches duration by 1/rate without shifting pitch', () => {
    const input = sine(24_000, 300);
    const slower = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 0.5);
    expect(slower.totalFrames).toBe(input.length * 2);
    const out = drain(slower);
    expect(out).toHaveLength(input.length * 2);
    expect(detectPitch(out)).toBeGreaterThan(270);
    expect(detectPitch(out)).toBeLessThan(330);
    slower.destroy();
  });

  it('keeps an audible level throughout, including the first block', () => {
    const input = sine(24_000, 300);
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    const out = drain(kernel);
    // The first grain is flat over its rising half, so the attack is not faded in.
    expect(rms(out.subarray(0, BLOCK))).toBeGreaterThan(0.5);
    expect(rms(out)).toBeGreaterThan(0.5);
    kernel.destroy();
  });

  it('returns zero once the region has run out, and never over-runs', () => {
    const input = sine(4_000, 300);
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    expect(drain(kernel)).toHaveLength(input.length);
    expect(kernel.process(new Float32Array(BLOCK), 0)).toBe(0);
    kernel.destroy();
  });

  it('silences the tail of a partly filled block rather than leaving stale samples', () => {
    const input = sine(BLOCK + 40, 300);
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, input, 1);
    const block = new Float32Array(BLOCK).fill(9);
    kernel.process(block, 0); // full block
    block.fill(9);
    const written = kernel.process(block, 0); // partial final block
    expect(written).toBe(40);
    for (let i = written; i < BLOCK; i++) expect(block[i]).toBe(0);
    kernel.destroy();
  });

  it('is unusable after destroy() (spec §5.6.3)', () => {
    const kernel = GranularSourceKernel.fromModule(module, SAMPLE_RATE, BLOCK, sine(1000, 300), 1);
    kernel.destroy();
    expect(() => kernel.process(new Float32Array(BLOCK), 0)).toThrow(/after destroy/);
  });
});
