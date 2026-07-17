import { describe, expect, it } from 'vitest';
import { ClockModel, DRIFT_SNAP_SECONDS } from './clockSync';

describe('ClockModel (spec §7.1.2)', () => {
  it('adopts the first sync pair as the offset', () => {
    const model = new ClockModel();
    expect(model.hasSync).toBe(false);
    // contextTime 5 s, performanceTime 3000 ms → offset 5 − 3 = 2 s.
    model.applySync(5, 3000);
    expect(model.hasSync).toBe(true);
    expect(model.offsetSeconds).toBeCloseTo(2, 9);
  });

  it('smooths jitter across samples', () => {
    const model = new ClockModel();
    // Two pairs whose instantaneous offsets are 2.000 and 2.001 s (within 2 ms → smoothed).
    model.applySync(5, 3000); // 2.000
    const result = model.applySync(5.0005, 2999.5); // 5.0005 − 2.9995 = 2.001
    expect(result.snapped).toBe(false);
    expect(model.offsetSeconds).toBeCloseTo((2.0 + 2.001) / 2, 6);
  });

  it('snaps and signals when drift exceeds 2 ms', () => {
    const model = new ClockModel();
    model.applySync(5, 3000); // offset 2.000
    // New instantaneous offset 2.010 s — 10 ms of drift, beyond the 2 ms threshold.
    const result = model.applySync(5.01, 3000);
    expect(result.snapped).toBe(true);
    expect(model.offsetSeconds).toBeCloseTo(2.01, 9); // snapped straight to the new value
  });

  it('does not snap exactly at the threshold', () => {
    const model = new ClockModel();
    model.applySync(5, 3000);
    const result = model.applySync(5 + DRIFT_SNAP_SECONDS, 3000);
    expect(result.snapped).toBe(false);
  });

  it('estimates context time from a performance.now reading', () => {
    const model = new ClockModel();
    model.applySync(5, 3000); // offset 2 s
    // now = 4000 ms → 4 + 2 = 6 s.
    expect(model.estimateContextTime(4000)).toBeCloseTo(6, 9);
  });

  it('keeps only the last 8 samples', () => {
    const model = new ClockModel();
    // Ten identical-offset samples then the average must still equal that offset.
    for (let i = 0; i < 10; i++) model.applySync(5, 3000);
    expect(model.offsetSeconds).toBeCloseTo(2, 9);
  });
});
