import { describe, expect, it } from 'vitest';
import {
  createMeterSab,
  meterData,
  meterHeader,
  MeterRegistry,
  METER_SLOTS,
  slotFloatBase,
} from './metering';

describe('meter registry (spec §5.8)', () => {
  it('allocates distinct slots and hands them out in order', () => {
    const registry = new MeterRegistry();
    expect(registry.allocate('master')).toBe(0);
    expect(registry.allocate('track:1')).toBe(1);
    // Idempotent per id.
    expect(registry.allocate('master')).toBe(0);
  });

  it('reuses a released slot', () => {
    const registry = new MeterRegistry();
    registry.allocate('a');
    const slotB = registry.allocate('b');
    registry.release('b');
    expect(registry.slotOf('b')).toBeUndefined();
    expect(registry.allocate('c')).toBe(slotB); // reused
  });

  it('reads back the peak/rms values a writer stored in the SAB', () => {
    const sab = createMeterSab();
    const registry = new MeterRegistry(sab);
    const slot = registry.allocate('master');
    // Simulate the worklet writing [peakL, rmsL, peakR, rmsR].
    const data = meterData(sab);
    const base = slotFloatBase(slot);
    data[base] = 0.9;
    data[base + 1] = 0.6;
    data[base + 2] = 0.8;
    data[base + 3] = 0.5;
    const reading = registry.read(slot);
    expect(reading.peakL).toBeCloseTo(0.9, 5);
    expect(reading.rmsL).toBeCloseTo(0.6, 5);
    expect(reading.peakR).toBeCloseTo(0.8, 5);
    expect(reading.rmsR).toBeCloseTo(0.5, 5);
  });

  it('zeroes a slot on allocation so stale values never leak in', () => {
    const sab = createMeterSab();
    const registry = new MeterRegistry(sab);
    const slot = registry.allocate('x');
    meterData(sab)[slotFloatBase(slot)] = 0.7;
    registry.release('x');
    const reused = registry.allocate('y');
    expect(registry.read(reused).peakL).toBe(0);
  });

  it('surfaces the generation counter a writer bumps via Atomics', () => {
    const sab = createMeterSab();
    const registry = new MeterRegistry(sab);
    expect(registry.generation()).toBe(0);
    Atomics.add(meterHeader(sab), 0, 1);
    expect(registry.generation()).toBe(1);
  });

  it('throws when every slot is taken (spec §5.8 headroom guard)', () => {
    const registry = new MeterRegistry();
    for (let i = 0; i < METER_SLOTS; i++) registry.allocate(`m${i}`);
    expect(() => registry.allocate('overflow')).toThrow(/exhausted/);
  });
});
