/**
 * Voice modulation mapping — spec §6. Pure helpers that translate the §6 sound-design
 * model into the physical quantities the Web Audio nodes need: LFO oscillator shapes,
 * biquad filter type, and the voice-start static modulation offsets derived from the mod
 * matrix (spec §6 control-rate evaluation). The full-scale modulation depths are an
 * implementation choice (spec §6 does not fix them); they are named here so call sites
 * never carry magic numbers and a later tuning pass changes one place.
 */
import type { LfoConfig, ModRoute, PadFilter } from '@/core/project/schemas';
import { evaluateModMatrix, type ModSourceValues } from './modMatrix';

/** Full-scale pitch modulation in cents at mod amount ±1 (±1 octave) — spec §6. */
export const PITCH_MOD_CENTS = 1200;
/** Full-scale filter-cutoff modulation in octaves at mod amount ±1 — spec §6. */
export const FILTER_MOD_OCTAVES = 4;
/** Full-scale filter envelope excursion in octaves at envDepth ±1 (spec §6). */
export const FILTER_ENV_OCTAVES = 4;

/** Native oscillator type + sign for a §6 LFO shape (sampleHold/drift approximated). */
export interface LfoOscillator {
  readonly type: OscillatorType;
  /** −1 inverts the oscillator via a negative gain (e.g. sawDown from a sawtooth). */
  readonly sign: 1 | -1;
}

/**
 * Map a §6 LFO shape to a native `OscillatorNode` type. sampleHold and drift have no
 * native oscillator (they want a worklet); they are approximated here (square / sine)
 * so LFOs are audible in v1 — a true random-hold LFO is a later worklet refinement.
 */
export function lfoOscillator(shape: LfoConfig['shape']): LfoOscillator {
  switch (shape) {
    case 'sine':
      return { type: 'sine', sign: 1 };
    case 'triangle':
      return { type: 'triangle', sign: 1 };
    case 'sawUp':
      return { type: 'sawtooth', sign: 1 };
    case 'sawDown':
      return { type: 'sawtooth', sign: -1 };
    case 'square':
      return { type: 'square', sign: 1 };
    case 'sampleHold':
      return { type: 'square', sign: 1 }; // approximation (spec §6; worklet upgrade later)
    case 'drift':
      return { type: 'sine', sign: 1 }; // approximation (spec §6; worklet upgrade later)
  }
}

/** Map the §6 pad filter type to a native `BiquadFilterType`, or null when off (spec §6). */
export function biquadFilterType(type: PadFilter['type']): BiquadFilterType | null {
  switch (type) {
    case 'lp':
      return 'lowpass';
    case 'hp':
      return 'highpass';
    case 'bp':
      return 'bandpass';
    case 'off':
      return null;
  }
}

/** The mod-matrix source values for a hit with no LFO/envelope contribution (voice start). */
export function staticSourceValues(note: number, velocity: number, random: number): ModSourceValues {
  return {
    lfo1: 0,
    lfo2: 0,
    ampEnv: 0,
    pitchEnv: 0,
    filterEnv: 0,
    velocity: Math.min(127, Math.max(0, velocity)) / 127,
    random,
    noteNumber: Math.min(127, Math.max(0, note)) / 127,
  };
}

/** Voice-start static modulation offsets (spec §6): applied once when the voice sounds. */
export interface StaticModulation {
  /** Additive detune offset in cents (pitch target). */
  readonly detuneCents: number;
  /** Multiplicative cutoff factor (filterCutoff target); 1 = unchanged. */
  readonly cutoffFactor: number;
  /** Multiplicative amp factor (amp target); 1 = unchanged, clamped ≥ 0. */
  readonly ampFactor: number;
}

/**
 * Evaluate the static (non-LFO, non-envelope) mod-matrix contribution at voice start
 * from velocity, note number and per-note random (spec §6). LFO-sourced routes are wired
 * as live oscillators instead (see the voice pool); envelope-sourced routes to non-hard-
 * wired targets are a later refinement — the built-in pitch/filter envelopes carry the
 * primary envelope modulation in v1.
 */
export function staticModulation(
  routes: readonly ModRoute[],
  note: number,
  velocity: number,
  random: number,
): StaticModulation {
  const result = evaluateModMatrix(routes, staticSourceValues(note, velocity, random));
  const pitch = result.get('pitch') ?? 0;
  const cutoff = result.get('filterCutoff') ?? 0;
  const amp = result.get('amp') ?? 0;
  return {
    detuneCents: pitch * PITCH_MOD_CENTS,
    cutoffFactor: 2 ** (cutoff * FILTER_MOD_OCTAVES),
    ampFactor: Math.max(0, 1 + amp),
  };
}
