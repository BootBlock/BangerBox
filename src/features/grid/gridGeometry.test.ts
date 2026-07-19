import { describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@/core/project/schemas';
import {
  automationBounds,
  automationPolyline,
  automationValueToY,
  cellsAlongSegment,
  eventAtCell,
  eventAtPoint,
  eventsInTickSpan,
  nearestEventToTick,
  noteToRow,
  resizeHandleAtPoint,
  rowToNote,
  snapTick,
  tickToX,
  TOUCH_RESIZE_HANDLE_PX,
  velocityAtLaneY,
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

  it('widens the resize handle for touch (issue #43)', () => {
    // 'a' spans x 0..120. At the mouse handle 100 is the note body; a fingertip-sized
    // handle reaches it, so the tail of a note is grabbable without a mouse.
    expect(resizeHandleAtPoint(events, 100, 10, viewport)).toBeNull();
    expect(resizeHandleAtPoint(events, 100, 10, viewport, TOUCH_RESIZE_HANDLE_PX)?.id).toBe('a');
  });

  it('caps the touch handle at half a note, so short notes stay draggable (issue #43)', () => {
    // A 1/16 note at ticksPerPixel 4 is only 30 px wide — narrower than the touch handle.
    const short = [{ id: 'short', tickStart: 0, durationTicks: 120, note: 72, velocity: 100, extra: null }];
    // The front half moves…
    expect(resizeHandleAtPoint(short, 10, 10, viewport, TOUCH_RESIZE_HANDLE_PX)).toBeNull();
    // …and only the back half resizes.
    expect(resizeHandleAtPoint(short, 20, 10, viewport, TOUCH_RESIZE_HANDLE_PX)?.id).toBe('short');
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
    const events = [{ id: 'a', tickStart: 0, durationTicks: 480, note: 72, velocity: 100, extra: null }];
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

describe('gridGeometry — velocity lane dragging', () => {
  const LANE = 64;

  const bars = [
    { id: 'a', tickStart: 0, durationTicks: 120, note: 72, velocity: 100, extra: null },
    { id: 'b', tickStart: 120, durationTicks: 120, note: 72, velocity: 100, extra: null },
    { id: 'c', tickStart: 240, durationTicks: 120, note: 71, velocity: 100, extra: null },
    { id: 'd', tickStart: 960, durationTicks: 120, note: 71, velocity: 100, extra: null },
  ];

  it('maps the lane top to full velocity and the bottom to the audible floor', () => {
    expect(velocityAtLaneY(4, LANE)).toBe(127);
    expect(velocityAtLaneY(LANE - 4, LANE)).toBe(1);
    expect(velocityAtLaneY(LANE / 2, LANE)).toBeCloseTo(64, -1);
  });

  /** A drag that overshoots the lane must not write a silent note, nor exceed 127. */
  it('clamps beyond the lane rather than emitting 0 or >127', () => {
    expect(velocityAtLaneY(-50, LANE)).toBe(127);
    expect(velocityAtLaneY(LANE + 50, LANE)).toBe(1);
  });

  it('grabs the nearest bar within tolerance, not the first stored', () => {
    // Tick 130 sits between bars 'a' (0) and 'b' (120); 'a' is stored first.
    expect(nearestEventToTick(bars, 130, 200)?.id).toBe('b');
    expect(nearestEventToTick(bars, 130, 5)).toBeNull();
  });

  it('sweeps every bar a sideways drag crossed, in timeline order', () => {
    expect(eventsInTickSpan(bars, 0, 240).map((event) => event.id)).toEqual(['a', 'b', 'c']);
    // Direction-agnostic: dragging right-to-left shapes the same run.
    expect(eventsInTickSpan(bars, 240, 0).map((event) => event.id)).toEqual(['a', 'b', 'c']);
  });

  /**
   * The press tolerance is deliberately *not* applied to the swept span. A drag that
   * stops on one bar must not also drag its close neighbour along with it.
   */
  it('does not over-reach past the end of the swept span', () => {
    expect(eventsInTickSpan(bars, 0, 119).map((event) => event.id)).toEqual(['a']);
    // A stationary (purely vertical) drag sweeps nothing; the anchor covers that case.
    expect(eventsInTickSpan(bars, 130, 130)).toEqual([]);
  });
});

describe('gridGeometry — automation lane (spec §7.8, §8.5.2)', () => {
  const point = (tick: number, value: number, curve: AutomationPoint['curve']): AutomationPoint => ({
    id: `p${tick}`,
    scope: 'track',
    ownerId: 't1',
    targetPath: 'volume',
    tick,
    value,
    curve,
  });

  it('scales to the values the lane actually holds, not an assumed range', () => {
    // A cutoff lane in hertz would flatten against the top of a 0..1 lane.
    expect(automationBounds([point(0, 200, 'linear'), point(960, 8000, 'linear')])).toEqual({
      min: 200,
      max: 8000,
    });
  });

  it('pads a flat lane so it draws down the middle rather than dividing by zero', () => {
    const bounds = automationBounds([point(0, 0.5, 'linear'), point(960, 0.5, 'linear')]);
    expect(bounds.max).toBeGreaterThan(bounds.min);
    expect(automationValueToY(0.5, bounds, 48)).toBeCloseTo(4 + 40 / 2);
  });

  it('maps the value range across the lane, inset by the 4 px margin', () => {
    const bounds = { min: 0, max: 1 };
    expect(automationValueToY(1, bounds, 48)).toBe(4);
    expect(automationValueToY(0, bounds, 48)).toBe(44);
    // Values outside the bounds clamp rather than drawing off the strip.
    expect(automationValueToY(2, bounds, 48)).toBe(4);
    expect(automationValueToY(-1, bounds, 48)).toBe(44);
  });

  it('holds a step span flat until it jumps at the next point', () => {
    const points = [point(0, 0, 'step'), point(400, 1, 'step')];
    const line = automationPolyline(points, viewport, { min: 0, max: 1 }, 48);
    // The held span shares the first point's y at the second point's x.
    expect(line[0]).toEqual({ x: 0, y: 44 });
    expect(line[1]).toEqual({ x: 100, y: 44 });
    expect(line[2]).toEqual({ x: 100, y: 4 });
  });

  it('runs a linear span straight between its two points', () => {
    const line = automationPolyline(
      [point(0, 0, 'linear'), point(400, 1, 'linear')],
      viewport,
      { min: 0, max: 1 },
      48,
    );
    // No intermediate samples: two points and the flat tail past the last one.
    expect(line.slice(0, 2)).toEqual([
      { x: 0, y: 44 },
      { x: 100, y: 4 },
    ]);
  });

  it('samples an exp span so it is visibly a curve, not a straight line', () => {
    const line = automationPolyline(
      [point(0, 0, 'exp'), point(400, 1, 'exp')],
      viewport,
      { min: 0, max: 1 },
      48,
    );
    const midpoint = line.find((sample) => sample.x === 50);
    const straight = automationValueToY(0.5, { min: 0, max: 1 }, 48);
    // A squared ease sits below the straight line at the halfway mark (larger y = lower).
    expect(midpoint!.y).toBeGreaterThan(straight);
  });

  it("extends the last point's value to the right edge, since it stays in force", () => {
    const line = automationPolyline([point(0, 1, 'linear')], viewport, { min: 0, max: 1 }, 48);
    expect(line).toEqual([
      { x: 0, y: 4 },
      { x: viewport.width, y: 4 },
    ]);
  });

  it('draws nothing for an empty lane', () => {
    expect(automationPolyline([], viewport, { min: 0, max: 1 }, 48)).toEqual([]);
  });
});
