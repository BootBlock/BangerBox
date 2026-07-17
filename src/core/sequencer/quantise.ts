/**
 * Quantise — spec §7.4. A destructive, undoable edit (the store commits it, spec §4.5):
 * snap event ticks to a grid (1/4–1/64, straight or triplet) with strength 0–100 %, and
 * optionally bake swing into the grid. Pure and dependency-free (spec §7.1.5) — the store
 * action wraps it in an undo entry. Recording never calls this; capture stays raw (§7.4).
 */
import { PPQN } from '@/core/constants';
import type { MidiEvent } from '@/core/project/schemas';
import type { SwingDivision } from '@/store/useTransportStore';
import { applySwing } from './swing';

/** A quantise grid: a note value (1/n) played straight or as a triplet (spec §7.4). */
export interface QuantiseGrid {
  /** Note-value denominator: 4, 8, 16, 32, 64. */
  readonly division: 4 | 8 | 16 | 32 | 64;
  readonly triplet: boolean;
}

export interface QuantiseOptions {
  readonly grid: QuantiseGrid;
  /** 0..1 — 0 leaves events untouched, 1 snaps exactly to the grid (spec §7.4). */
  readonly strength: number;
  /** Optional swing baked into the grid (spec §7.4). */
  readonly swingAmount?: number;
  readonly swingDivision?: SwingDivision;
}

/** Ticks between grid lines for a quantise grid (spec §7.4). Triplets fit 3 in 2. */
export function gridTicks(grid: QuantiseGrid): number {
  const straight = (PPQN * 4) / grid.division;
  return grid.triplet ? (straight * 2) / 3 : straight;
}

/** Nearest grid line to `tick` (spec §7.4). */
export function snapTickToGrid(tick: number, grid: QuantiseGrid): number {
  const step = gridTicks(grid);
  return Math.round(tick / step) * step;
}

/**
 * Quantise one tick (spec §7.4): interpolate toward the nearest grid line by `strength`,
 * then, if swing is configured, shift the result onto the swung grid. Result is a
 * non-negative whole tick.
 */
export function quantiseTick(tick: number, options: QuantiseOptions): number {
  const strength = Math.min(1, Math.max(0, options.strength));
  const snapped = snapTickToGrid(tick, options.grid);
  let result = tick + (snapped - tick) * strength;
  if (options.swingAmount !== undefined && options.swingDivision !== undefined && strength > 0) {
    // Swing is baked relative to the fully snapped position, scaled by strength so a
    // partial quantise applies partial swing (spec §7.4 "swing applied into the grid").
    const swung = applySwing(snapped, options.swingAmount, options.swingDivision);
    result += (swung - snapped) * strength;
  }
  return Math.max(0, Math.round(result));
}

/**
 * Quantise a list of events, returning new events with snapped `tickStart` in tick order
 * (spec §7.4). Durations are preserved (note lengths are not quantised in v1). The input
 * is not mutated.
 */
export function quantiseEvents(
  events: readonly MidiEvent[],
  options: QuantiseOptions,
): MidiEvent[] {
  return events
    .map((event) => ({ ...event, tickStart: quantiseTick(event.tickStart, options) }))
    .sort((a, b) => a.tickStart - b.tickStart || a.id.localeCompare(b.id));
}
