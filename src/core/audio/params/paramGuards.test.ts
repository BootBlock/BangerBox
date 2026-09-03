/**
 * Guards on the §4.3 AudioParam ramp helpers and the §8.5.6 fader law (issue #97).
 *
 * These are the last functions before a value reaches an `AudioParam`. A NaN written to one
 * poisons that param — and everything downstream of it — for the rest of the session, with
 * no error and no way back but a reload. The policy the helpers implement is therefore
 * **refuse to schedule**: a non-finite value or time is dropped rather than substituted,
 * because substituting a number would silently make up a value the caller never asked for.
 * Range clamping stays with the caller, which is the only layer that knows the range.
 */
import { describe, expect, it } from 'vitest';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import { dbToGain, faderLevelToDb, faderLevelToGain } from './faderLaw';
import { cancelParams, rampParamLinear, rampParamTarget, setParamNow } from './ramps';

/** A real `GainNode.gain` from the §11.3 fake context, with its call log. */
function param(): { gain: AudioParam; calls: { method: string; args: number[] }[] } {
  const { context } = createFakeAudioContext();
  const node = context.createGain();
  return {
    gain: node.gain,
    calls: (node.gain as unknown as { calls: { method: string; args: number[] }[] }).calls,
  };
}

describe('ramp helpers refuse a non-finite value or time (spec §4.3, issue #97)', () => {
  it('rampParamLinear schedules nothing for a NaN target', () => {
    const { gain, calls } = param();
    rampParamLinear(gain, Number.NaN, 0);
    expect(calls).toHaveLength(0);
    expect(gain.value).toBe(1);
  });

  it('rampParamLinear schedules nothing for an infinite target', () => {
    const { gain, calls } = param();
    rampParamLinear(gain, Number.POSITIVE_INFINITY, 0);
    expect(calls).toHaveLength(0);
  });

  it('rampParamLinear schedules nothing for a NaN context time', () => {
    const { gain, calls } = param();
    rampParamLinear(gain, 0.5, Number.NaN);
    expect(calls).toHaveLength(0);
  });

  it('rampParamTarget schedules nothing for a NaN target', () => {
    const { gain, calls } = param();
    rampParamTarget(gain, Number.NaN, 0);
    expect(calls).toHaveLength(0);
  });

  it('rampParamTarget schedules nothing for a non-finite ramp length', () => {
    const { gain, calls } = param();
    rampParamTarget(gain, 0.5, 0, Number.NaN);
    expect(calls).toHaveLength(0);
  });

  it('setParamNow schedules nothing for a NaN value', () => {
    const { gain, calls } = param();
    setParamNow(gain, Number.NaN, 0);
    expect(calls).toHaveLength(0);
  });

  it('still schedules an ordinary in-range move', () => {
    const { gain, calls } = param();
    rampParamLinear(gain, 0.25, 1);
    expect(calls.map((call) => call.method)).toEqual(['setValueAtTime', 'linearRampToValueAtTime']);
    expect(calls[1]!.args[0]).toBe(0.25);
  });

  it('cancelParams still tolerates a null or undefined param', () => {
    expect(() => cancelParams(null, undefined)).not.toThrow();
  });
});

describe('fader law guards its input (spec §8.5.6, issue #97)', () => {
  it('maps NaN to true silence rather than to NaN', () => {
    expect(faderLevelToGain(Number.NaN)).toBe(0);
    expect(faderLevelToDb(Number.NaN)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('clamps above the top of the fader instead of extrapolating past +6 dB', () => {
    expect(faderLevelToDb(2)).toBe(6);
    expect(faderLevelToDb(1.2)).toBe(6);
  });

  it('still maps the fader travel it is given', () => {
    expect(faderLevelToDb(1)).toBe(0);
    expect(faderLevelToGain(1)).toBeCloseTo(1, 12);
    expect(faderLevelToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('dbToGain never returns a non-finite gain', () => {
    expect(dbToGain(Number.NaN)).toBe(0);
    expect(dbToGain(Number.POSITIVE_INFINITY)).toBe(0);
    expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(dbToGain(0)).toBe(1);
  });
});
