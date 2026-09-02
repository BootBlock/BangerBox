import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import type { TimeSignature } from '@/core/project/schemas';
import {
  barsToTicks,
  noteDivisionSeconds,
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

describe('noteDivisionSeconds (spec §6 LFO sync, §5.7 synced delay, §7.2)', () => {
  // At 60 bpm a quarter note is exactly one second, so a division's seconds ARE its length
  // in quarter notes — which makes each expectation readable as musical arithmetic.
  const beats = (division: Parameters<typeof noteDivisionSeconds>[0]) => noteDivisionSeconds(division, 60);

  it('spans a whole note, and halves with each step down', () => {
    expect(beats('1/1')).toBeCloseTo(4, 9);
    expect(beats('1/2')).toBeCloseTo(2, 9);
    expect(beats('1/4')).toBeCloseTo(1, 9);
    expect(beats('1/8')).toBeCloseTo(0.5, 9);
    expect(beats('1/16')).toBeCloseTo(0.25, 9);
    expect(beats('1/32')).toBeCloseTo(0.125, 9);
  });

  it('makes a dotted division half again as long', () => {
    expect(beats('1/4.')).toBeCloseTo(1.5, 9);
    expect(beats('1/8.')).toBeCloseTo(0.75, 9);
    expect(beats('1/2.')).toBeCloseTo(3, 9);
  });

  it('fits three triplets in the space of two straight divisions', () => {
    expect(beats('1/8T') * 3).toBeCloseTo(beats('1/8') * 2, 9);
    expect(beats('1/16T') * 3).toBeCloseTo(beats('1/16') * 2, 9);
    // Three eighth-note triplets therefore fill exactly one quarter note.
    expect(beats('1/8T') * 3).toBeCloseTo(1, 9);
  });

  it('scales with the tempo through the §7.2 relation', () => {
    // At 120 bpm a quarter note is 0.5 s, so an eighth is 0.25 s and a dotted eighth 0.375 s.
    expect(noteDivisionSeconds('1/4', 120)).toBeCloseTo(0.5, 9);
    expect(noteDivisionSeconds('1/8', 120)).toBeCloseTo(0.25, 9);
    expect(noteDivisionSeconds('1/8.', 120)).toBeCloseTo(0.375, 9);
    expect(noteDivisionSeconds('1/4', 240)).toBeCloseTo(0.25, 9);
  });
});
