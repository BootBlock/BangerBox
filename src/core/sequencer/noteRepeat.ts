/**
 * Note repeat — spec §7.3. While active with held pads, the worker generates notes locked
 * to the chosen division (1/4–1/64, straight or triplet) at the held (or a fixed) velocity.
 * This module is the pure grid generator (spec §7.1.5): it enumerates the repeat ticks in a
 * lookahead window; swing (§7.4) is applied by the scheduler when it converts ticks to
 * seconds, so every repeat respects swing without duplicating that maths here. The
 * arpeggiator (§7.3, keygroup tracks) shares this subdivision clock and lands in Phase 5.
 */
import { PPQN } from '@/core/constants';

/** Note-value denominator for a repeat division (spec §7.3). */
export type NoteRepeatDivisionValue = 4 | 8 | 16 | 32 | 64;

/** A repeat division: a note value, straight or triplet (spec §7.3). */
export interface NoteRepeatDivision {
  readonly value: NoteRepeatDivisionValue;
  readonly triplet: boolean;
}

/** A pad held down for note repeat (spec §7.3). */
export interface HeldNote {
  readonly note: number;
  readonly velocity: number;
}

/** One generated repeat trigger at a sequence tick (spec §7.3). */
export interface NoteRepeatHit {
  readonly note: number;
  readonly velocity: number;
  readonly tick: number;
}

/** Ticks between repeats for a division (spec §7.3). Triplets fit three in the space of two. */
export function noteRepeatStepTicks(division: NoteRepeatDivision): number {
  const straight = (PPQN * 4) / division.value;
  return division.triplet ? (straight * 2) / 3 : straight;
}

/**
 * The division grid ticks in `[from, to)` (spec §7.3). The grid is absolute (locked to the
 * transport origin, tick 0), so repeats stay phase-aligned to the bar as the window advances.
 */
export function repeatTicksInWindow(from: number, to: number, division: NoteRepeatDivision): number[] {
  const step = noteRepeatStepTicks(division);
  const ticks: number[] = [];
  let tick = Math.ceil(from / step) * step;
  for (; tick < to; tick += step) ticks.push(tick);
  return ticks;
}

/**
 * Repeat hits for every held pad across the window (spec §7.3). When `fixedVelocity` is
 * given it overrides each held note's own velocity (the adjustable fixed-velocity option).
 * Hits are ordered by tick, then by the order pads were held.
 */
export function noteRepeatHits(
  held: readonly HeldNote[],
  division: NoteRepeatDivision,
  from: number,
  to: number,
  fixedVelocity?: number,
): NoteRepeatHit[] {
  if (held.length === 0) return [];
  const ticks = repeatTicksInWindow(from, to, division);
  const hits: NoteRepeatHit[] = [];
  for (const tick of ticks) {
    for (const pad of held) {
      hits.push({ note: pad.note, velocity: fixedVelocity ?? pad.velocity, tick });
    }
  }
  return hits;
}
