/**
 * The Grid's scroll and zoom, held outside React (spec §3.3, §8.4 — issue #28).
 *
 * §3.3 names "waveform scroll" among the values that must never pass through React state,
 * and a Grid pan is the same value: wheel and pointer events arrive at 60–120 Hz on the
 * target tablet, and every one of them re-rendered `GridMode` — including the unmemoised
 * note-list sort in its render body — to move a canvas that was already reading the
 * viewport from a ref of its own. The React round trip bought nothing at all.
 *
 * The box lives here instead, and the canvas's rAF loop reads it directly. Subscribers exist
 * for the few things that genuinely have to show the zoom factor, and §3.3 governs them too:
 * they paint by ref rather than re-rendering (see `GridZoomControls`).
 *
 * The clamps are pure functions rather than methods, so the zoom floor and ceiling and the
 * note-range limit are testable without a canvas or a pointer (spec §2.5).
 */

/** Zoom: ticks per pixel at 1× — the value the Reset control returns to. */
export const DEFAULT_TICKS_PER_PIXEL = 8;
/** Zoomed all the way in: one tick per pixel. */
export const MIN_TICKS_PER_PIXEL = 1;
/** Zoomed all the way out. */
export const MAX_TICKS_PER_PIXEL = 64;
const DEFAULT_ROW_HEIGHT = 20;
/** The topmost note the grid will scroll to; below it there is nothing left to show. */
const MIN_TOP_NOTE = 11;
const MAX_TOP_NOTE = 127;

/** The Grid's scroll/zoom box — `GridViewport` (§8.5.2) without its measured pixel size. */
export interface GridViewportBox {
  /** Tick at the left edge (horizontal scroll). */
  readonly scrollTicks: number;
  /** Musical ticks covered by one pixel. Larger = zoomed out. */
  readonly ticksPerPixel: number;
  readonly rowHeight: number;
  /** Rows scrolled past vertically; folded into `topNote` by the caller. */
  readonly scrollRows: number;
  /** MIDI note drawn in the topmost visible row. */
  readonly topNote: number;
}

const DEFAULT_GRID_VIEWPORT: GridViewportBox = {
  scrollTicks: 0,
  ticksPerPixel: DEFAULT_TICKS_PER_PIXEL,
  rowHeight: DEFAULT_ROW_HEIGHT,
  scrollRows: 0,
  topNote: 72,
};

/** Pan by `deltaTicks` horizontally and `deltaRows` vertically, clamped to the grid. */
export function scrolled(box: GridViewportBox, deltaTicks: number, deltaRows: number): GridViewportBox {
  return {
    ...box,
    // The timeline has no negative region, so scrolling left stops at the start.
    scrollTicks: Math.max(0, box.scrollTicks + deltaTicks),
    topNote: Math.min(MAX_TOP_NOTE, Math.max(MIN_TOP_NOTE, box.topNote - deltaRows)),
  };
}

/** Multiply the zoom by `factor`, clamped to the range the grid stays legible over. */
export function zoomed(box: GridViewportBox, factor: number): GridViewportBox {
  return {
    ...box,
    ticksPerPixel: Math.min(MAX_TICKS_PER_PIXEL, Math.max(MIN_TICKS_PER_PIXEL, box.ticksPerPixel * factor)),
  };
}

/** The zoom factor a box is at, as the readout shows it (1× at the default). */
export function zoomFactor(box: GridViewportBox): number {
  return DEFAULT_TICKS_PER_PIXEL / box.ticksPerPixel;
}

export type GridViewportListener = (box: GridViewportBox) => void;

export interface GridViewportStore {
  /** The current box. Read it per frame; it is a plain object, not a snapshot to diff. */
  readonly get: () => GridViewportBox;
  /** Replace the box. Subscribers are notified only when the value actually changes. */
  readonly update: (next: (current: GridViewportBox) => GridViewportBox) => void;
  readonly subscribe: (listener: GridViewportListener) => () => void;
}

export function createGridViewportStore(initial: GridViewportBox = DEFAULT_GRID_VIEWPORT): GridViewportStore {
  let box = initial;
  const listeners = new Set<GridViewportListener>();
  return {
    get: () => box,
    update: (next) => {
      const candidate = next(box);
      // A pan already at the left edge, or a zoom already at the ceiling, changes nothing —
      // and a wheel held against either produces a stream of them. Comparing fields rather
      // than identity is what keeps that from waking every subscriber sixty times a second.
      if (
        candidate.scrollTicks === box.scrollTicks &&
        candidate.ticksPerPixel === box.ticksPerPixel &&
        candidate.rowHeight === box.rowHeight &&
        candidate.scrollRows === box.scrollRows &&
        candidate.topNote === box.topNote
      ) {
        return;
      }
      box = candidate;
      for (const listener of listeners) listener(box);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
