/**
 * Insert-effect parameter defaults and bounds — spec §5.7 (table). Every native effect
 * exposes typed numeric params validated against these ranges (spec §5.7 "all ranges
 * validated in the store action layer"); enumerated choices (filter type, saturator
 * curve) are encoded as small integer indices so the whole surface fits the store's
 * `InsertSlotState.params: Record<string, number>` (spec §4.2) and stays automatable
 * (spec §7.8). Pure and dependency-light so it is trivially unit-testable (spec §2.5).
 */
import type { EffectType } from '@/core/project/schemas';
import type { Range } from '@/core/project/schemas';

/** The wrapper-level dry/wet mix shared by every insert (spec §5.7). */
export const MIX_RANGE: Range = [0, 1];

/** Filter type index encoding (spec §5.7 `filter.type` lp/hp/bp/notch). */
export const FILTER_TYPES = ['lp', 'hp', 'bp', 'notch'] as const;
/** Saturator curve index encoding (spec §5.7 `saturator.curve` soft/hard/tube). */
export const SATURATOR_CURVES = ['soft', 'hard', 'tube'] as const;

/** Native `BiquadFilterType` for each `filter`/eq band role. */
export const FILTER_TYPE_TO_BIQUAD: Record<(typeof FILTER_TYPES)[number], BiquadFilterType> = {
  lp: 'lowpass',
  hp: 'highpass',
  bp: 'bandpass',
  notch: 'notch',
};

/** Per-effect parameter bounds (spec §5.7). Missing key ⇒ that param is a fixed choice. */
export const EFFECT_PARAM_RANGES: Record<EffectType, Record<string, Range>> = {
  eq4: {
    lowFreq: [20, 500],
    lowGain: [-15, 15],
    peak1Freq: [50, 16_000],
    peak1Gain: [-15, 15],
    peak1Q: [0.1, 10],
    peak2Freq: [50, 16_000],
    peak2Gain: [-15, 15],
    peak2Q: [0.1, 10],
    highFreq: [1_000, 20_000],
    highGain: [-15, 15],
  },
  filter: {
    type: [0, FILTER_TYPES.length - 1],
    cutoff: [20, 20_000],
    resonance: [0.1, 20],
  },
  delay: {
    // spec §5.7: free time 1–2000 ms (synced division arrives with the tempo map, §7.9).
    time: [1, 2_000],
    feedback: [0, 0.95],
    tone: [200, 18_000],
    mix: MIX_RANGE,
  },
  compressor: {
    threshold: [-60, 0],
    ratio: [1, 20],
    attack: [0.1, 100],
    release: [10, 1_000],
    knee: [0, 40],
    makeup: [0, 24],
  },
  saturator: {
    drive: [0, 36],
    curve: [0, SATURATOR_CURVES.length - 1],
    output: [-24, 24],
    mix: MIX_RANGE,
  },
  reverb: {
    size: [0.2, 10],
    damping: [0, 1],
    predelay: [0, 200],
    mix: MIX_RANGE,
  },
  // Worklet + WASM effects arrive in Phase 6 (spec §5.7); no native params here yet.
  multibandComp: {},
  limiter: {},
};

/** Neutral starting parameters for a freshly added insert of `effectType` (spec §5.7). */
export function defaultEffectParams(effectType: EffectType): Record<string, number> {
  switch (effectType) {
    case 'eq4':
      return {
        lowFreq: 120,
        lowGain: 0,
        peak1Freq: 500,
        peak1Gain: 0,
        peak1Q: 1,
        peak2Freq: 3_000,
        peak2Gain: 0,
        peak2Q: 1,
        highFreq: 8_000,
        highGain: 0,
      };
    case 'filter':
      return { type: 0, cutoff: 2_000, resonance: 1 };
    case 'delay':
      return { time: 350, feedback: 0.35, tone: 6_000, mix: 0.35 };
    case 'compressor':
      return { threshold: -18, ratio: 4, attack: 5, release: 120, knee: 12, makeup: 0 };
    case 'saturator':
      return { drive: 6, curve: 0, output: 0, mix: 1 };
    case 'reverb':
      return { size: 1.8, damping: 0.5, predelay: 12, mix: 0.3 };
    default:
      return {};
  }
}
