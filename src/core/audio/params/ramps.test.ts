import { describe, expect, it } from 'vitest';
import { PARAM_RAMP_MS } from '@/core/constants';
import { rampEndTime, rampParamLinear, rampTimeConstantSeconds, setParamNow } from './ramps';

/** A fake AudioParam that records the scheduling calls made against it. */
function fakeParam(initial = 0) {
  const calls: Array<{ method: string; args: number[] }> = [];
  const param = {
    value: initial,
    setValueAtTime(value: number, when: number) {
      calls.push({ method: 'setValueAtTime', args: [value, when] });
      this.value = value;
      return this;
    },
    linearRampToValueAtTime(value: number, when: number) {
      calls.push({ method: 'linearRampToValueAtTime', args: [value, when] });
      return this;
    },
    setTargetAtTime(value: number, when: number, timeConstant: number) {
      calls.push({ method: 'setTargetAtTime', args: [value, when, timeConstant] });
      return this;
    },
    cancelScheduledValues(when: number) {
      calls.push({ method: 'cancelScheduledValues', args: [when] });
      return this;
    },
  };
  return { param: param as unknown as AudioParam, calls };
}

describe('ramp helpers (spec §4.3 dezipper)', () => {
  it('ends a ramp PARAM_RAMP_MS after the given context time', () => {
    expect(rampEndTime(2, PARAM_RAMP_MS)).toBeCloseTo(2 + PARAM_RAMP_MS / 1000, 12);
  });

  it('derives a settling time constant in seconds from milliseconds', () => {
    // One time constant reaches ~63%; the helper divides so the window settles ~95%.
    expect(rampTimeConstantSeconds(PARAM_RAMP_MS)).toBeGreaterThan(0);
    expect(rampTimeConstantSeconds(PARAM_RAMP_MS)).toBeLessThan(PARAM_RAMP_MS / 1000);
  });

  it('anchors the current value then linearly ramps to the target (no clicks)', () => {
    const { param, calls } = fakeParam(0.2);
    rampParamLinear(param, 0.8, 5, PARAM_RAMP_MS);
    expect(calls[0]).toEqual({ method: 'setValueAtTime', args: [0.2, 5] });
    expect(calls[1]).toEqual({
      method: 'linearRampToValueAtTime',
      args: [0.8, rampEndTime(5, PARAM_RAMP_MS)],
    });
  });

  it('sets a value immediately for pre-playback initialisation', () => {
    const { param, calls } = fakeParam();
    setParamNow(param, 0.5, 3);
    expect(param.value).toBe(0.5);
    expect(calls).toEqual([{ method: 'setValueAtTime', args: [0.5, 3] }]);
  });
});
