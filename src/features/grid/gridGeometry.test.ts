import { describe, expect, it } from 'vitest';
import {
  cellsAlongSegment,
  eventAtCell,
  eventAtPoint,
  noteToRow,
  resizeHandleAtPoint,
  rowToNote,
  snapTick,
  tickToX,
  visibleRows,
  xToTick,
  type GridViewport,
} from './gridGeometry';

const viewport: GridViewport = {
  width: 800,
  height: 400,
  scrollTicks: 0,
  ticksPerPixel: 4, // 800 px spans 3200 ticks
  rowHeight: 20,
  scrollRows: 0,
  topNote: 72,
};

describe('gridGeometry — tick ↔ x (spec §8.5.2 zoom/scroll)', () => {
  it('maps the viewport origin to x = 0', () => {
    expect(tickToX(0, viewport)).toBe(0);
    expect(xToTick(0, viewport)).toBe(0);
  });

  it('scales by ticksPerPixel', () => {
    expect(tickToX(400, viewport)).toBe(100);
    expect(xToTick(100, viewport)).toBe(400);
  });

  it('honours horizontal scroll', () => {
    const scrolled = { ...viewport, scrollTicks: 960 };
    expect(tickToX(960, scrolled)).toBe(0);
    expect(tickToX(1920, scrolled)).toBe(240);
    expect(xToTick(240, scrolled)).toBe(1920);
  });

  it('round-trips a tick through x at any zoom', () => {
    for (const ticksPerPixel of [1, 2, 8, 16]) {
      const zoomed = { ...viewport, ticksPerPixel };
      expect(xToTick(tickToX(1440, zoomed), zoomed)).toBeCloseTo(1440);
    }
  });

  it('never returns a negative tick — the grid starts at zero', () => {
    expect(xToTick(-50, viewport)).toBe(0);
  });
});

describe('gridGeometry — note ↔ row', () => {
  it('places the top note in the first row', () => {
    expect(noteToRow(72, viewport)).toBe(0);
    expect(rowToNote(0, viewport)).toBe(72);
  });

  it('descends by semitone down the rows (piano-roll convention)', () => {
    expect(noteToRow(71, viewport)).toBe(1);
    expect(rowToNote(1, viewport)).toBe(71);
    expect(rowToNote(12, viewport)).toBe(60);
  });

  it('lists exactly the rows the viewport can show', () => {
    // 400 px tall / 20 px rows = 20 rows.
    const rows = visibleRows(viewport);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toBe(72);
    expect(rows[19]).toBe(53);
  });

  it('clamps notes to the MIDI range', () => {
    expect(rowToNote(200, viewport)).toBe(0);
    expect(rowToNote(-200, viewport)).toBe(127);
  });
});

describe('gridGeometry — hit testing (spec §8.5.2 draw/erase/select/move/resize)', () => {
  const events = [
    { id: 'a', tickStart: 0, durationTicks: 480, note: 72, velocity: 100, extra: null },
    { id: 'b', tickStart: 960, durationTicks: 480, note: 60, velocity: 80, extra: null },
  ];

  it('finds the event under a point', () => {
    // Event 'a' spans ticks 0..480 → x 0..120, on row 0 → y 0..20.
    expect(eventAtPoint(events, 50, 10, viewport)?.id).toBe('a');
    expect(eventAtPoint(events, 250, 250, viewport)?.id).toBe('b');
  });

  it('returns null on empty grid space', () => {
    expect(eventAtPoint(events, 400, 10, viewport)).toBeNull();
    // Right row, but past the end of the note.
    expect(eventAtPoint(events, 130, 10, viewport)).toBeNull();
  });

  it('returns null when the point is on the wrong row', () => {
    expect(eventAtPoint(events, 50, 30, viewport)).toBeNull();
  });

  it('detects the resize handle near an event end', () => {
    // 'a' ends at tick 480 → x 120; the handle is the last few pixels.
    expect(resizeHandleAtPoint(events, 118, 10, viewport)?.id).toBe('a');
    // The body of the note is a move target, not a resize target.
    expect(resizeHandleAtPoint(events, 40, 10, viewport)).toBeNull();
  });

  it('prefers the topmost (last) event when two overlap', () => {
    const overlapping = [
      { id: 'under', tickStart: 0, durationTicks: 480, note: 72, velocity: 100, extra: null },
      { id: 'over', tickStart: 0, durationTicks: 480, note: 72, velocity: 100, extra: null },
    ];
    expect(eventAtPoint(overlapping, 50, 10, viewport)?.id).toBe('over');
  });
});

describe('gridGeometry — paint strokes (issue #91: drag to draw)', () => {
  // At ticksPerPixel 4, a 1/16 snap of 120 ticks is 30 px wide; rows are 20 px tall.
  const SNAP_16 = 120;

  it('snaps a tick to the grid, and only rounds when snapping is off', () => {
    expect(snapTick(140, SNAP_16)).toBe(120);
    expect(snapTick(190, SNAP_16)).toBe(240);
    expect(snapTick(140.6, 0)).toBe(141);
  });

  it('returns the single cell under a stationary press', () => {
    const cells = cellsAlongSegment({ x: 10, y: 10 }, { x: 10, y: 10 }, viewport, SNAP_16);
    expect(cells).toEqual([{ note: 72, tick: 0 }]);
  });

  it('walks every cell a horizontal drag crosses', () => {
    // x 0 → 120 spans ticks 0..480, i.e. four 1/16 cells on the top row.
    const cells = cellsAlongSegment({ x: 0, y: 10 }, { x: 120, y: 10 }, viewport, SNAP_16);
    expect(cells).toEqual([
      { note: 72, tick: 0 },
      { note: 72, tick: 120 },
      { note: 72, tick: 240 },
      { note: 72, tick: 360 },
      { note: 72, tick: 480 },
    ]);
  });

  it('skips no cell when the pointer jumps a long way in one sample', () => {
    // A fast swipe reports few samples; the segment must still be filled in.
    const cells = cellsAlongSegment({ x: 0, y: 10 }, { x: 600, y: 10 }, viewport, SNAP_16);
    const ticks = cells.map((cell) => cell.tick);
    for (let index = 1; index < ticks.length; index += 1) {
      expect(ticks[index]! - ticks[index - 1]!).toBe(SNAP_16);
    }
  });

  it('crosses rows on a vertical drag', () => {
    const cells = cellsAlongSegment({ x: 10, y: 10 }, { x: 10, y: 50 }, viewport, SNAP_16);
    expect(cells.map((cell) => cell.note)).toEqual([72, 71, 70]);
  });

  it('finds the event occupying a cell, matching eventAtPoint', () => {
    const events = [
      { id: 'a', tickStart: 0, durationTicks: 480, note: 72, velocity: 100, extra: null },
    ];
    expect(eventAtCell(events, 72, 240)?.id).toBe('a');
    // Past the note's end, and on the wrong row.
    expect(eventAtCell(events, 72, 480)).toBeNull();
    expect(eventAtCell(events, 71, 240)).toBeNull();
  });
});

describe('gridGeometry — toggling (issue #92: tap a note to clear it)', () => {
  const SNAP_16 = 120;

  /**
   * Why GridCanvas hit-tests by point *and* by cell. Drawing snaps the new note to the
   * cell boundary, which can start it to the right of the tap that made it — leaving the
   * pointer outside the note's own rect. The rect test alone then misses a note that is
   * plainly under the cursor, so the tap paints instead of toggling it back off.
   */
  it('a note drawn by a tap can start right of that tap', () => {
    // A tap at x = 26 is tick 104, which snaps up to 120 — right of where it was tapped.
    const tapX = 26;
    const drawnTick = snapTick(xToTick(tapX, viewport), SNAP_16);
    expect(drawnTick).toBe(120);
    expect(drawnTick).toBeGreaterThan(xToTick(tapX, viewport));

    const drawn = [
      { id: 'a', tickStart: drawnTick, durationTicks: 120, note: 72, velocity: 100, extra: null },
    ];
    // The rect test misses it; the cell test — the fallback — finds it.
    expect(eventAtPoint(drawn, tapX, 10, viewport)).toBeNull();
    expect(eventAtCell(drawn, rowToNote(0, viewport), drawnTick)?.id).toBe('a');
  });
});
