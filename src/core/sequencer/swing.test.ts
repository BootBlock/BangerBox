import { describe, expect, it } from 'vitest';
import { PPQN } from '@/core/constants';
import { applySwing, swingDivisionTicks, swingOffsetTicks } from './swing';

describe('swingDivisionTicks (spec §7.4)', () => {
  it('maps the swing division to its note length in ticks', () => {
    expect(swingDivisionTicks(8)).toBe(PPQN / 2); // 1/8
    expect(swingDivisionTicks(16)).toBe(PPQN / 4); // 1/16
  });
});

describe('swingOffsetTicks (spec §7.4)', () => {
  it('is zero at 50 % regardless of position', () => {
    expect(swingOffsetTicks(0, 50, 16)).toBe(0);
    expect(swingOffsetTicks(PPQN / 4, 50, 16)).toBe(0);
    expect(swingOffsetTicks(3 * (PPQN / 4), 50, 16)).toBe(0);
  });

  it('never swings on-beat (even 0-based) subdivisions', () => {
    // 1/16 grid: subdivisions 0, 2, 4 … are on-beat.
    expect(swingOffsetTicks(0, 62, 16)).toBe(0);
    expect(swingOffsetTicks(2 * (PPQN / 4), 62, 16)).toBe(0);
  });

  it('delays odd off-beat subdivisions by the MPC formula', () => {
    const div = PPQN / 4; // 240
    // 75 %: offset = (25/50) × (240/2) = 60 ticks.
    expect(swingOffsetTicks(div, 75, 16)).toBe(60);
    expect(swingOffsetTicks(3 * div, 75, 16)).toBe(60);
    // 62 %: offset = (12/50) × 120 = 28.8 → 29 ticks (rounded).
    expect(swingOffsetTicks(div, 62, 16)).toBe(Math.round((12 / 50) * 120));
  });

  it('honours the 1/8 swing division', () => {
    const div = PPQN / 2; // 480
    // 75 %: offset = 0.5 × 240 = 120 ticks on the off-beat eighth.
    expect(swingOffsetTicks(div, 75, 8)).toBe(120);
    expect(swingOffsetTicks(2 * div, 75, 8)).toBe(0); // on-beat
  });

  it('attributes near-grid recorded timing to its nearest subdivision', () => {
    const div = PPQN / 4;
    // A few ticks past the odd subdivision still swings with that slot.
    expect(swingOffsetTicks(div + 5, 75, 16)).toBe(60);
  });
});

describe('applySwing (spec §7.4)', () => {
  it('adds the offset and never moves an event earlier', () => {
    const div = PPQN / 4;
    expect(applySwing(div, 75, 16)).toBe(div + 60);
    expect(applySwing(0, 75, 16)).toBe(0);
    expect(applySwing(div, 50, 16)).toBe(div);
  });
});
