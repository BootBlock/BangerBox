import { describe, expect, it } from 'vitest';
import {
  coverageByNote,
  describeZones,
  dragZoneEdge,
  editorMetrics,
  isBlackKey,
  keyLayout,
  laneAtY,
  moveZoneRange,
  noteAtX,
  noteSpanX,
  uncoveredRanges,
  whiteKeyCount,
} from './keyZoneLayout';

const RANGE = [0, 127] as const;

describe('keyboard layout (spec §8.5.5)', () => {
  it('names the black keys of an octave', () => {
    const blacks = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71].filter(isBlackKey);
    expect(blacks).toEqual([61, 63, 66, 68, 70]);
  });

  it('counts seven white keys per octave', () => {
    expect(whiteKeyCount(60, 71)).toBe(7);
    expect(whiteKeyCount(0, 127)).toBe(75);
  });

  it('tiles the whites edge to edge and centres the blacks on the joins', () => {
    const keys = keyLayout(60, 71, 700); // 7 whites → 100 wide each
    const whites = keys.filter((key) => !key.black);
    expect(whites.map((key) => key.x)).toEqual([0, 100, 200, 300, 400, 500, 600]);
    expect(whites.every((key) => key.width === 100)).toBe(true);

    const cSharp = keys.find((key) => key.note === 61)!;
    expect(cSharp.black).toBe(true);
    expect(cSharp.x + cSharp.width / 2).toBeCloseTo(100); // the C/D join
    expect(cSharp.width).toBeLessThan(100);
  });

  it('maps x back to the note, black keys winning where they overlap', () => {
    const width = 700;
    expect(noteAtX(5, 60, 71, width)).toBe(60); // left of C, clear of C♯
    expect(noteAtX(100, 60, 71, width)).toBe(61); // on the C/D join → C♯
    expect(noteAtX(250, 60, 71, width)).toBe(64); // mid-E, no black above it
    expect(noteAtX(-50, 60, 71, width)).toBe(60);
    expect(noteAtX(9999, 60, 71, width)).toBe(71);
  });

  it('spans a zone from the left of its low key to the right of its high key', () => {
    const span = noteSpanX(60, 62, 60, 71, 700);
    expect(span.left).toBe(0);
    expect(span.right).toBe(200);
  });

  it('clamps a span whose notes fall outside the drawn range', () => {
    const span = noteSpanX(-20, 999, 0, 127, 750);
    expect(span.left).toBe(0);
    expect(span.right).toBeCloseTo(750);
  });
});

describe('zone drag rules (spec §6 lowNote <= highNote)', () => {
  const zone = { lowNote: 60, highNote: 72 };

  it('moves the edge that was grabbed', () => {
    expect(dragZoneEdge(zone, 'low', 55, RANGE)).toEqual({ lowNote: 55, highNote: 72 });
    expect(dragZoneEdge(zone, 'high', 80, RANGE)).toEqual({ lowNote: 60, highNote: 80 });
  });

  it('clamps at the opposite edge instead of inverting the zone', () => {
    expect(dragZoneEdge(zone, 'low', 90, RANGE)).toEqual({ lowNote: 72, highNote: 72 });
    expect(dragZoneEdge(zone, 'high', 10, RANGE)).toEqual({ lowNote: 60, highNote: 60 });
  });

  it('keeps edges inside NOTE_RANGE', () => {
    expect(dragZoneEdge(zone, 'low', -40, RANGE)).toEqual({ lowNote: 0, highNote: 72 });
    expect(dragZoneEdge(zone, 'high', 400, RANGE)).toEqual({ lowNote: 60, highNote: 127 });
  });

  it('slides a zone without changing its width, stopping at the ends', () => {
    expect(moveZoneRange(zone, 5, RANGE)).toEqual({ lowNote: 65, highNote: 77 });
    expect(moveZoneRange(zone, -100, RANGE)).toEqual({ lowNote: 0, highNote: 12 });
    expect(moveZoneRange(zone, 100, RANGE)).toEqual({ lowNote: 115, highNote: 127 });
  });
});

describe('coverage (spec §8.5.5 — overlaps and silent keys must be visible)', () => {
  const zones = [
    { lowNote: 60, highNote: 65 },
    { lowNote: 64, highNote: 67 },
  ];

  it('counts how many zones play each note', () => {
    const coverage = coverageByNote(zones, 60, 67);
    expect(coverage).toEqual([1, 1, 1, 1, 2, 2, 1, 1]);
  });

  it('reports the runs no zone covers, including the ends', () => {
    expect(uncoveredRanges(zones, 58, 70)).toEqual([
      { from: 58, to: 59 },
      { from: 68, to: 70 },
    ]);
  });

  it('reports the whole range when there are no zones', () => {
    expect(uncoveredRanges([], 60, 62)).toEqual([{ from: 60, to: 62 }]);
  });
});

describe('describeZones (spec §8.2 — note names, never MIDI numbers)', () => {
  it('names the zones, the overlap and the gaps', () => {
    const text = describeZones(
      [
        { lowNote: 60, highNote: 65, rootNote: 60 },
        { lowNote: 64, highNote: 71, rootNote: 67 },
      ],
      60,
      71,
    );
    expect(text).toContain('zone 1 C4 to F4, root C4');
    expect(text).toContain('zone 2 E4 to B4, root G4');
    expect(text).toContain('more than one zone');
    expect(text).toContain('Every note is covered');
    expect(text).not.toMatch(/\b60\b/);
  });

  it('names the silent stretch when one exists', () => {
    const text = describeZones([{ lowNote: 62, highNote: 63, rootNote: 62 }], 60, 65);
    expect(text).toContain('No zone covers C4 to C♯4, E4 to F4');
  });

  it('handles an empty program', () => {
    expect(describeZones([], 0, 127)).toBe('Key zone map: no zones.');
  });
});

describe('editor metrics', () => {
  it('stacks lanes, ribbon and keyboard without gaps', () => {
    const metrics = editorMetrics(100);
    expect(metrics.ribbonTop).toBeCloseTo(metrics.bandTop + metrics.bandHeight);
    expect(metrics.keyboardTop).toBeCloseTo(metrics.ribbonTop + metrics.ribbonHeight);
    expect(metrics.keyboardTop + metrics.keyboardHeight).toBeCloseTo(100);
  });

  it('resolves a y inside the band strip to one zone lane', () => {
    const metrics = editorMetrics(100);
    expect(laneAtY(1, 2, metrics)).toBe(0);
    expect(laneAtY(metrics.bandHeight - 1, 2, metrics)).toBe(1);
    expect(laneAtY(metrics.keyboardTop + 1, 2, metrics)).toBe(-1);
    expect(laneAtY(1, 0, metrics)).toBe(-1);
  });
});
