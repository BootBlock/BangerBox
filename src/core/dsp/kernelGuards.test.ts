/**
 * Guards on the §5.6.1 kernel-wrapper seam (issue #97).
 *
 * A kernel wrapper is the last TypeScript before linear memory. An out-of-range parameter
 * reaching an AssemblyScript kernel is not a type error there — it is an `f64` the DSP
 * happily uses, so a NaN release time becomes a NaN coefficient and the kernel outputs NaN
 * for the rest of its life. The policy the wrappers implement is therefore **clamp the
 * value, refuse the structure**: a numeric parameter is clamped into its §5.7 range (a NaN
 * collapsing to the range floor), while a non-integer or out-of-range *structural* argument
 * — a band index, a block size, a sample rate — throws, because there is no sane value to
 * substitute for one of those.
 *
 * The §5.7 bounds each wrapper clamps against are declared beside it rather than imported,
 * so a worklet bundle does not drag `effectParams.ts` (and Zod behind it) into the render
 * thread. `kernelRanges.test.ts` is what stops the two copies drifting apart (spec §13.6).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBuiltKernel } from '@/test/wasmKernel';
import { FdnReverbKernel } from './fdnReverbKernel';
import { GranularSourceKernel, GranularStretchKernel } from './granularStretchKernel';
import { LookaheadLimiterKernel } from './lookaheadLimiterKernel';
import { MultibandCompKernel } from './multibandCompKernel';
import { TransientDetectKernel } from './transientDetectKernel';

let limiterModule: WebAssembly.Module;
let reverbModule: WebAssembly.Module;
let compModule: WebAssembly.Module;
let transientModule: WebAssembly.Module;
let granularModule: WebAssembly.Module;

beforeAll(() => {
  limiterModule = loadBuiltKernel('lookaheadLimiter');
  reverbModule = loadBuiltKernel('fdnReverb');
  compModule = loadBuiltKernel('multibandComp');
  transientModule = loadBuiltKernel('transientDetect');
  granularModule = loadBuiltKernel('granularStretch');
});

/** Ramp a hot signal through a kernel and confirm nothing non-finite comes back. */
function processFinite(kernel: { process(input: Float32Array, output: Float32Array): void }): boolean {
  const input = new Float32Array(256).fill(0.8);
  const output = new Float32Array(256);
  kernel.process(input, output);
  return output.every((value) => Number.isFinite(value));
}

describe('LookaheadLimiterKernel guards its params (spec §5.7, issue #97)', () => {
  it('refuses a non-integer or non-positive block size', () => {
    expect(() => LookaheadLimiterKernel.fromModule(limiterModule, 48_000, 512.5)).toThrow();
    expect(() => LookaheadLimiterKernel.fromModule(limiterModule, 48_000, 0)).toThrow();
    expect(() => LookaheadLimiterKernel.fromModule(limiterModule, Number.NaN, 512)).toThrow();
  });

  it('clamps a NaN ceiling and release rather than passing them into linear memory', () => {
    const kernel = LookaheadLimiterKernel.fromModule(limiterModule, 48_000, 256);
    kernel.setCeiling(Number.NaN);
    kernel.setRelease(Number.NaN);
    expect(processFinite(kernel)).toBe(true);
    kernel.destroy();
  });

  it('clamps a ceiling and release far outside the §5.7 range', () => {
    const kernel = LookaheadLimiterKernel.fromModule(limiterModule, 48_000, 256);
    kernel.setCeiling(1_000);
    kernel.setRelease(-5_000);
    expect(processFinite(kernel)).toBe(true);
    kernel.destroy();
  });
});

describe('FdnReverbKernel guards its params (spec §5.7, issue #97)', () => {
  it('clamps NaN size, damping and pre-delay', () => {
    const kernel = FdnReverbKernel.fromModule(reverbModule, 48_000, 256);
    kernel.setSize(Number.NaN);
    kernel.setDamping(Number.NaN);
    kernel.setPredelay(Number.NaN);
    expect(processFinite(kernel)).toBe(true);
    kernel.destroy();
  });

  it('clamps values far outside the §5.7 ranges', () => {
    const kernel = FdnReverbKernel.fromModule(reverbModule, 48_000, 256);
    kernel.setSize(1e9);
    kernel.setDamping(-42);
    kernel.setPredelay(1e9);
    expect(processFinite(kernel)).toBe(true);
    kernel.destroy();
  });
});

describe('MultibandCompKernel guards its params (spec §5.7, issue #97)', () => {
  it('refuses a band index that is not 0, 1 or 2', () => {
    const kernel = MultibandCompKernel.fromModule(compModule, 48_000, 256);
    const params = { thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 0 };
    expect(() => kernel.setBand(7 as 0, params)).toThrow(/band/i);
    expect(() => kernel.setBand(1.5 as 0, params)).toThrow(/band/i);
    kernel.destroy();
  });

  it('clamps NaN crossovers and band parameters', () => {
    const kernel = MultibandCompKernel.fromModule(compModule, 48_000, 256);
    kernel.setCrossovers(Number.NaN, Number.NaN);
    kernel.setBand(0, {
      thresholdDb: Number.NaN,
      ratio: Number.NaN,
      attackMs: Number.NaN,
      releaseMs: Number.NaN,
      makeupDb: Number.NaN,
    });
    expect(processFinite(kernel)).toBe(true);
    kernel.destroy();
  });
});

describe('TransientDetectKernel guards its inputs (spec §7.5, issue #97)', () => {
  it('refuses a non-integer frame capacity', () => {
    expect(() => TransientDetectKernel.fromModule(transientModule, 48_000, 1024.5)).toThrow();
  });

  it('clamps NaN detection options instead of analysing against them', () => {
    const kernel = TransientDetectKernel.fromModule(transientModule, 48_000, 4_096);
    const samples = new Float32Array(4_096);
    for (let i = 0; i < 400; i++) samples[i] = Math.exp(-i / 80);
    const onsets = kernel.detect(samples, { sensitivity: Number.NaN, minSpacingMs: Number.NaN });
    expect(onsets.every((frame) => Number.isInteger(frame) && frame >= 0)).toBe(true);
    kernel.destroy();
  });
});

describe('granular wrappers guard their params (spec §5.7.9, issue #97)', () => {
  it('clamps a NaN or out-of-range stretch rate rather than rendering nothing', () => {
    const kernel = GranularStretchKernel.fromModule(granularModule, 48_000, 4_096);
    const input = new Float32Array(4_096);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 220 * i) / 48_000);
    const rendered = kernel.render(input, { rate: Number.NaN, pitchSemitones: Number.NaN });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every((value) => Number.isFinite(value))).toBe(true);
    kernel.destroy();
  });

  it('clamps a NaN detune on the streaming source', () => {
    const region = new Float32Array(4_800);
    for (let i = 0; i < region.length; i++) region[i] = Math.sin((2 * Math.PI * 220 * i) / 48_000);
    const kernel = GranularSourceKernel.fromModule(granularModule, 48_000, 128, region, 1);
    const output = new Float32Array(128);
    kernel.process(output, Number.NaN);
    expect(output.every((value) => Number.isFinite(value))).toBe(true);
    kernel.destroy();
  });

  it('refuses a non-integer block size on the streaming source', () => {
    const region = new Float32Array(128);
    expect(() => GranularSourceKernel.fromModule(granularModule, 48_000, 12.5, region, 1)).toThrow();
  });
});
