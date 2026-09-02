import { describe, expect, it } from 'vitest';
import type { AutomationPoint } from '@/core/project/schemas';
import {
  automationRampForWindow,
  automationValueAt,
  mergeRecordedPoint,
  resolveEffectivePoints,
  shouldRecordSample,
} from './automation';

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

describe('shouldRecordSample (spec §7.8 thinning)', () => {
  const limits = { minTickSpacing: 120, valueEpsilon: 0.005 };

  it('always records the first sample of a pass', () => {
    expect(shouldRecordSample(null, 0, 0, limits)).toBe(true);
  });

  it('refuses a sample closer than the minimum tick spacing', () => {
    expect(shouldRecordSample({ tick: 0, value: 0 }, 119, 1, limits)).toBe(false);
    expect(shouldRecordSample({ tick: 0, value: 0 }, 120, 1, limits)).toBe(true);
  });

  it('refuses a sample that has not moved by the value epsilon', () => {
    expect(shouldRecordSample({ tick: 0, value: 0.5 }, 480, 0.5004, limits)).toBe(false);
    expect(shouldRecordSample({ tick: 0, value: 0.5 }, 480, 0.505, limits)).toBe(true);
  });

  it('measures the value move in either direction', () => {
    expect(shouldRecordSample({ tick: 0, value: 0.5 }, 480, 0.49, limits)).toBe(true);
  });

  it('refuses a sample at or behind the previous tick, so a loop wrap cannot write backwards', () => {
    expect(shouldRecordSample({ tick: 500, value: 0 }, 500, 1, limits)).toBe(false);
    expect(shouldRecordSample({ tick: 500, value: 0 }, 10, 1, limits)).toBe(false);
  });
});

describe('mergeRecordedPoint (spec §7.8)', () => {
  it('replaces only its own tick when it opens a pass', () => {
    const lane = [point(0, 0.1), point(480, 0.2), point(960, 0.3)];
    const merged = mergeRecordedPoint(lane, point(480, 0.9), null);
    expect(merged.map((p) => [p.tick, p.value])).toEqual([
      [0, 0.1],
      [480, 0.9],
      [960, 0.3],
    ]);
  });

  it('overwrites the span the pass has just swept', () => {
    const lane = [point(0, 0.1), point(240, 0.2), point(480, 0.3), point(960, 0.4)];
    const merged = mergeRecordedPoint(lane, point(600, 0.9), 120);
    // 240 and 480 fell inside (120, 600] and are replaced by the single new point.
    expect(merged.map((p) => [p.tick, p.value])).toEqual([
      [0, 0.1],
      [600, 0.9],
      [960, 0.4],
    ]);
  });

  it('leaves the sweep start itself alone', () => {
    const lane = [point(120, 0.5)];
    const merged = mergeRecordedPoint(lane, point(240, 0.9), 120);
    expect(merged.map((p) => p.tick)).toEqual([120, 240]);
  });

  it('keeps the lane in tick order', () => {
    const lane = [point(960, 0.4)];
    const merged = mergeRecordedPoint(lane, point(120, 0.9), null);
    expect(merged.map((p) => p.tick)).toEqual([120, 960]);
  });
});
