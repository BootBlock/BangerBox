import { describe, expect, it } from 'vitest';
import {
  eventAtPoint,
  noteToRow,
  resizeHandleAtPoint,
  rowToNote,
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
