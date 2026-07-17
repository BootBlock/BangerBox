/**
 * Lookahead windowing & loop wrapping — spec §7.1.4 / §7.1.5. The scheduler advances a
 * monotonic *linear* play position and, each wake, schedules everything in the window
 * `[from, to)` (spec §7.1.4). Looping folds that linear position back onto the loop region
 * `[startTick, endTick)`; because the linear window only ever moves forward, an event is
 * scheduled **exactly once per loop pass** (spec §7.1.5 double-scheduling protection).
 *
 * Pure and dependency-free (spec §7.1.5) so loop-boundary behaviour is exhaustively
 * unit-testable. `from`/`to` and all ticks are in the linear play-position domain; the
 * returned `tick` is the sequence tick (0-based within the pattern), `linearTick` its
 * absolute play position (used for tick→seconds conversion, spec §7.2).
 */

/** Loop region — `[startTick, endTick)`, end exclusive (spec §7.1.4). */
export interface LoopRegion {
  readonly enabled: boolean;
  readonly startTick: number;
  readonly endTick: number;
}

/** A contiguous stretch of linear play positions mapped to sequence ticks. */
export interface LinearSegment {
  /** Sequence tick at `linearStart`. */
  readonly seqStart: number;
  /** Sequence tick one past the segment (exclusive). */
  readonly seqEnd: number;
  /** Linear play position at the segment start. */
  readonly linearStart: number;
}

/** An event placed at a concrete point in the linear timeline. */
export interface WindowedItem<T> {
  readonly item: T;
  /** Sequence tick of the event within the pattern. */
  readonly tick: number;
  /** Absolute linear play position of this occurrence. */
  readonly linearTick: number;
}

/** True when the loop region is usable (enabled and non-empty). */
export function loopActive(loop: LoopRegion): boolean {
  return loop.enabled && loop.endTick > loop.startTick;
}

/**
 * Fold a linear play position onto its sequence tick (spec §7.1.4). Before the loop end
 * the two coincide (covers any pre-roll before `startTick`); at and past the end the
 * position wraps within `[startTick, endTick)`.
 */
export function sequenceTickAt(linear: number, loop: LoopRegion): number {
  if (!loopActive(loop) || linear < loop.endTick) return linear;
  const length = loop.endTick - loop.startTick;
  return loop.startTick + ((linear - loop.startTick) % length);
}

/**
 * Number of completed loop passes at a linear position (0 before the first wrap). Used to
 * emit one `loopWrapped` per pass (spec §7.1.3).
 */
export function loopPassAt(linear: number, loop: LoopRegion): number {
  if (!loopActive(loop) || linear < loop.endTick) return 0;
  const length = loop.endTick - loop.startTick;
  return Math.floor((linear - loop.startTick) / length);
}

/**
 * Break a linear window `[from, to)` into segments in which the linear→sequence mapping is
 * contiguous (spec §7.1.4). Breakpoints fall at the loop end and every loop length after
 * it. Callers select events per segment by sequence tick.
 */
export function segmentWindow(from: number, to: number, loop: LoopRegion): LinearSegment[] {
  const segments: LinearSegment[] = [];
  let pos = from;
  const guardMax = 100_000; // structural guard against a zero-length loop slipping through
  let guard = 0;
  while (pos < to && guard++ < guardMax) {
    const seqStart = sequenceTickAt(pos, loop);
    const nextBreak = nextBreakpoint(pos, loop);
    const segEnd = Math.min(to, nextBreak);
    segments.push({ seqStart, seqEnd: seqStart + (segEnd - pos), linearStart: pos });
    pos = segEnd;
  }
  return segments;
}

/** The next linear position (> pos) at which the loop mapping restarts. */
function nextBreakpoint(pos: number, loop: LoopRegion): number {
  if (!loopActive(loop) || pos < loop.endTick) {
    return loopActive(loop) ? loop.endTick : Number.POSITIVE_INFINITY;
  }
  const length = loop.endTick - loop.startTick;
  const cyclesPast = Math.floor((pos - loop.endTick) / length);
  return loop.endTick + length * (cyclesPast + 1);
}

/**
 * Every occurrence of an event in the linear window `[from, to)`, each exactly once per
 * loop pass (spec §7.1.5). `items` must be sorted by tick; `tickOf` reads an item's
 * sequence tick. Results are in linear-time order.
 */
export function eventsInWindow<T>(
  items: readonly T[],
  tickOf: (item: T) => number,
  from: number,
  to: number,
  loop: LoopRegion,
): WindowedItem<T>[] {
  const out: WindowedItem<T>[] = [];
  for (const segment of segmentWindow(from, to, loop)) {
    for (const item of items) {
      const tick = tickOf(item);
      if (tick < segment.seqStart || tick >= segment.seqEnd) continue;
      out.push({ item, tick, linearTick: segment.linearStart + (tick - segment.seqStart) });
    }
  }
  return out;
}
