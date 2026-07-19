import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import type { TimeSignature } from '@/core/project/schemas';
import {
  barsToTicks,
  secondsPerTick,
  secondsToTicks,
  tickToBarBeatTick,
  ticksPerBar,
  ticksPerBeat,
  ticksToSeconds,
} from './ppqn';

const FOUR_FOUR: TimeSignature = { numerator: 4, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };

describe('secondsPerTick (spec §7.2)', () => {
  it('matches the canonical 60 / (bpm × PPQN)', () => {
    expect(secondsPerTick(120)).toBeCloseTo(60 / (120 * PPQN), 12);
    // One quarter note (PPQN ticks) at 120 bpm is exactly 0.5 s.
    expect(secondsPerTick(120) * PPQN).toBeCloseTo(0.5, 12);
  });
});

describe('ticks ↔ seconds (spec §7.2)', () => {
  it('round-trips a tick count through seconds', () => {
    const ticks = 3210;
    const seconds = ticksToSeconds(ticks, 137);
    expect(secondsToTicks(seconds, 137)).toBeCloseTo(ticks, 9);
  });

  it('one bar of 4/4 at 120 bpm lasts two seconds', () => {
    expect(ticksToSeconds(ticksPerBar(FOUR_FOUR), 120)).toBeCloseTo(2, 12);
  });
});

describe('bar/beat geometry (spec §7.2)', () => {
  it('derives ticks per beat and bar from the denominator', () => {
    expect(ticksPerBeat(FOUR_FOUR)).toBe(PPQN); // quarter-note beat
    expect(ticksPerBar(FOUR_FOUR)).toBe(4 * PPQN);
    expect(ticksPerBeat(SIX_EIGHT)).toBe(PPQN / 2); // eighth-note beat
    expect(ticksPerBar(SIX_EIGHT)).toBe(6 * (PPQN / 2));
    expect(barsToTicks(2, THREE_FOUR)).toBe(2 * 3 * PPQN);
  });
});

describe('tickToBarBeatTick (spec §4.2 coarse readout)', () => {
  it('reports 1-based bar and beat with the tick within the beat', () => {
    expect(tickToBarBeatTick(0, FOUR_FOUR)).toEqual({ bar: 1, beat: 1, tick: 0 });
    expect(tickToBarBeatTick(-5, FOUR_FOUR)).toEqual({ bar: 1, beat: 1, tick: 0 });
    // One beat in.
    expect(tickToBarBeatTick(PPQN, FOUR_FOUR)).toEqual({ bar: 1, beat: 2, tick: 0 });
    // Start of bar 2.
    expect(tickToBarBeatTick(4 * PPQN, FOUR_FOUR)).toEqual({ bar: 2, beat: 1, tick: 0 });
    // Mid-beat remainder.
    expect(tickToBarBeatTick(4 * PPQN + PPQN + 240, FOUR_FOUR)).toEqual({
      bar: 2,
      beat: 2,
      tick: 240,
    });
  });

  it('honours the time signature when locating beats', () => {
    // 6/8: eighth-note beats, six per bar.
    expect(tickToBarBeatTick(PPQN / 2, SIX_EIGHT)).toEqual({ bar: 1, beat: 2, tick: 0 });
    expect(tickToBarBeatTick(6 * (PPQN / 2), SIX_EIGHT)).toEqual({ bar: 2, beat: 1, tick: 0 });
  });
});
