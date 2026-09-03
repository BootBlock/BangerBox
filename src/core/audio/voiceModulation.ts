/**
 * Voice modulation mapping — spec §6. Pure helpers that translate the §6 sound-design
 * model into the physical quantities the Web Audio nodes need: LFO oscillator shapes,
 * biquad filter type, and the voice-start static modulation offsets derived from the mod
 * matrix (spec §6 control-rate evaluation). The full-scale modulation depths are an
 * implementation choice (spec §6 does not fix them); they are named here so call sites
 * never carry magic numbers and a later tuning pass changes one place.
 */
import type { LfoConfig, ModRoute, PadFilter } from '@/core/project/schemas';
import { noteDivisionSeconds } from '@/core/sequencer/ppqn';
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

/**
 * The LFO's effective rate in Hz (spec §6 `LfoConfig.sync`): its free-running `rate` when
 * `sync` is `'free'`, else one cycle per note division at the transport tempo.
 *
 * The rate is resolved once, at note-on, from the tempo then in force. A live voice keeps
 * the rate it started with: re-rating a running `OscillatorNode` cannot preserve its phase,
 * and the §5.4 declick integrates the pitch-LFO rate curve to find where the buffer runs
 * out, so a mid-note re-rate would move a fade that is already scheduled. §10.5 keeps tempo
 * automation out of v1, so the only way to reach that case is editing the BPM field with a
 * note still sounding — and every note struck after the edit is in time.
 */
export function lfoRateHz(config: LfoConfig, bpm: number): number {
  if (config.sync === 'free') return config.rate;
  const seconds = noteDivisionSeconds(config.sync, bpm);
  return seconds > 0 ? 1 / seconds : config.rate;
}

/** Harmonics used to build a phase-shifted LFO wave — well past audibility for an LFO. */
const LFO_HARMONICS = 64;

/**
 * Sine-series coefficients of the ideal §6 LFO shapes, as Web Audio renders its own
 * oscillator types from phase zero: a sine starts at zero rising, a sawtooth ramps 0 → +1,
 * wraps to −1 and returns to 0, a triangle peaks at a quarter period, and a square holds
 * +1 for its first half. These are the same shapes {@link detuneSchedule} models, so the
 * declick integrator and the rendered oscillator cannot disagree.
 *
 * Every shape is odd about phase zero, so all the energy is in the sine terms.
 */
function shapeSineSeries(type: OscillatorType, harmonic: number): number {
  switch (type) {
    case 'square':
      return harmonic % 2 === 1 ? 4 / (Math.PI * harmonic) : 0;
    case 'sawtooth':
      return (2 * (harmonic % 2 === 1 ? 1 : -1)) / (Math.PI * harmonic);
    case 'triangle': {
      if (harmonic % 2 === 0) return 0;
      const alternating = ((harmonic - 1) / 2) % 2 === 0 ? 1 : -1;
      return (alternating * 8) / (Math.PI * Math.PI * harmonic * harmonic);
    }
    default:
      return harmonic === 1 ? 1 : 0; // sine
  }
}

/**
 * `PeriodicWave` coefficients for an LFO shape advanced by `phaseOffset` turns (spec §6
 * `LfoConfig.phaseOffset`). An `OscillatorNode` always starts at phase zero and has no
 * phase parameter, so the offset is baked into the waveform instead: shifting a sine term
 * `b·sin(2πkt)` by `φ` turns gives `b·sin(2πk(t+φ))`, which is `b·sin(2πkφ)` of cosine plus
 * `b·cos(2πkφ)` of sine — a rotation of each harmonic by `k·φ`.
 *
 * Pure, so the rotation is unit-testable without a Web Audio context (spec §11.1); the
 * caller hands the arrays to `createPeriodicWave`.
 */
export function lfoWaveCoefficients(
  type: OscillatorType,
  phaseOffset: number,
): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(LFO_HARMONICS + 1);
  const imag = new Float32Array(LFO_HARMONICS + 1);
  const turns = 2 * Math.PI * phaseOffset;
  for (let k = 1; k <= LFO_HARMONICS; k++) {
    const amplitude = shapeSineSeries(type, k);
    if (amplitude === 0) continue;
    real[k] = amplitude * Math.sin(turns * k);
    imag[k] = amplitude * Math.cos(turns * k);
  }
  return { real, imag };
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
