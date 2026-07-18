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
