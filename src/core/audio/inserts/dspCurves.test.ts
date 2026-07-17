import { describe, expect, it } from 'vitest';
import { makeReverbImpulse, makeSaturatorCurve } from './dspCurves';

describe('saturator transfer curves (spec §5.7)', () => {
  it('maps zero to zero with an odd-length curve (no DC offset)', () => {
    const curve = makeSaturatorCurve('soft', 6);
    expect(curve.length % 2).toBe(1);
    expect(curve[(curve.length - 1) / 2]).toBeCloseTo(0, 6);
  });

  it('is monotonic and bounded within [-1, 1]', () => {
    const curve = makeSaturatorCurve('hard', 12);
    let previous = -Infinity;
    for (const value of curve) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = value;
    }
  });

  it('drives harder curves closer to a square as drive increases', () => {
    const gentle = makeSaturatorCurve('soft', 0);
    const hot = makeSaturatorCurve('soft', 36);
    // A mid-positive input saturates far more at high drive.
    const idx = Math.floor((curveLength(gentle) * 3) / 4);
    expect(hot[idx]!).toBeGreaterThan(gentle[idx]!);
  });

  it('tube shape is asymmetric between positive and negative lobes', () => {
    const curve = makeSaturatorCurve('tube', 6);
    const mid = (curve.length - 1) / 2;
    const quarter = (curve.length - 1) / 4;
    const positive = curve[mid + quarter]!;
    const negative = curve[mid - quarter]!;
    expect(Math.abs(positive)).not.toBeCloseTo(Math.abs(negative), 3);
  });
});

describe('procedural reverb impulse (spec §5.7)', () => {
  it('sizes the tail to size × sample rate per channel', () => {
    const ir = makeReverbImpulse(48_000, 2, 0.5, 2);
    expect(ir).toHaveLength(2);
    expect(ir[0]!.length).toBe(96_000);
  });

  it('decays monotonically in energy from head to tail', () => {
    // Deterministic "noise" so the envelope alone drives the comparison.
    const ir = makeReverbImpulse(48_000, 1, 0.5, 1, () => 1);
    const data = ir[0]!;
    const head = data[0]!;
    const tail = data[data.length - 1]!;
    expect(Math.abs(head)).toBeGreaterThan(Math.abs(tail));
    expect(Math.abs(tail)).toBeLessThan(0.01);
  });

  it('damps the tail faster at higher damping', () => {
    const mid = 24_000;
    const low = makeReverbImpulse(48_000, 1, 0.1, 1, () => 1)[0]!;
    const high = makeReverbImpulse(48_000, 1, 0.9, 1, () => 1)[0]!;
    expect(Math.abs(high[mid]!)).toBeLessThan(Math.abs(low[mid]!));
  });
});

function curveLength(curve: Float32Array): number {
  return curve.length;
}
