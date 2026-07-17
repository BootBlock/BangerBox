/**
 * Swing — spec §7.4. Classic MPC algebra: shift every even-numbered subdivision of the
 * swing division (1/8 or 1/16) later by `offset = (swing − 50)/50 × (divisionTicks/2)`,
 * applied non-destructively at schedule time (the stored tick never changes). Pure and
 * dependency-free (spec §7.1.5) so the offset is exhaustively unit-testable.
 */
import { PPQN } from '@/core/constants';
import type { SwingDivision } from '@/store/useTransportStore';

/** Ticks in one swing-division note (1/8 → PPQN/2, 1/16 → PPQN/4) — spec §7.4. */
export function swingDivisionTicks(swingDivision: SwingDivision): number {
  return (PPQN * 4) / swingDivision;
}

/**
 * Tick offset to add to an event on the given swing grid (spec §7.4). Zero at 50 %
 * (no swing) and for on-beat (even 0-based) subdivisions; the odd 0-based subdivisions —
 * the "even-numbered" off-beats in 1-based musical counting — are delayed. The subdivision
 * an event belongs to is the nearest grid line, so recorded off-grid timing still swings
 * with its slot. Rounded to whole ticks to preserve the integer-tick model (spec §7.2).
 */
export function swingOffsetTicks(
  tick: number,
  swingAmount: number,
  swingDivision: SwingDivision,
): number {
  if (swingAmount <= 50) return 0;
  const divisionTicks = swingDivisionTicks(swingDivision);
  const subdivision = Math.round(tick / divisionTicks);
  if (subdivision % 2 === 0) return 0; // on-beat subdivision — never swung
  const offset = ((swingAmount - 50) / 50) * (divisionTicks / 2);
  return Math.round(offset);
}

/** The swung schedule tick for an event (spec §7.4). Never earlier than the input tick. */
export function applySwing(
  tick: number,
  swingAmount: number,
  swingDivision: SwingDivision,
): number {
  return tick + swingOffsetTicks(tick, swingAmount, swingDivision);
}
