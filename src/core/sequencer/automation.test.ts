import { describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@/core/project/schemas';
import { automationRampForWindow, automationValueAt, resolveEffectivePoints } from './automation';

function point(
  tick: number,
  value: number,
  curve: AutomationPoint['curve'] = 'linear',
  scope: AutomationPoint['scope'] = 'sequence',
): AutomationPoint {
  return {
    id: `${scope}-${tick}`,
    scope,
    ownerId: 'o',
    targetPath: 'mixer.master.level',
    tick,
    value,
    curve,
  };
}

describe('automationValueAt (spec §7.8)', () => {
  it('returns null for an empty lane', () => {
    expect(automationValueAt([], 100)).toBeNull();
  });

  it('holds before the first and after the last point', () => {
    const points = [point(100, 0.2), point(300, 0.8)];
    expect(automationValueAt(points, 0)).toBe(0.2);
    expect(automationValueAt(points, 100)).toBe(0.2);
    expect(automationValueAt(points, 500)).toBe(0.8);
  });

  it('interpolates linearly within a segment', () => {
    const points = [point(0, 0), point(100, 1, 'linear')];
    expect(automationValueAt(points, 50)).toBeCloseTo(0.5, 9);
    expect(automationValueAt(points, 25)).toBeCloseTo(0.25, 9);
  });

  it('holds a step segment at the earlier value', () => {
    const points = [point(0, 0.3, 'step'), point(100, 0.9, 'step')];
    expect(automationValueAt(points, 50)).toBe(0.3);
    expect(automationValueAt(points, 99)).toBe(0.3);
    expect(automationValueAt(points, 100)).toBe(0.9);
  });

  it('interpolates exponentially between positive values', () => {
    const points = [point(0, 0.25, 'exp'), point(100, 1, 'exp')];
    // 0.25 × (1/0.25)^0.5 = 0.25 × 2 = 0.5.
    expect(automationValueAt(points, 50)).toBeCloseTo(0.5, 9);
  });

  it('falls back to linear when an exp segment touches a non-positive value', () => {
    const points = [point(0, 0, 'exp'), point(100, 1, 'exp')];
    expect(automationValueAt(points, 50)).toBeCloseTo(0.5, 9);
  });
});

describe('resolveEffectivePoints (spec §7.8 track wins)', () => {
  const trackPts = [point(0, 1, 'linear', 'track')];
  const seqPts = [point(0, 0.5, 'linear', 'sequence')];

  it('prefers track scope when it has points', () => {
    expect(resolveEffectivePoints(trackPts, seqPts)).toBe(trackPts);
  });

  it('falls back to sequence scope when track is empty or absent', () => {
    expect(resolveEffectivePoints([], seqPts)).toBe(seqPts);
    expect(resolveEffectivePoints(undefined, seqPts)).toBe(seqPts);
    expect(resolveEffectivePoints(undefined, undefined)).toEqual([]);
  });
});

describe('automationRampForWindow (spec §7.8 lookahead emission)', () => {
  const points = [point(0, 0), point(960, 1, 'linear')];
  const tickToSeconds = (tick: number) => tick / 960; // 1 s per quarter for the test

  it('ramps toward the value at the window trailing edge', () => {
    const ramp = automationRampForWindow('mixer.master.level', points, 0, 480, tickToSeconds);
    expect(ramp).toEqual({
      targetPath: 'mixer.master.level',
      value: 0.5, // value at tick 480
      when: 0,
      rampEnd: 0.5,
    });
  });

  it('emits nothing for an empty lane or an empty window', () => {
    expect(automationRampForWindow('t', [], 0, 480, tickToSeconds)).toBeNull();
    expect(automationRampForWindow('t', points, 480, 480, tickToSeconds)).toBeNull();
  });
});
