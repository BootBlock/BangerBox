import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import type { MidiEvent } from '@/core/project/schemas';
import { gridTicks, quantiseEvents, quantiseTick, snapTickToGrid } from './quantise';

function event(id: string, tickStart: number): MidiEvent {
  return { id, tickStart, durationTicks: 120, note: 36, velocity: 100, extra: null };
}

describe('gridTicks (spec §7.4)', () => {
  it('derives straight and triplet grid spacing', () => {
    expect(gridTicks({ division: 4, triplet: false })).toBe(PPQN); // 1/4
    expect(gridTicks({ division: 16, triplet: false })).toBe(PPQN / 4);
    // 1/8 triplet: three in the space of two eighths.
    expect(gridTicks({ division: 8, triplet: true })).toBeCloseTo(((PPQN / 2) * 2) / 3, 9);
  });
});

describe('snapTickToGrid (spec §7.4)', () => {
  it('snaps to the nearest grid line', () => {
    const grid = { division: 16, triplet: false } as const;
    expect(snapTickToGrid(10, grid)).toBe(0);
    expect(snapTickToGrid(130, grid)).toBe(PPQN / 4); // 240 nearest to 130
    expect(snapTickToGrid(PPQN / 4 - 5, grid)).toBe(PPQN / 4);
  });
});

describe('quantiseTick (spec §7.4)', () => {
  const grid = { division: 16, triplet: false } as const;

  it('at full strength lands exactly on the grid', () => {
    expect(quantiseTick(250, { grid, strength: 1 })).toBe(PPQN / 4); // 240
    expect(quantiseTick(5, { grid, strength: 1 })).toBe(0);
  });

  it('at zero strength leaves the tick unchanged', () => {
    expect(quantiseTick(253, { grid, strength: 0 })).toBe(253);
  });

  it('at partial strength interpolates toward the grid', () => {
    // tick 260, nearest grid 240, strength 0.5 → 260 + (240-260)*0.5 = 250.
    expect(quantiseTick(260, { grid, strength: 0.5 })).toBe(250);
  });

  it('bakes swing into the grid when requested', () => {
    // On-grid odd 1/16 subdivision (tick 240 = subdivision 1) swings +60 at 75 %.
    expect(quantiseTick(245, { grid, strength: 1, swingAmount: 75, swingDivision: 16 })).toBe(
      PPQN / 4 + 60,
    );
    // On-beat subdivision is unaffected by swing.
    expect(quantiseTick(5, { grid, strength: 1, swingAmount: 75, swingDivision: 16 })).toBe(0);
  });

  it('never returns a negative tick', () => {
    expect(quantiseTick(0, { grid, strength: 1 })).toBe(0);
  });
});

describe('quantiseEvents (spec §7.4)', () => {
  it('snaps all events, preserves durations, and returns tick order', () => {
    const input = [event('b', 260), event('a', 5)];
    const grid = { division: 16, triplet: false } as const;
    const out = quantiseEvents(input, { grid, strength: 1 });
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out[0]!.tickStart).toBe(0);
    expect(out[1]!.tickStart).toBe(PPQN / 4);
    expect(out[1]!.durationTicks).toBe(120); // duration preserved
    // Input not mutated.
    expect(input[0]!.tickStart).toBe(260);
  });
});
