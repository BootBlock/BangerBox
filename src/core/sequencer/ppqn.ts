/**
 * PPQN musical maths — spec §7.2. All positions/durations are integer ticks at 960 PPQN
 * (spec §1.3 #17); these pure conversions turn ticks into context seconds and back and
 * decompose ticks into bars:beats:ticks for the accessible readout (spec §4.2). Kept
 * dependency-free (no DOM/audio types) so it is trivially unit-testable (spec §2.5, §7.1.5).
 */
import { PPQN } from '@/core/constants';
import type { NoteDivision, TimeSignature } from '@/core/project/schemas';

/** Ticks in one whole note — the denominator scale reference (spec §7.2). */
const TICKS_PER_WHOLE_NOTE = PPQN * 4;

/** Seconds per tick at `bpm` — the canonical conversion (spec §7.2). */
export function secondsPerTick(bpm: number): number {
  return 60 / (bpm * PPQN);
}

/** Convert a tick count to seconds at a constant tempo (spec §7.2). */
export function ticksToSeconds(ticks: number, bpm: number): number {
  return ticks * secondsPerTick(bpm);
}

/** Convert seconds to (fractional) ticks at a constant tempo (spec §7.2). */
export function secondsToTicks(seconds: number, bpm: number): number {
  return seconds / secondsPerTick(bpm);
}

/** Ticks per beat (one denominator note) for a time signature (spec §7.2). */
export function ticksPerBeat(timeSig: TimeSignature): number {
  return TICKS_PER_WHOLE_NOTE / timeSig.denominator;
}

/** Ticks in one bar of the given time signature (spec §7.2). */
export function ticksPerBar(timeSig: TimeSignature): number {
  return timeSig.numerator * ticksPerBeat(timeSig);
}

/** Ticks spanning `bars` complete bars of the given time signature (spec §7.2). */
export function barsToTicks(bars: number, timeSig: TimeSignature): number {
  return bars * ticksPerBar(timeSig);
}

/**
 * Ticks spanned by one §6 note division — the shared vocabulary behind the synced LFO
 * (spec §6 `LfoConfig.sync`) and the synced delay (spec §5.7). A dotted division is half
 * again as long as the straight one; a triplet fits three in the space of two, exactly as
 * {@link noteRepeatStepTicks} treats §7.3's own divisions.
 */
function noteDivisionTicks(division: NoteDivision): number {
  const dotted = division.endsWith('.');
  const triplet = division.endsWith('T');
  const denominator = Number(division.slice(2, division.length - (dotted || triplet ? 1 : 0)));
  const straight = TICKS_PER_WHOLE_NOTE / denominator;
  if (dotted) return straight * 1.5;
  if (triplet) return (straight * 2) / 3;
  return straight;
}

/** Seconds spanned by one §6 note division at `bpm` (spec §7.2). */
export function noteDivisionSeconds(division: NoteDivision, bpm: number): number {
  return ticksToSeconds(noteDivisionTicks(division), bpm);
}

/** A musical position decomposed for the accessible readout (spec §4.2). */
export interface BarBeatTick {
  /** 1-based bar number. */
  readonly bar: number;
  /** 1-based beat within the bar. */
  readonly beat: number;
  /** 0-based tick within the beat. */
  readonly tick: number;
}

/**
 * Decompose an absolute tick into 1-based bar:beat plus the tick within the beat
 * (spec §4.2 coarse readout; §7.2 bars:beats:ticks). Negative ticks clamp to the origin.
 */
export function tickToBarBeatTick(tick: number, timeSig: TimeSignature): BarBeatTick {
  if (tick <= 0) return { bar: 1, beat: 1, tick: 0 };
  const perBar = ticksPerBar(timeSig);
  const perBeat = ticksPerBeat(timeSig);
  const bar = Math.floor(tick / perBar);
  const withinBar = tick - bar * perBar;
  const beat = Math.floor(withinBar / perBeat);
  const withinBeat = withinBar - beat * perBeat;
  return { bar: bar + 1, beat: beat + 1, tick: withinBeat };
}
