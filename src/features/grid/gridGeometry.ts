/**
 * Grid geometry — the pure mapping between musical coordinates (ticks, MIDI notes) and
 * canvas pixels for the Grid / Piano Roll editor (spec §8.5.2). Dependency-free and
 * DOM-free so it is trivially unit-testable (spec §2.5); the canvas component owns the
 * drawing, this owns the maths.
 */
import type { MidiEvent } from '@/core/project/schemas';

/** MIDI note bounds (spec §9.3 `note INTEGER 0..127`). */
const NOTE_MIN = 0;
const NOTE_MAX = 127;

/** Width in pixels of an event's resize handle at its right edge (spec §8.5.2 resize). */
export const RESIZE_HANDLE_PX = 6;

export interface GridViewport {
  readonly width: number;
  readonly height: number;
  /** Tick at the left edge of the viewport (horizontal scroll). */
  readonly scrollTicks: number;
  /** Zoom: musical ticks covered by one pixel. Larger = zoomed out. */
  readonly ticksPerPixel: number;
  readonly rowHeight: number;
  /** Rows scrolled past vertically; folded into `topNote` by the caller. */
  readonly scrollRows: number;
  /** MIDI note drawn in the topmost visible row. */
  readonly topNote: number;
}

/** Tick → x pixel within the viewport. */
export function tickToX(tick: number, viewport: GridViewport): number {
  return (tick - viewport.scrollTicks) / viewport.ticksPerPixel;
}

/** x pixel → tick, clamped at zero (the timeline has no negative region). */
export function xToTick(x: number, viewport: GridViewport): number {
  return Math.max(0, x * viewport.ticksPerPixel + viewport.scrollTicks);
}

/** MIDI note → row index (0 = top). Notes descend down the grid, as on a piano roll. */
export function noteToRow(note: number, viewport: GridViewport): number {
  return viewport.topNote - note;
}

/** Row index → MIDI note, clamped into the valid MIDI range. */
export function rowToNote(row: number, viewport: GridViewport): number {
  return Math.min(NOTE_MAX, Math.max(NOTE_MIN, viewport.topNote - row));
}

/** y pixel → row index. */
export function yToRow(y: number, viewport: GridViewport): number {
  return Math.floor(y / viewport.rowHeight);
}

/** Row index → y pixel of the row's top edge. */
export function rowToY(row: number, viewport: GridViewport): number {
  return row * viewport.rowHeight;
}

/** Snap a tick to the grid, or round it through when snapping is off (spec §8.5.2). */
export function snapTick(tick: number, snapTicks: number): number {
  return snapTicks > 0 ? Math.round(tick / snapTicks) * snapTicks : Math.round(tick);
}

/** A grid cell a paint gesture passes over: one row (note) at one snapped start tick. */
export interface GridCell {
  readonly note: number;
  readonly tick: number;
}

/**
 * The cells a drag segment passes over, in travel order (spec §8.5.2 draw). A pointer
 * moving fast reports few, widely spaced samples, so the segment is walked at sub-cell
 * steps rather than only its endpoints — otherwise a quick swipe would paint its start
 * and end and leave the cells between them empty.
 */
export function cellsAlongSegment(
  from: { x: number; y: number },
  to: { x: number; y: number },
  viewport: GridViewport,
  snapTicks: number,
): GridCell[] {
  // Step at half the smaller cell dimension so no cell can be stepped over.
  const cellWidth = snapTicks > 0 ? snapTicks / viewport.ticksPerPixel : 1;
  const step = Math.max(1, Math.min(cellWidth, viewport.rowHeight) / 2);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const samples = Math.max(1, Math.ceil(distance / step));

  const cells: GridCell[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const cell = {
      note: rowToNote(yToRow(y, viewport), viewport),
      tick: snapTick(xToTick(x, viewport), snapTicks),
    };
    // Consecutive samples usually land in the same cell; keep only the transitions.
    const previous = cells[cells.length - 1];
    if (previous?.note === cell.note && previous.tick === cell.tick) continue;
    cells.push(cell);
  }
  return cells;
}

/** The MIDI notes the viewport can currently display, top row first. */
export function visibleRows(viewport: GridViewport): number[] {
  const count = Math.ceil(viewport.height / viewport.rowHeight);
  return Array.from({ length: count }, (_, row) => rowToNote(row, viewport));
}

/** True when the point falls inside the event's rectangle. */
function pointInEvent(event: MidiEvent, x: number, y: number, viewport: GridViewport): boolean {
  if (rowToNote(yToRow(y, viewport), viewport) !== event.note) return false;
  const startX = tickToX(event.tickStart, viewport);
  const endX = tickToX(event.tickStart + event.durationTicks, viewport);
  return x >= startX && x < endX;
}

/**
 * The event under a point, or null. Later events win, so the most recently drawn note —
 * the one painted on top — is the one the user grabs.
 */
export function eventAtPoint(
  events: readonly MidiEvent[],
  x: number,
  y: number,
  viewport: GridViewport,
): MidiEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (pointInEvent(event, x, y, viewport)) return event;
  }
  return null;
}

/**
 * The event occupying a grid cell, or null. The cell-space counterpart of
 * {@link eventAtPoint}, used by the paint gestures, which walk cells rather than pixels.
 * Later events win, matching {@link eventAtPoint}.
 */
export function eventAtCell(events: readonly MidiEvent[], note: number, tick: number): MidiEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.note === note && tick >= event.tickStart && tick < event.tickStart + event.durationTicks) {
      return event;
    }
  }
  return null;
}

/**
 * Velocity a y pixel inside the velocity lane stands for (spec §8.5.2 velocity lane).
 * `laneY` is measured from the lane's top edge; the lane is drawn with a 4 px margin top
 * and bottom, so the usable travel is `laneHeight - 8`. Full height is 127, the floor is
 * 1 — a zero-velocity note is silent, which reads as a broken drag rather than a quiet
 * note (spec §9.3 `velocity INTEGER 1..127`).
 */
export function velocityAtLaneY(laneY: number, laneHeight: number): number {
  const travel = laneHeight - 8;
  const fraction = Math.min(1, Math.max(0, 1 - (laneY - 4) / travel));
  return Math.max(1, Math.round(fraction * 127));
}

/**
 * The note whose velocity bar is nearest a tick, within `toleranceTicks`, or null. Used
 * for the press that starts a velocity drag: bars are 3 px wide, so an exact hit test
 * would be unusable and the nearest bar within a small window owns the click instead.
 *
 * Nearest, not first-in-order: with several notes inside the window the closest bar is
 * the one under the pointer, whatever order the track happens to store them in.
 */
export function nearestEventToTick(
  events: readonly MidiEvent[],
  tick: number,
  toleranceTicks: number,
): MidiEvent | null {
  let best: MidiEvent | null = null;
  let bestDistance = Infinity;
  for (const event of events) {
    const distance = Math.abs(event.tickStart - tick);
    if (distance <= toleranceTicks && distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Every note whose velocity bar starts inside the tick span a drag segment swept, in
 * timeline order. This is how a sideways velocity drag shapes several notes at once.
 *
 * Deliberately *not* {@link cellsAlongSegment}: that walks sub-cell steps because draw
 * paints discrete cells and must not skip one. Velocity bars are continuous, so the span
 * between two pointer samples already names every bar crossed — no sampling needed, and
 * no per-cell tolerance to tune. Nor does it use the press-time tolerance: widening the
 * span would let a drag past one bar also grab its close neighbours, which is exactly the
 * over-reach a drag across dense notes must avoid.
 */
export function eventsInTickSpan(
  events: readonly MidiEvent[],
  fromTick: number,
  toTick: number,
): MidiEvent[] {
  const low = Math.min(fromTick, toTick);
  const high = Math.max(fromTick, toTick);
  return events
    .filter((event) => event.tickStart >= low && event.tickStart <= high)
    .sort((a, b) => a.tickStart - b.tickStart);
}

/**
 * The event whose right-edge resize handle is under a point, or null. Checked *before*
 * a move so grabbing the tail of a note resizes rather than drags it (spec §8.5.2).
 */
export function resizeHandleAtPoint(
  events: readonly MidiEvent[],
  x: number,
  y: number,
  viewport: GridViewport,
): MidiEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (rowToNote(yToRow(y, viewport), viewport) !== event.note) continue;
    const endX = tickToX(event.tickStart + event.durationTicks, viewport);
    if (x >= endX - RESIZE_HANDLE_PX && x < endX) return event;
  }
  return null;
}
