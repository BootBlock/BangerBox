/**
 * Insert-effect parameter defaults and bounds — spec §5.7 (table). Every native effect
 * exposes typed numeric params validated against these ranges (spec §5.7 "all ranges
 * validated in the store action layer"); enumerated choices (filter type, saturator
 * curve) are encoded as small integer indices so the whole surface fits the store's
 * `InsertSlotState.params: Record<string, number>` (spec §4.2) and stays automatable
 * (spec §7.8). Pure and dependency-light so it is trivially unit-testable (spec §2.5).
 */
import { BPM_RANGE, NOTE_DIVISIONS, type NoteDivision } from '@/core/project/schemas';
import type { EffectType } from '@/core/project/schemas';
import type { Range } from '@/core/project/schemas';
import { noteDivisionSeconds } from '@/core/sequencer/ppqn';

/** The wrapper-level dry/wet mix shared by every insert (spec §5.7). */
export const MIX_RANGE: Range = [0, 1];

/** Filter type index encoding (spec §5.7 `filter.type` lp/hp/bp/notch). */
export const FILTER_TYPES = ['lp', 'hp', 'bp', 'notch'] as const;
/** Saturator curve index encoding (spec §5.7 `saturator.curve` soft/hard/tube). */
export const SATURATOR_CURVES = ['soft', 'hard', 'tube'] as const;

/**
 * Delay time modes (spec §5.7 "time: free 1–2000 ms **or** synced division (1/32–1/2,
 * dotted/triplet)"). Index 0 is `free`, which keeps the `time` parameter's milliseconds;
 * every other index names a §6 note division the delay follows at the transport tempo.
 *
 * The list is derived from `NOTE_DIVISIONS` rather than restated, so the two cannot drift
 * (spec §13.6). `1/1` is dropped because §5.7 bounds the synced set at 1/2.
 */
const DELAY_SYNC_MODES: readonly ('free' | NoteDivision)[] = [
  'free',
  ...NOTE_DIVISIONS.filter((division) => division !== '1/1'),
];

/** The note division for a `sync` index, or null for free time (spec §5.7). */
export function delaySyncDivision(index: number): NoteDivision | null {
  const mode = DELAY_SYNC_MODES[Math.round(index)];
  return mode === undefined || mode === 'free' ? null : mode;
}

/** Longest free delay time in milliseconds (spec §5.7). */
const MAX_FREE_DELAY_MS = 2_000;

/**
 * `maxDelayTime` for the delay's `DelayNode`, in seconds: the longest §5.7 synced division
 * at the slowest §4.2 tempo. A `DelayNode` fixes its line length at construction, and a
 * synced delay that silently truncated at 40 bpm would be worse than none — so the worst
 * case is allocated once and derived here rather than guessed at the call site.
 */
export const DELAY_MAX_SECONDS = Math.max(
  MAX_FREE_DELAY_MS / 1000,
  ...DELAY_SYNC_MODES.filter((mode): mode is NoteDivision => mode !== 'free').map((division) =>
    noteDivisionSeconds(division, BPM_RANGE[0]),
  ),
);

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
    // spec §5.7: free time 1–2000 ms, used whenever `sync` is 0 (free).
    time: [1, MAX_FREE_DELAY_MS],
    // spec §5.7: the synced division, index-encoded into DELAY_SYNC_MODES like the
    // filter's type and the saturator's curve, so the whole surface stays automatable
    // through `InsertSlotState.params: Record<string, number>` (spec §4.2, §7.8).
    sync: [0, DELAY_SYNC_MODES.length - 1],
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
  // Worklet + WASM effects (spec §5.7): 3-band compressor and lookahead limiter.
  multibandComp: {
    crossoverLowMid: [40, 500],
    crossoverMidHigh: [500, 8_000],
    band0Threshold: [-60, 0],
    band0Ratio: [1, 20],
    band0Attack: [0.1, 100],
    band0Release: [10, 1_000],
    band0Makeup: [0, 24],
    band1Threshold: [-60, 0],
    band1Ratio: [1, 20],
    band1Attack: [0.1, 100],
    band1Release: [10, 1_000],
    band1Makeup: [0, 24],
    band2Threshold: [-60, 0],
    band2Ratio: [1, 20],
    band2Attack: [0.1, 100],
    band2Release: [10, 1_000],
    band2Makeup: [0, 24],
  },
  limiter: {
    ceiling: [-6, 0],
    release: [10, 500],
  },
};

/**
 * The labels behind an index-encoded parameter (spec §5.7): the `filter` type, the
 * `saturator` curve, and the `delay` sync division. These params are integers so the whole
 * effect surface fits `InsertSlotState.params` and stays automatable (spec §7.8), but a knob
 * reading "7" tells a user nothing — the editor renders a choice control for anything named
 * here, and a knob for everything else.
 */
export const EFFECT_PARAM_CHOICES: Partial<Record<EffectType, Record<string, readonly string[]>>> = {
  filter: { type: FILTER_TYPES },
  saturator: { curve: SATURATOR_CURVES },
  delay: { sync: DELAY_SYNC_MODES },
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
      return { time: 350, sync: 0, feedback: 0.35, tone: 6_000, mix: 0.35 };
    case 'compressor':
      return { threshold: -18, ratio: 4, attack: 5, release: 120, knee: 12, makeup: 0 };
    case 'saturator':
      return { drive: 6, curve: 0, output: 0, mix: 1 };
    case 'reverb':
      return { size: 1.8, damping: 0.5, predelay: 12, mix: 0.3 };
    case 'multibandComp':
      return {
        crossoverLowMid: 200,
        crossoverMidHigh: 2_000,
        band0Threshold: -24,
        band0Ratio: 3,
        band0Attack: 15,
        band0Release: 150,
        band0Makeup: 0,
        band1Threshold: -24,
        band1Ratio: 3,
        band1Attack: 10,
        band1Release: 120,
        band1Makeup: 0,
        band2Threshold: -24,
        band2Ratio: 3,
        band2Attack: 5,
        band2Release: 80,
        band2Makeup: 0,
      };
    case 'limiter':
      return { ceiling: -0.3, release: 100 };
    default:
      return {};
  }
}
