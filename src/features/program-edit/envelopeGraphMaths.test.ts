import { describe, expect, it } from 'vitest';
import type { AhdsrEnvelope } from '@/core/project/schemas';
import {
  MAX_TIME_MS,
  describeEnvelope,
  envelopeJoints,
  envelopePolyline,
  envelopeScale,
  shapeProgress,
  spanToTime,
  timeFromDrag,
  timeToSpan,
} from './envelopeGraphMaths';

const ENVELOPE: AhdsrEnvelope = {
  attack: 10,
  hold: 0,
  decay: 200,
  sustain: 0.6,
  release: 300,
  curve: 'exponential',
};

const WIDTH = 384;
const HEIGHT = 104;

describe('envelope time taper (spec §8.5.5)', () => {
  it('pins both ends of the 0..20 s range', () => {
    expect(timeToSpan(0)).toBe(0);
    expect(timeToSpan(MAX_TIME_MS)).toBeCloseTo(1, 10);
    expect(spanToTime(0)).toBe(0);
    expect(spanToTime(1)).toBe(MAX_TIME_MS);
  });

  it('round-trips a time through the taper', () => {
    for (const ms of [0, 1, 20, 100, 1000, 5000, MAX_TIME_MS]) {
      expect(spanToTime(timeToSpan(ms))).toBe(ms);
    }
  });

  it('gives short times a usable share of the axis — the whole point of the taper', () => {
    // Linearly, 1 ms would land at 0.00005 of the width: unreachable next to a 20 s release.
    expect(timeToSpan(1)).toBeGreaterThan(0.02);
    expect(timeToSpan(100)).toBeGreaterThan(0.3);
    expect(timeToSpan(1000)).toBeLessThan(0.7);
  });

  it('is monotonic and clamps out-of-range input', () => {
    expect(timeToSpan(50)).toBeLessThan(timeToSpan(51));
    expect(timeToSpan(-100)).toBe(0);
    expect(timeToSpan(MAX_TIME_MS * 2)).toBeCloseTo(1, 10);
    expect(spanToTime(-1)).toBe(0);
    expect(spanToTime(2)).toBe(MAX_TIME_MS);
  });
});

describe('segment shaping', () => {
  it('leaves a linear segment straight', () => {
    expect(shapeProgress(0.25, 'linear')).toBe(0.25);
    expect(shapeProgress(0.5, 'linear')).toBe(0.5);
  });

  it('makes an exponential segment move fast then ease in', () => {
    expect(shapeProgress(0, 'exponential')).toBe(0);
    expect(shapeProgress(1, 'exponential')).toBeCloseTo(1, 10);
    // Half way through the segment, most of the travel is already done.
    expect(shapeProgress(0.5, 'exponential')).toBeGreaterThan(0.85);
    expect(shapeProgress(0.25, 'exponential')).toBeGreaterThan(0.25);
  });

  it('clamps progress outside the segment', () => {
    expect(shapeProgress(-1, 'exponential')).toBe(0);
    expect(shapeProgress(2, 'linear')).toBe(1);
  });
});

describe('envelope geometry', () => {
  const scale = envelopeScale(ENVELOPE, WIDTH);
  const joints = envelopeJoints(ENVELOPE, scale, HEIGHT);

  it('lays the six joints out left to right across the full width', () => {
    expect(joints).toHaveLength(6);
    for (let i = 1; i < joints.length; i++) {
      expect(joints[i]!.x).toBeGreaterThan(joints[i - 1]!.x);
    }
    expect(joints[0]!.x).toBe(0);
    expect(joints[5]!.x).toBeCloseTo(WIDTH, 6);
  });

  it('starts and ends at silence, peaks at full level, and holds flat', () => {
    expect(joints[0]!.y).toBe(HEIGHT);
    expect(joints[5]!.y).toBe(HEIGHT);
    expect(joints[1]!.y).toBe(0);
    expect(joints[2]!.y).toBe(0);
    // Sustain is a level, so its two joints sit at the same height.
    expect(joints[3]!.y).toBeCloseTo(HEIGHT * 0.4, 10);
    expect(joints[4]!.y).toBe(joints[3]!.y);
  });

  it('keeps a zero-length stage grabbable rather than stacked on its neighbour', () => {
    // `hold` is 0 ms here; its handle must still be a finger's width from the attack peak.
    expect(joints[2]!.x - joints[1]!.x).toBeGreaterThan(10);
  });

  it('scales a longer stage wider, tapered rather than linear', () => {
    const longer = envelopeJoints(
      { ...ENVELOPE, decay: 2000 },
      envelopeScale({ ...ENVELOPE, decay: 2000 }, WIDTH),
      HEIGHT,
    );
    const decayWidth = (points: typeof joints) => points[3]!.x - points[2]!.x;
    expect(decayWidth(longer)).toBeGreaterThan(decayWidth(joints));
    // Ten times the time is nowhere near ten times the width — that is the taper working.
    expect(decayWidth(longer)).toBeLessThan(decayWidth(joints) * 3);
  });

  it('inverts a drag back into the time that produced the joint', () => {
    expect(timeFromDrag(joints[1]!.x, joints[0]!.x, scale)).toBe(ENVELOPE.attack);
    expect(timeFromDrag(joints[3]!.x, joints[2]!.x, scale)).toBe(ENVELOPE.decay);
    expect(timeFromDrag(joints[5]!.x, joints[4]!.x, scale)).toBe(ENVELOPE.release);
    // Dragging a handle back onto its own segment start is 0 ms, not the floor's worth of time.
    expect(timeFromDrag(joints[2]!.x, joints[2]!.x, scale)).toBe(0);
    expect(timeFromDrag(-500, 0, scale)).toBe(0);
  });
});

describe('envelope polyline', () => {
  it('bends an exponential decay away from the straight line between its ends', () => {
    const joints = envelopeJoints(ENVELOPE, envelopeScale(ENVELOPE, WIDTH), HEIGHT);
    const decayMidX = (joints[2]!.x + joints[3]!.x) / 2;
    const straightY = (joints[2]!.y + joints[3]!.y) / 2;
    const sample = (envelope: AhdsrEnvelope) => {
      const points = envelopePolyline(envelope, joints);
      const nearest = points.reduce((best, point) =>
        Math.abs(point.x - decayMidX) < Math.abs(best.x - decayMidX) ? point : best,
      );
      return nearest.y;
    };
    // Canvas y grows downward, so a faster fall means a *larger* y at the midpoint.
    expect(sample(ENVELOPE)).toBeGreaterThan(straightY);
    expect(sample({ ...ENVELOPE, curve: 'linear' })).toBeCloseTo(straightY, 0);
  });

  it('runs from the origin to silence and never doubles back', () => {
    const joints = envelopeJoints(ENVELOPE, envelopeScale(ENVELOPE, WIDTH), HEIGHT);
    const points = envelopePolyline(ENVELOPE, joints);
    expect(points[0]).toEqual(joints[0]);
    expect(points[points.length - 1]).toEqual(joints[5]);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.x).toBeGreaterThanOrEqual(points[i - 1]!.x);
    }
  });
});

describe('describeEnvelope (spec §8.2)', () => {
  it('states every parameter in words', () => {
    const text = describeEnvelope(ENVELOPE, 'Amp envelope');
    expect(text).toContain('Amp envelope');
    expect(text).toContain('attack 10 ms');
    expect(text).toContain('sustain 60%');
    expect(text).toContain('release 300 ms');
    expect(text).toContain('exponential curve');
  });
});
