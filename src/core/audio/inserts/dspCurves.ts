/**
 * Pure DSP data generators for the native inserts (spec §5.7) — the waveshaper transfer
 * curves for the saturator and the procedural impulse response for the v1 reverb. Kept
 * dependency-free (Float32Array in, Float32Array out) so their numeric properties are
 * unit-testable without an AudioContext (spec §11.1); the effect builders wrap the
 * output in the matching native node.
 */
import type { SATURATOR_CURVES } from './effectParams';

const CURVE_SAMPLES = 2_048;

/**
 * Waveshaper transfer curve for the saturator (spec §5.7). `drive` is in dB of pre-gain
 * into the shaper; higher drive pushes more of the signal into the non-linear region.
 * `soft` is a smooth tanh, `hard` a firmer arctangent knee, `tube` an asymmetric shape
 * (even-harmonic bias). Odd length so input 0 maps exactly to output 0 (no DC offset).
 */
export function makeSaturatorCurve(
  shape: (typeof SATURATOR_CURVES)[number],
  driveDb: number,
): Float32Array<ArrayBuffer> {
  const k = 10 ** (driveDb / 20); // linear pre-gain
  const curve = new Float32Array(CURVE_SAMPLES + 1);
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const x = (i / CURVE_SAMPLES) * 2 - 1; // −1..1
    const driven = x * k;
    curve[i] = shapeSample(shape, driven);
  }
  return curve;
}

function shapeSample(shape: (typeof SATURATOR_CURVES)[number], x: number): number {
  switch (shape) {
    case 'soft':
      return Math.tanh(x);
    case 'hard':
      return (2 / Math.PI) * Math.atan(x);
    case 'tube': {
      // Asymmetric: compress positive lobe harder than the negative (even harmonics).
      const shaped = x >= 0 ? Math.tanh(x) : Math.tanh(x * 0.7);
      return Math.max(-1, Math.min(1, shaped));
    }
  }
}

/**
 * Procedural reverb impulse response (spec §5.7 `reverb` v1: ConvolverNode with
 * generated IRs). Exponentially decaying white noise per channel; `size` is the decay
 * length in seconds and `damping` (0..1) rolls the tail off faster toward the end,
 * approximating high-frequency absorption. Returns one Float32Array per channel.
 */
export function makeReverbImpulse(
  sampleRate: number,
  sizeSeconds: number,
  damping: number,
  channels = 2,
  random: () => number = Math.random,
): Float32Array<ArrayBuffer>[] {
  const length = Math.max(1, Math.floor(sampleRate * sizeSeconds));
  // Higher damping ⇒ steeper decay exponent (faster tail roll-off).
  const decay = 2 + damping * 6;
  const result: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const envelope = (1 - i / length) ** decay;
      data[i] = (random() * 2 - 1) * envelope;
    }
    result.push(data);
  }
  return result;
}
