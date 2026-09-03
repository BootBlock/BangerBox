/**
 * LFO rate and phase maths (spec §6 `LfoConfig`). Both were persisted and applied nowhere
 * before this: a synced LFO ran at its free Hz rate and drifted against the sequence, and
 * `phaseOffset` reached no oscillator at all (issue #107).
 *
 * The coefficient tests reconstruct the wave from its series and compare it against the
 * ideal shape, so a wrong harmonic or a wrong rotation is caught without a Web Audio
 * context. Whether the browser renders `createPeriodicWave` in this basis is a separate
 * question the §11.2 render `lfoPhaseOffsetShiftsWave` answers in a real browser.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultLfo, type LfoConfig } from '@/core/project/schemas';
import { lfoRateHz, lfoWaveCoefficients } from './voiceModulation';

function lfo(patch: Partial<LfoConfig>): LfoConfig {
  return { ...createDefaultLfo(), ...patch };
}

/** Sum the series back into a waveform value at `phase` turns. */
function reconstruct(real: Float32Array, imag: Float32Array, phase: number): number {
  let value = 0;
  for (let k = 1; k < real.length; k++) {
    value += real[k]! * Math.cos(2 * Math.PI * k * phase) + imag[k]! * Math.sin(2 * Math.PI * k * phase);
  }
  return value;
}

describe('lfoRateHz (spec §6 LfoConfig.sync)', () => {
  it('uses the free-running rate when sync is off', () => {
    expect(lfoRateHz(lfo({ sync: 'free', rate: 3.5 }), 120)).toBe(3.5);
  });

  it('runs one cycle per note division at the transport tempo', () => {
    // At 120 bpm a quarter note is 0.5 s, so a 1/4-synced LFO runs at 2 Hz.
    expect(lfoRateHz(lfo({ sync: '1/4', rate: 3.5 }), 120)).toBeCloseTo(2, 9);
    expect(lfoRateHz(lfo({ sync: '1/8' }), 120)).toBeCloseTo(4, 9);
    expect(lfoRateHz(lfo({ sync: '1/1' }), 120)).toBeCloseTo(0.5, 9);
  });

  it('halves with the tempo, so the LFO stays locked to the bar', () => {
    expect(lfoRateHz(lfo({ sync: '1/4' }), 60)).toBeCloseTo(1, 9);
    expect(lfoRateHz(lfo({ sync: '1/4' }), 240)).toBeCloseTo(4, 9);
  });

  it('follows dotted and triplet divisions', () => {
    // A dotted eighth is 1.5 eighths: 0.375 s at 120 bpm.
    expect(lfoRateHz(lfo({ sync: '1/8.' }), 120)).toBeCloseTo(1 / 0.375, 9);
    // An eighth triplet is two thirds of an eighth: 1/6 s at 120 bpm.
    expect(lfoRateHz(lfo({ sync: '1/8T' }), 120)).toBeCloseTo(6, 9);
  });
});

describe('lfoWaveCoefficients (spec §6 LfoConfig.phaseOffset)', () => {
  it('reproduces a sine from phase zero', () => {
    const { real, imag } = lfoWaveCoefficients('sine', 0);
    for (const phase of [0, 0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(reconstruct(real, imag, phase)).toBeCloseTo(Math.sin(2 * Math.PI * phase), 6);
    }
  });

  it('reproduces the square, sawtooth and triangle shapes the engine models', () => {
    // Sampled away from the discontinuities, where a truncated series rings (Gibbs).
    const square = lfoWaveCoefficients('square', 0);
    expect(reconstruct(square.real, square.imag, 0.25)).toBeCloseTo(1, 1);
    expect(reconstruct(square.real, square.imag, 0.75)).toBeCloseTo(-1, 1);

    const saw = lfoWaveCoefficients('sawtooth', 0);
    expect(reconstruct(saw.real, saw.imag, 0.25)).toBeCloseTo(0.5, 1);
    expect(reconstruct(saw.real, saw.imag, 0.75)).toBeCloseTo(-0.5, 1);

    // A truncated series reaches ~0.6 % under the triangle's corner; the browser
    // normalises the wave's peak to 1 when it builds it, so the rendered depth is exact.
    const triangle = lfoWaveCoefficients('triangle', 0);
    expect(reconstruct(triangle.real, triangle.imag, 0.25)).toBeCloseTo(1, 1);
    expect(reconstruct(triangle.real, triangle.imag, 0.75)).toBeCloseTo(-1, 1);
    expect(reconstruct(triangle.real, triangle.imag, 0)).toBeCloseTo(0, 6);
  });

  it('advances the wave by the phase offset', () => {
    const shifted = lfoWaveCoefficients('sine', 0.25);
    // A quarter turn earlier in the cycle: the wave now starts at its peak.
    expect(reconstruct(shifted.real, shifted.imag, 0)).toBeCloseTo(1, 6);
    expect(reconstruct(shifted.real, shifted.imag, 0.25)).toBeCloseTo(0, 6);
  });

  it('shifts every shape by the same rule, not only the sine', () => {
    for (const type of ['sine', 'triangle', 'sawtooth', 'square'] as const) {
      const base = lfoWaveCoefficients(type, 0);
      const shifted = lfoWaveCoefficients(type, 0.3);
      for (const phase of [0.05, 0.15, 0.42, 0.68]) {
        expect(reconstruct(shifted.real, shifted.imag, phase), `${type} at ${phase}`).toBeCloseTo(
          reconstruct(base.real, base.imag, phase + 0.3),
          6,
        );
      }
    }
  });

  it('leaves a whole-turn offset indistinguishable from none', () => {
    const none = lfoWaveCoefficients('triangle', 0);
    const whole = lfoWaveCoefficients('triangle', 1);
    for (let k = 0; k < none.imag.length; k++) {
      expect(whole.real[k]).toBeCloseTo(none.real[k]!, 6);
      expect(whole.imag[k]).toBeCloseTo(none.imag[k]!, 6);
    }
  });
});
