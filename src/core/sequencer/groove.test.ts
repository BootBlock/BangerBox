import { describe, expect, it } from 'vitest';
import {
  applyGrooveToEvents,
  grooveFromTransients,
  grooveShiftAtTick,
  type Transient,
} from './groove';

const PPQN = 960;

/** Frame index of a musical tick at a given tempo/sample rate (inverse of the extractor). */
function tickToFrame(tick: number, bpm: number, sampleRate: number): number {
  const seconds = (tick / PPQN) * (60 / bpm);
  return Math.round(seconds * sampleRate);
}

describe('grooveFromTransients — timing+velocity template (spec §7.5)', () => {
  const bpm = 120;
  const sampleRate = 48_000;
  const lengthTicks = PPQN * 4; // one 4/4 bar

  it('maps transients onto the nearest 1/16 grid position with a signed tick offset', () => {
    // Transients placed 30 ticks LATE of the first three sixteenth positions (0, 240, 480).
    const late = 30;
    const transients: Transient[] = [0, 240, 480].map((tick) => ({
      frame: tickToFrame(tick + late, bpm, sampleRate),
      magnitude: 0.8,
    }));
    const template = grooveFromTransients(transients, { bpm, sampleRate, lengthTicks, division: 16 });
    expect(template.division).toBe(16);
    expect(template.lengthTicks).toBe(lengthTicks);
    // Grid step for 1/16 at 960 PPQN is 240 ticks → 16 points across the bar.
    expect(template.points.length).toBe(16);
    for (const gridTick of [0, 240, 480]) {
      const point = template.points.find((p) => p.gridTick === gridTick)!;
      expect(point.offsetTicks).toBeCloseTo(late, 0);
    }
  });

  it('derives a velocity scale from transient magnitude relative to the mean', () => {
    const transients: Transient[] = [
      { frame: tickToFrame(0, bpm, sampleRate), magnitude: 1.0 },
      { frame: tickToFrame(240, bpm, sampleRate), magnitude: 0.5 },
    ];
    const template = grooveFromTransients(transients, { bpm, sampleRate, lengthTicks, division: 16 });
    const loud = template.points.find((p) => p.gridTick === 0)!;
    const soft = template.points.find((p) => p.gridTick === 240)!;
    expect(loud.velocityScale).toBeGreaterThan(soft.velocityScale);
  });

  it('leaves grid positions without a nearby transient unshifted at neutral velocity', () => {
    const template = grooveFromTransients([{ frame: 0, magnitude: 0.7 }], {
      bpm,
      sampleRate,
      lengthTicks,
      division: 16,
    });
    const empty = template.points.find((p) => p.gridTick === 720)!;
    expect(empty.offsetTicks).toBe(0);
    expect(empty.velocityScale).toBe(1);
  });
});

describe('grooveShiftAtTick — schedule-time lookup (spec §7.5, applied like swing)', () => {
  it('returns the offset and velocity scale of the grid point nearest the tick', () => {
    const template = grooveFromTransients(
      [{ frame: tickToFrame(30, 120, 48_000), magnitude: 0.9 }],
      { bpm: 120, sampleRate: 48_000, lengthTicks: PPQN * 4, division: 16 },
    );
    const shift = grooveShiftAtTick(template, 5); // near grid tick 0
    expect(shift.offsetTicks).toBeCloseTo(30, 0);
  });

  it('wraps ticks beyond the template length back into the pattern', () => {
    const template = grooveFromTransients(
      [{ frame: tickToFrame(30, 120, 48_000), magnitude: 0.9 }],
      { bpm: 120, sampleRate: 48_000, lengthTicks: PPQN * 4, division: 16 },
    );
    const shift = grooveShiftAtTick(template, PPQN * 4 + 5); // one bar on, near grid 0 again
    expect(shift.offsetTicks).toBeCloseTo(30, 0);
  });
});

describe('applyGrooveToEvents — destructive bake (spec §7.5)', () => {
  it('shifts event ticks and scales velocity, clamped to valid ranges', () => {
    const template = grooveFromTransients(
      [{ frame: tickToFrame(30, 120, 48_000), magnitude: 1 }],
      { bpm: 120, sampleRate: 48_000, lengthTicks: PPQN * 4, division: 16 },
    );
    const events = [{ id: 'a', tickStart: 0, velocity: 100, note: 36 }];
    const baked = applyGrooveToEvents(events, template);
    expect(baked[0]!.tickStart).toBeCloseTo(30, 0);
    expect(baked[0]!.velocity).toBeGreaterThanOrEqual(1);
    expect(baked[0]!.velocity).toBeLessThanOrEqual(127);
    expect(baked[0]!.note).toBe(36); // untouched fields preserved
    expect(events[0]!.tickStart).toBe(0); // input not mutated
  });
});
