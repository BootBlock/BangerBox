import { describe, expect, it } from 'vitest';
import type { ModRoute } from '@/core/project/schemas';
import { biquadFilterType, lfoOscillator, staticModulation, staticSourceValues } from './voiceModulation';

describe('lfoOscillator (spec §6 shapes)', () => {
  it('maps native shapes directly', () => {
    expect(lfoOscillator('sine')).toEqual({ type: 'sine', sign: 1 });
    expect(lfoOscillator('triangle')).toEqual({ type: 'triangle', sign: 1 });
    expect(lfoOscillator('sawUp')).toEqual({ type: 'sawtooth', sign: 1 });
    expect(lfoOscillator('square')).toEqual({ type: 'square', sign: 1 });
  });

  it('inverts sawDown via a negative sign', () => {
    expect(lfoOscillator('sawDown')).toEqual({ type: 'sawtooth', sign: -1 });
  });

  it('approximates the non-native shapes', () => {
    expect(lfoOscillator('sampleHold').type).toBe('square');
    expect(lfoOscillator('drift').type).toBe('sine');
  });
});

describe('biquadFilterType (spec §6)', () => {
  it('maps the pad filter types and returns null when off', () => {
    expect(biquadFilterType('lp')).toBe('lowpass');
    expect(biquadFilterType('hp')).toBe('highpass');
    expect(biquadFilterType('bp')).toBe('bandpass');
    expect(biquadFilterType('off')).toBeNull();
  });
});

describe('staticSourceValues (spec §6)', () => {
  it('normalises velocity and note number, passes random through', () => {
    const values = staticSourceValues(127, 127, -0.5);
    expect(values.velocity).toBe(1);
    expect(values.noteNumber).toBe(1);
    expect(values.random).toBe(-0.5);
    expect(values.lfo1).toBe(0);
    expect(values.ampEnv).toBe(0);
  });
});

describe('staticModulation (spec §6 voice-start offsets)', () => {
  it('is neutral with no routes', () => {
    expect(staticModulation([], 60, 100, 0)).toEqual({ detuneCents: 0, cutoffFactor: 1, ampFactor: 1 });
  });

  it('turns a velocity→amp route into an amp factor above unity', () => {
    const routes: ModRoute[] = [{ source: 'velocity', target: 'amp', amount: 0.5 }];
    const { ampFactor } = staticModulation(routes, 60, 127, 0); // velocity 1.0 × 0.5 = +0.5
    expect(ampFactor).toBeCloseTo(1.5);
  });

  it('turns a noteNumber→pitch route into a detune offset in cents', () => {
    const routes: ModRoute[] = [{ source: 'noteNumber', target: 'pitch', amount: 1 }];
    const { detuneCents } = staticModulation(routes, 127, 100, 0); // note 1.0 × 1200
    expect(detuneCents).toBeCloseTo(1200);
  });

  it('turns a filterCutoff route into a multiplicative cutoff factor', () => {
    const routes: ModRoute[] = [{ source: 'velocity', target: 'filterCutoff', amount: 0.25 }];
    const { cutoffFactor } = staticModulation(routes, 60, 127, 0); // 2^(0.25 × 4) = 2
    expect(cutoffFactor).toBeCloseTo(2);
  });

  it('clamps a negative amp modulation to zero', () => {
    const routes: ModRoute[] = [{ source: 'velocity', target: 'amp', amount: -2 }];
    expect(staticModulation(routes, 60, 127, 0).ampFactor).toBe(0);
  });
});
