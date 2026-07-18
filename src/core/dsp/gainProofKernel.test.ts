import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { GainProofKernel } from './gainProofKernel';

let module: WebAssembly.Module;

beforeAll(() => {
  module = loadBuiltKernel('gainProof');
});

describe('GainProofKernel — §5.6.1 kernel seam over the built wasm artefact', () => {
  it('applies the configured gain to a block of samples', () => {
    const kernel = GainProofKernel.fromModule(module, 48_000, 128);
    kernel.setGain(0.5);
    const input = Float32Array.from({ length: 8 }, (_, i) => (i + 1) / 8);
    const output = new Float32Array(8);
    kernel.process(input, output);
    for (let i = 0; i < input.length; i++) {
      expect(output[i]).toBeCloseTo((input[i] as number) * 0.5, 6);
    }
    kernel.destroy();
  });

  it('defaults to unity gain from create()', () => {
    const kernel = GainProofKernel.fromModule(module, 48_000, 128);
    const input = Float32Array.from([0.25, -0.75, 1]);
    const output = new Float32Array(3);
    kernel.process(input, output);
    expect(Array.from(output)).toEqual([0.25, -0.75, 1]);
    kernel.destroy();
  });

  it('clamps processing to maxBlock frames', () => {
    const kernel = GainProofKernel.fromModule(module, 48_000, 4);
    const input = Float32Array.from([1, 1, 1, 1, 1, 1]);
    const output = new Float32Array(6);
    kernel.process(input, output);
    expect(Array.from(output)).toEqual([1, 1, 1, 1, 0, 0]);
    kernel.destroy();
  });

  it('destroy() is idempotent and further use throws (spec §5.6.3 memory rules)', () => {
    const kernel = GainProofKernel.fromModule(module, 48_000, 16);
    kernel.destroy();
    kernel.destroy();
    expect(() => kernel.process(new Float32Array(4), new Float32Array(4))).toThrow(/after destroy/);
  });

  it('each instantiation gets its own linear memory (spec §5.6.3)', () => {
    const first = GainProofKernel.fromModule(module, 48_000, 8);
    const second = GainProofKernel.fromModule(module, 48_000, 8);
    first.setGain(0.25);
    second.setGain(4);
    const input = Float32Array.from([1]);
    const outFirst = new Float32Array(1);
    const outSecond = new Float32Array(1);
    first.process(input, outFirst);
    second.process(input, outSecond);
    expect(outFirst[0]).toBeCloseTo(0.25, 6);
    expect(outSecond[0]).toBeCloseTo(4, 6);
    first.destroy();
    second.destroy();
  });
});
