import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { FdnReverbKernel } from './fdnReverbKernel';

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / data.length);
}
function peak(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]!));
  return max;
}

/** Render an impulse through the reverb and return the wet tail. */
function renderImpulse(
  module: WebAssembly.Module,
  configure: (k: FdnReverbKernel) => void,
  frames = 48_000,
): Float32Array {
  const kernel = FdnReverbKernel.fromModule(module, 48_000, frames);
  configure(kernel);
  const input = new Float32Array(frames);
  input[0] = 1;
  const output = new Float32Array(frames);
  kernel.process(input, output);
  kernel.destroy();
  return output;
}

let module: WebAssembly.Module;
beforeAll(() => {
  module = loadBuiltKernel('fdnReverb');
});

describe('FdnReverbKernel — §5.6.4 / §5.7 feedback delay network over the built wasm', () => {
  it('produces a decaying, bounded, finite tail from an impulse', () => {
    const tail = renderImpulse(module, (k) => {
      k.setSize(2);
      k.setDamping(0.3);
      k.setPredelay(0);
    });
    // Non-silent tail…
    const early = rms(tail.subarray(2_000, 10_000));
    const late = rms(tail.subarray(30_000, 40_000));
    expect(early).toBeGreaterThan(1e-4);
    // …that decays over time…
    expect(late).toBeLessThan(early);
    // …and never blows up (stable feedback).
    expect(peak(tail)).toBeLessThan(4);
    for (let i = 0; i < tail.length; i++) expect(Number.isFinite(tail[i]!)).toBe(true);
  });

  it('a larger size sustains more energy late in the tail than a small size', () => {
    const bigTail = renderImpulse(module, (k) => k.setSize(8));
    const smallTail = renderImpulse(module, (k) => k.setSize(0.4));
    const window = (d: Float32Array) => rms(d.subarray(20_000, 30_000));
    expect(window(bigTail)).toBeGreaterThan(window(smallTail));
  });

  it('delays the onset of the tail by the pre-delay', () => {
    const tail = renderImpulse(
      module,
      (k) => {
        k.setSize(2);
        k.setPredelay(100); // 100 ms ≈ 4800 samples at 48 kHz
      },
      12_000,
    );
    // Nothing has arrived before the pre-delay (plus the shortest delay line) elapses.
    expect(peak(tail.subarray(0, 4_000))).toBeLessThan(1e-4);
    expect(rms(tail.subarray(6_000, 12_000))).toBeGreaterThan(1e-4);
  });
});
