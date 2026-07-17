import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import {
  noteRepeatHits,
  noteRepeatStepTicks,
  repeatTicksInWindow,
  type HeldNote,
} from './noteRepeat';

describe('noteRepeatStepTicks (spec §7.3)', () => {
  it('derives straight and triplet step sizes', () => {
    expect(noteRepeatStepTicks({ value: 4, triplet: false })).toBe(PPQN); // 1/4
    expect(noteRepeatStepTicks({ value: 16, triplet: false })).toBe(PPQN / 4);
    expect(noteRepeatStepTicks({ value: 64, triplet: false })).toBe(PPQN / 16);
    expect(noteRepeatStepTicks({ value: 8, triplet: true })).toBe(((PPQN / 2) * 2) / 3); // 320
  });
});

describe('repeatTicksInWindow (spec §7.3)', () => {
  it('enumerates grid lines in the window, aligned to the bar origin', () => {
    const div = { value: 16, triplet: false } as const; // step 240
    expect(repeatTicksInWindow(0, 960, div)).toEqual([0, 240, 480, 720]);
  });

  it('includes a grid line exactly on the window start and excludes the end', () => {
    const div = { value: 8, triplet: false } as const; // step 480
    expect(repeatTicksInWindow(480, 1440, div)).toEqual([480, 960]);
  });

  it('starts at the first grid line at or after a mid-grid window start', () => {
    const div = { value: 16, triplet: false } as const; // step 240
    expect(repeatTicksInWindow(100, 600, div)).toEqual([240, 480]);
  });
});

describe('noteRepeatHits (spec §7.3)', () => {
  const held: HeldNote[] = [
    { note: 36, velocity: 100 },
    { note: 38, velocity: 80 },
  ];

  it('is empty when no pad is held', () => {
    expect(noteRepeatHits([], { value: 16, triplet: false }, 0, 960)).toEqual([]);
  });

  it('emits every held pad on each grid line at held velocity', () => {
    const hits = noteRepeatHits(held, { value: 8, triplet: false }, 0, 960);
    expect(hits).toEqual([
      { note: 36, velocity: 100, tick: 0 },
      { note: 38, velocity: 80, tick: 0 },
      { note: 36, velocity: 100, tick: 480 },
      { note: 38, velocity: 80, tick: 480 },
    ]);
  });

  it('applies a fixed velocity when provided', () => {
    const hits = noteRepeatHits([held[0]!], { value: 8, triplet: false }, 0, 480, 64);
    expect(hits).toEqual([{ note: 36, velocity: 64, tick: 0 }]);
  });
});
