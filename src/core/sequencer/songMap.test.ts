import { describe, expect, it } from 'vitest';
import { createDefaultSequence, type Sequence, type SongEntry } from '@/core/project/schemas';
import { ticksPerBar } from './ppqn';
import {
  buildSongMap,
  segmentAtSongTick,
  songSecondsToTick,
  songTickToSeconds,
  songTotalSeconds,
  songTotalTicks,
  songWindowSlices,
} from './songMap';

const BAR_4_4 = ticksPerBar({ numerator: 4, denominator: 4 }); // 3840

function seq(id: string, lengthBars: number, tempo: number | null): Sequence {
  return { ...createDefaultSequence('proj', 0, id, id), lengthBars, tempo };
}

const sequences: Record<string, Sequence> = {
  A: seq('A', 1, 120), // 3840 ticks @ 120 = 2 s per pass
  B: seq('B', 2, 60), // 7680 ticks @ 60 = 8 s per pass
};

function entry(id: string, position: number, sequenceId: string, repeats: number): SongEntry {
  return { id, position, sequenceId, repeats };
}

describe('buildSongMap (spec §7.9)', () => {
  it('flattens entries × repeats into contiguous segments with tick + second offsets', () => {
    const map = buildSongMap([entry('e1', 0, 'A', 2), entry('e2', 1, 'B', 1)], sequences, 100);
    expect(map).toHaveLength(3);
    expect(map[0]).toMatchObject({ entryIndex: 0, sequenceId: 'A', startTick: 0, startSeconds: 0, bpm: 120 });
    expect(map[1]).toMatchObject({ entryIndex: 0, startTick: BAR_4_4, startSeconds: 2 });
    expect(map[2]).toMatchObject({ entryIndex: 1, sequenceId: 'B', startTick: 2 * BAR_4_4, startSeconds: 4, bpm: 60 });
  });

  it('uses the project default tempo when a sequence tempo is null', () => {
    const withDefault = { X: seq('X', 1, null) };
    const map = buildSongMap([entry('e', 0, 'X', 1)], withDefault, 90);
    expect(map[0]!.bpm).toBe(90);
  });

  it('honours position order and skips entries with a missing sequence', () => {
    const map = buildSongMap(
      [entry('e2', 1, 'A', 1), entry('e1', 0, 'B', 1), entry('eX', 2, 'MISSING', 1)],
      sequences,
      100,
    );
    expect(map.map((s) => s.sequenceId)).toEqual(['B', 'A']);
  });
});

describe('song totals & conversion (spec §7.9)', () => {
  const map = buildSongMap([entry('e1', 0, 'A', 1), entry('e2', 1, 'B', 1)], sequences, 100);

  it('totals ticks and seconds across the tempo map', () => {
    expect(songTotalTicks(map)).toBe(BAR_4_4 + 2 * BAR_4_4); // A(1 bar) + B(2 bars)
    expect(songTotalSeconds(map)).toBeCloseTo(2 + 8, 9); // 2 s + 8 s
  });

  it('converts a song tick to seconds using the segment tempo', () => {
    expect(songTickToSeconds(map, 0)).toBe(0);
    expect(songTickToSeconds(map, BAR_4_4 / 2)).toBeCloseTo(1, 9); // half of A @120
    // Start of B, then one bar into B at 60 bpm (one bar of 4/4 @60 = 4 s).
    expect(songTickToSeconds(map, BAR_4_4)).toBeCloseTo(2, 9);
    expect(songTickToSeconds(map, BAR_4_4 + BAR_4_4)).toBeCloseTo(2 + 4, 9);
  });

  it('inverts seconds back to a song tick across the tempo map', () => {
    expect(songSecondsToTick(map, 0)).toBe(0);
    expect(songSecondsToTick(map, 1)).toBeCloseTo(BAR_4_4 / 2, 6); // 1 s into A @120
    expect(songSecondsToTick(map, 2)).toBeCloseTo(BAR_4_4, 6); // start of B
    expect(songSecondsToTick(map, 2 + 4)).toBeCloseTo(BAR_4_4 + BAR_4_4, 6); // one bar into B @60
    // Round-trip through seconds.
    expect(songSecondsToTick(map, songTickToSeconds(map, 3000))).toBeCloseTo(3000, 3);
  });

  it('locates the segment covering a song tick', () => {
    expect(segmentAtSongTick(map, 0)?.sequenceId).toBe('A');
    expect(segmentAtSongTick(map, BAR_4_4)?.sequenceId).toBe('B');
    expect(segmentAtSongTick(map, songTotalTicks(map))).toBeUndefined();
  });
});

describe('songWindowSlices (spec §7.9 boundary-spanning lookahead)', () => {
  const map = buildSongMap([entry('e1', 0, 'A', 1), entry('e2', 1, 'B', 1)], sequences, 100);

  it('splits a window straddling an entry boundary into per-segment slices', () => {
    // Window from 200 ticks before the boundary to 300 ticks after it.
    const slices = songWindowSlices(map, BAR_4_4 - 200, BAR_4_4 + 300);
    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({ seqFrom: BAR_4_4 - 200, seqTo: BAR_4_4 }); // tail of A
    expect(slices[0]!.segment.sequenceId).toBe('A');
    expect(slices[1]).toMatchObject({ seqFrom: 0, seqTo: 300 }); // head of B
    expect(slices[1]!.segment.sequenceId).toBe('B');
  });

  it('returns a single slice for a window inside one segment', () => {
    const slices = songWindowSlices(map, 100, 500);
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ seqFrom: 100, seqTo: 500 });
  });
});
