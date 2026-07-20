import { beforeEach, describe, expect, it } from 'vitest';
import { installCancelAndHoldPolyfill } from './cancelAndHold';

/**
 * A stand-in for a browser whose `AudioParam` has no `cancelAndHoldAtTime` — Firefox, the
 * browser issue #109 was reported on. It records what the polyfill schedules against it,
 * which is the only place the held value becomes observable.
 */
class FakeAudioParam {
  readonly defaultValue = 1;
  value = 1;
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];

  setValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'setValueAtTime', args: [value, time] });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'linearRampToValueAtTime', args: [value, time] });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'exponentialRampToValueAtTime', args: [value, time] });
    return this;
  }
  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.calls.push({ method: 'setTargetAtTime', args: [value, time, timeConstant] });
    return this;
  }
  setValueCurveAtTime(curve: Float32Array, time: number, duration: number): this {
    this.calls.push({ method: 'setValueCurveAtTime', args: [curve, time, duration] });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.calls.push({ method: 'cancelScheduledValues', args: [time] });
    return this;
  }
}

/** Scheduling calls that carry a value the hold could have been pinned with. */
const PINNING = new Set(['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime']);

/**
 * The value the polyfilled `cancelAndHoldAtTime` pinned, i.e. what it read off the contour.
 * It arrives as a ramp rather than a set when a ramp was in flight at the hold — see the
 * "keeps the run-up" test.
 */
function heldValue(param: FakeAudioParam): number {
  const pin = [...param.calls].reverse().find((call) => PINNING.has(call.method));
  return pin?.args[0] as number;
}

function newParam(): FakeAudioParam & AudioParam {
  return new FakeAudioParam() as unknown as FakeAudioParam & AudioParam;
}

describe('cancelAndHoldAtTime polyfill (issue #109)', () => {
  beforeEach(() => {
    installCancelAndHoldPolyfill({ prototype: FakeAudioParam.prototype as unknown as AudioParam });
  });

  it('leaves a browser that already implements the method alone', () => {
    const native = () => 0;
    const prototype = { cancelAndHoldAtTime: native, setValueAtTime: native };
    installCancelAndHoldPolyfill({ prototype: prototype as unknown as AudioParam });
    expect(prototype.setValueAtTime).toBe(native);
  });

  it('does nothing where AudioParam does not exist at all (worker, test DOM)', () => {
    expect(() => installCancelAndHoldPolyfill(undefined)).not.toThrow();
  });

  it('holds the value a linear ramp had reached partway through it', () => {
    const param = newParam();
    param.setValueAtTime(0, 1);
    param.linearRampToValueAtTime(1, 3);
    param.cancelAndHoldAtTime(2);
    // Halfway along a 0 → 1 ramp; the naive `param.value` reading would have said 0.
    expect(heldValue(param)).toBeCloseTo(0.5, 10);
  });

  it('cancels before pinning, so nothing scheduled past the hold survives', () => {
    const param = newParam();
    param.setValueAtTime(0.25, 0);
    param.linearRampToValueAtTime(1, 4);
    param.cancelAndHoldAtTime(2);
    const methods = param.calls.map((call) => call.method);
    expect(methods.slice(-2)).toEqual(['cancelScheduledValues', 'linearRampToValueAtTime']);
    // The cancelled ramp must not colour a later hold: the value is flat from 2 onwards.
    param.cancelAndHoldAtTime(3);
    expect(heldValue(param)).toBeCloseTo(0.625, 10);
  });

  /**
   * `cancelScheduledValues` removes an in-flight ramp whole, so pinning with a bare
   * `setValueAtTime` would flatten everything between the ramp's start and the hold — the
   * attack would vanish and only the last instant would survive. Caught by rendering the
   * same contour against Chrome's native method, which is where the two disagreed.
   */
  it('keeps the run-up by re-issuing the ramp the cancel truncated', () => {
    const linear = newParam();
    linear.setValueAtTime(0, 0);
    linear.linearRampToValueAtTime(1, 1);
    linear.cancelAndHoldAtTime(0.5);
    expect(linear.calls.at(-1)).toEqual({ method: 'linearRampToValueAtTime', args: [0.5, 0.5] });

    const exponential = newParam();
    exponential.setValueAtTime(0.25, 0);
    exponential.exponentialRampToValueAtTime(1, 2);
    exponential.cancelAndHoldAtTime(1);
    expect(exponential.calls.at(-1)).toEqual({ method: 'exponentialRampToValueAtTime', args: [0.5, 1] });

    // An exponential held at zero is not expressible as a ramp — pin it flat instead.
    const atZero = newParam();
    atZero.setValueAtTime(0, 0);
    atZero.exponentialRampToValueAtTime(1, 2);
    atZero.cancelAndHoldAtTime(1);
    expect(atZero.calls.at(-1)).toEqual({ method: 'setValueAtTime', args: [0, 1] });
  });

  it('follows an exponential ramp, and holds through one that starts at zero', () => {
    const param = newParam();
    param.setValueAtTime(0.25, 0);
    param.exponentialRampToValueAtTime(1, 2);
    param.cancelAndHoldAtTime(1);
    expect(heldValue(param)).toBeCloseTo(0.5, 10);

    const fromZero = newParam();
    fromZero.setValueAtTime(0, 0);
    fromZero.exponentialRampToValueAtTime(1, 2);
    fromZero.cancelAndHoldAtTime(1);
    expect(heldValue(fromZero)).toBe(0);
  });

  it('holds the last set value when the next event is still in the future', () => {
    const param = newParam();
    param.setValueAtTime(0.4, 0);
    param.setValueAtTime(0.9, 5);
    param.cancelAndHoldAtTime(2);
    expect(heldValue(param)).toBeCloseTo(0.4, 10);
  });

  it('follows a setTargetAtTime approach', () => {
    const param = newParam();
    param.setValueAtTime(0, 0);
    param.setTargetAtTime(1, 0, 1);
    param.cancelAndHoldAtTime(1);
    expect(heldValue(param)).toBeCloseTo(1 - Math.exp(-1), 10);
  });

  it('samples a value curve, and holds its last point once the curve has run out', () => {
    const param = newParam();
    param.setValueCurveAtTime(Float32Array.from([0, 1]), 0, 2);
    param.cancelAndHoldAtTime(1);
    expect(heldValue(param)).toBeCloseTo(0.5, 10);

    const past = newParam();
    past.setValueCurveAtTime(Float32Array.from([0, 0.75]), 0, 2);
    past.cancelAndHoldAtTime(9);
    expect(heldValue(past)).toBeCloseTo(0.75, 10);
  });

  it('falls back to the default value with no history to consult', () => {
    const param = newParam();
    param.cancelAndHoldAtTime(1);
    expect(heldValue(param)).toBe(param.defaultValue);
  });

  it('reproduces the §5.4 declick: a release truncates the attack where it stands', () => {
    const param = newParam();
    // 0 → 1 over 100 ms (attack), then a note-off 50 ms in.
    param.setValueAtTime(0, 0);
    param.linearRampToValueAtTime(1, 0.1);
    param.cancelAndHoldAtTime(0.05);
    param.linearRampToValueAtTime(0, 0.06);
    // The attack survives up to the note-off at half amplitude, then falls to silence.
    expect(param.calls.slice(-2)).toEqual([
      { method: 'linearRampToValueAtTime', args: [0.5, 0.05] },
      { method: 'linearRampToValueAtTime', args: [0, 0.06] },
    ]);
  });
});
