/**
 * Grid geometry — the pure mapping between musical coordinates (ticks, MIDI notes) and
 * canvas pixels for the Grid / Piano Roll editor (spec §8.5.2). Dependency-free and
 * DOM-free so it is trivially unit-testable (spec §2.5); the canvas component owns the
 * drawing, this owns the maths.
 */
import type { AutomationPoint, MidiEvent } from '@/core/project/schemas';

/** MIDI note bounds (spec §9.3 `note INTEGER 0..127`). */
const NOTE_MIN = 0;
const NOTE_MAX = 127;

/** Width in pixels of an event's resize handle at its right edge (spec §8.5.2 resize). */
const RESIZE_HANDLE_PX = 6;

/**
 * The same handle for a finger. A fingertip contact patch is roughly 8–10 mm, so the 6 px
 * mouse handle is neither deliberately hittable nor reliably avoidable by touch (issue #43)
 * — it mostly fires by accident while trying to drag a note. {@link resizeHandleAtPoint}
 * caps the handle at half the note's width whatever is passed, so widening it for touch
 * cannot swallow a short note whole and leave it un-draggable.
 */
export const TOUCH_RESIZE_HANDLE_PX = 22;

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
 * Value range an automation lane is drawn against (spec §7.8). A point's `value` is
 * unbounded in the schema — a lane may hold gains in 0..1, pan in -1..1 or a cutoff in
 * hertz — so the lane is scaled to what the lane itself contains rather than to a range
 * assumed from the target path, which would flatten most lanes against an edge.
 *
 * A lane whose points all share one value has no range to scale against; it is padded
 * symmetrically so the flat line draws through the middle instead of dividing by zero.
 */
export interface AutomationBounds {
  readonly min: number;
  readonly max: number;
}

const FLAT_LANE_PADDING = 0.5;

export function automationBounds(points: readonly AutomationPoint[]): AutomationBounds {
  if (points.length === 0) return { min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    if (point.value < min) min = point.value;
    if (point.value > max) max = point.value;
  }
  if (min === max) return { min: min - FLAT_LANE_PADDING, max: max + FLAT_LANE_PADDING };
  return { min, max };
}

/**
 * Automation value → y pixel from the lane's top edge. The lane carries the same 4 px
 * margin as the velocity lane, so its line never sits flush against either border.
 */
export function automationValueToY(value: number, bounds: AutomationBounds, laneHeight: number): number {
  const travel = laneHeight - 8;
  const fraction = Math.min(1, Math.max(0, (value - bounds.min) / (bounds.max - bounds.min)));
  return 4 + (1 - fraction) * travel;
}

/** How many segments an `exp` span is sampled at — enough to read as a curve, not a chord. */
const EXP_SEGMENTS = 8;

/**
 * The automation line as a polyline in lane-local pixels (spec §7.8 curves). Each point's
 * `curve` describes the span *leaving* it: `step` holds the value until the next point and
 * jumps there, `linear` runs straight to it, and `exp` is sampled along a squared ease so
 * the shape is visibly distinct from a straight line rather than merely implied.
 *
 * The line is extended flat to the viewport's right edge past the last point, because a
 * lane's final value stays in force — a line that simply stopped would read as the
 * automation ending there.
 */
export function automationPolyline(
  points: readonly AutomationPoint[],
  viewport: GridViewport,
  bounds: AutomationBounds,
  laneHeight: number,
): { x: number; y: number }[] {
  if (points.length === 0) return [];
  const ordered = [...points].sort((a, b) => a.tick - b.tick);
  const y = (value: number) => automationValueToY(value, bounds, laneHeight);
  const line: { x: number; y: number }[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const point = ordered[index]!;
    const x = tickToX(point.tick, viewport);
    line.push({ x, y: y(point.value) });

    const next = ordered[index + 1];
    if (!next) break;
    const nextX = tickToX(next.tick, viewport);
    if (point.curve === 'step') {
      line.push({ x: nextX, y: y(point.value) });
    } else if (point.curve === 'exp') {
      for (let step = 1; step < EXP_SEGMENTS; step += 1) {
        const t = step / EXP_SEGMENTS;
        line.push({
          x: x + (nextX - x) * t,
          y: y(point.value + (next.value - point.value) * t * t),
        });
      }
    }
  }

  const last = ordered[ordered.length - 1]!;
  const edgeX = viewport.width;
  const lastX = tickToX(last.tick, viewport);
  if (edgeX > lastX) line.push({ x: edgeX, y: y(last.value) });
  return line;
}

/**
 * The event whose right-edge resize handle is under a point, or null. Checked *before*
 * a move so grabbing the tail of a note resizes rather than drags it (spec §8.5.2).
 *
 * `handlePx` widens the target for touch ({@link TOUCH_RESIZE_HANDLE_PX}); it is capped at
 * half the note's drawn width so the front half of even a very short note always starts a
 * move. Without the cap a touch-sized handle would cover a 1/16 note entirely at anything
 * but the closest zoom, and the note could then only ever be resized, never dragged.
 */
export function resizeHandleAtPoint(
  events: readonly MidiEvent[],
  x: number,
  y: number,
  viewport: GridViewport,
  handlePx: number = RESIZE_HANDLE_PX,
): MidiEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (rowToNote(yToRow(y, viewport), viewport) !== event.note) continue;
    const endX = tickToX(event.tickStart + event.durationTicks, viewport);
    const width = event.durationTicks / viewport.ticksPerPixel;
    const handle = Math.min(handlePx, width / 2);
    if (x >= endX - handle && x < endX) return event;
  }
  return null;
}
