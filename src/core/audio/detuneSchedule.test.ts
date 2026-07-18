import { describe, expect, it } from 'vitest';
import {
  applyRetune,
  baseDetuneAt,
  consumedBetween,
  detuneAt,
  regionEndTime,
  type DetuneSchedule,
} from './detuneSchedule';

/**
 * An independent brute-force solve of the same integral at a much finer fixed step, so the
 * module is checked against the maths rather than against its own step scheme.
 */
function referenceEnd(cents: (time: number) => number, from: number, region: number): number {
  const step = 1e-5;
  let consumed = 0;
  let time = from;
  for (let i = 0; i < 1e8; i++) {
    const rate = 2 ** (cents(time + step / 2) / 1200);
    const chunk = rate * step;
    if (consumed + chunk >= region) return time + (region - consumed) / rate;
    consumed += chunk;
    time += step;
  }
  throw new Error('reference integration did not terminate');
}

function schedule(over: Partial<DetuneSchedule> = {}): DetuneSchedule {
  return { breakpoints: [{ time: 0, cents: 0 }], oscillations: [], ...over };
}

describe('detune schedule (spec §6)', () => {
  it('interpolates the base contour between breakpoints and holds it outside them', () => {
    const s = schedule({
      breakpoints: [
        { time: 1, cents: 0 },
        { time: 2, cents: 1200 },
      ],
    });
    expect(baseDetuneAt(s, 0.5)).toBe(0); // held before the first point
    expect(baseDetuneAt(s, 1.5)).toBe(600);
    expect(baseDetuneAt(s, 9)).toBe(1200); // held after the last
  });

  it('sums oscillations onto the base at the shape each oscillator actually renders', () => {
    const s = schedule({
      oscillations: [{ wave: 'square', rateHz: 1, amplitudeCents: 100, since: 0 }],
    });
    expect(detuneAt(s, 0.25)).toBe(100); // first half of the cycle is +1
    expect(detuneAt(s, 0.75)).toBe(-100);
  });
});

describe('region end time (spec §5.4 declick, issue #87)', () => {
  it('divides by the rate when the detune is constant', () => {
    const s = schedule({ breakpoints: [{ time: 0, cents: 1200 }] });
    expect(regionEndTime(s, 0, 1)).toBeCloseTo(0.5, 9); // an octave up = double rate
  });

  it('integrates a glide ramp rather than assuming the destination pitch', () => {
    const s = schedule({
      breakpoints: [
        { time: 0, cents: 1200 },
        { time: 0.4, cents: 0 },
      ],
    });
    const cents = (t: number) => (t <= 0 ? 1200 : t >= 0.4 ? 0 : 1200 * (1 - t / 0.4));
    expect(regionEndTime(s, 0, 1)).toBeCloseTo(referenceEnd(cents, 0, 1), 4);
  });

  it('integrates a pitch-envelope contour across all of its stages', () => {
    const s = schedule({
      breakpoints: [
        { time: 0, cents: 0 },
        { time: 0.1, cents: 1200 },
        { time: 0.2, cents: 1200 },
        { time: 0.6, cents: 300 },
      ],
    });
    const cents = (t: number) => baseDetuneAt(s, t);
    expect(regionEndTime(s, 0, 1)).toBeCloseTo(referenceEnd(cents, 0, 1), 4);
  });

  it('integrates a pitch-routed LFO, whose mean rate is not the base rate', () => {
    const s = schedule({
      oscillations: [{ wave: 'sine', rateHz: 3, amplitudeCents: 700, since: 0 }],
    });
    const cents = (t: number) => 700 * Math.sin(2 * Math.PI * 3 * t);
    const end = regionEndTime(s, 0, 1);
    expect(end).toBeCloseTo(referenceEnd(cents, 0, 1), 3);
    // A symmetric detune swing is not a symmetric rate swing: 2^x is convex, so the voice
    // runs *fast* on average and ends earlier than the unmodulated estimate of 1 s.
    expect(end).toBeLessThan(1);
  });

  it('advances whole periods over a long region, matching a step-by-step solve', () => {
    const s = schedule({
      oscillations: [
        { wave: 'sine', rateHz: 1, amplitudeCents: 600, since: 0 },
        { wave: 'triangle', rateHz: 3, amplitudeCents: 300, since: 0 },
      ],
    });
    const cents = (t: number) => detuneAt(s, t);
    expect(regionEndTime(s, 0, 20)).toBeCloseTo(referenceEnd(cents, 0, 20), 3);
  });

  it('stays close even when two LFO rates share no small common period', () => {
    const s = schedule({
      oscillations: [
        { wave: 'sine', rateHz: 1, amplitudeCents: 500, since: 0 },
        { wave: 'sine', rateHz: 7.31, amplitudeCents: 500, since: 0 },
      ],
    });
    const cents = (t: number) => detuneAt(s, t);
    // Within the 3 ms fade width, which is the accuracy the declick actually needs.
    expect(regionEndTime(s, 0, 10)).toBeCloseTo(referenceEnd(cents, 0, 10), 3);
  });

  it('measures consumption between two times, so a retune can bank what was played', () => {
    const s = schedule({ breakpoints: [{ time: 0, cents: 1200 }] });
    expect(consumedBetween(s, 0, 0.25)).toBeCloseTo(0.5, 9); // double rate for a quarter second
  });
});

describe('live retune folding (spec §10.2)', () => {
  it('steps the contour at the retune, keeping what was already played intact', () => {
    const s = schedule({ breakpoints: [{ time: 0, cents: 0 }] });
    applyRetune(s, 0.5, 1200);
    expect(baseDetuneAt(s, 0.25)).toBe(0);
    expect(baseDetuneAt(s, 0.75)).toBe(1200);
    // 0.5 s at unity, then the rest at double rate: a 1 s region ends at 0.75 s.
    expect(regionEndTime(s, 0, 1)).toBeCloseTo(0.75, 6);
  });

  it('composes successive retunes', () => {
    const s = schedule({ breakpoints: [{ time: 0, cents: 0 }] });
    applyRetune(s, 0.5, 1200);
    applyRetune(s, 0.6, 0);
    expect(baseDetuneAt(s, 0.55)).toBe(1200);
    expect(baseDetuneAt(s, 0.7)).toBe(0);
  });

  it('ignores a retune superseded by a ramp that is still pending', () => {
    // `setTargetAtTime` only renders while it is the last event on the param: a pending
    // `linearRampToValueAtTime` interpolates from the preceding event and overrides it.
    const s = schedule({
      breakpoints: [
        { time: 0, cents: 0 },
        { time: 1, cents: 1200 },
      ],
    });
    applyRetune(s, 0.5, -1200);
    expect(baseDetuneAt(s, 0.5)).toBe(600); // unchanged — the glide/envelope ramp wins
    expect(baseDetuneAt(s, 2)).toBe(1200);
  });
});
