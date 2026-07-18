/**
 * CC jitter throttling tests — spec §10.4: per-CC coalescing (keep only the latest value),
 * applied at most every `CC_THROTTLE_MS`, with ±1 hysteresis against noisy analogue pots.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CC_THROTTLE_MS } from '@/core/constants';
import { createCcThrottle } from './ccThrottle';

/** A fake clock + manual frame pump so the throttle is tested without real timers. */
function harness() {
  let now = 0;
  const frames: (() => void)[] = [];
  const applied: { cc: number; value: number }[] = [];
  const throttle = createCcThrottle((cc, value) => applied.push({ cc, value }), {
    now: () => now,
    schedule: (callback) => {
      frames.push(callback);
    },
  });
  return {
    applied,
    throttle,
    advance(ms: number) {
      now += ms;
    },
    /** Run every frame callback queued so far (one animation frame). */
    pump() {
      const due = frames.splice(0, frames.length);
      for (const callback of due) callback();
    },
    pendingFrames: () => frames.length,
  };
}

describe('CC throttle (spec §10.4)', () => {
  let rig: ReturnType<typeof harness>;
  beforeEach(() => {
    rig = harness();
  });

  it('applies the first value for a controller immediately on the next frame', () => {
    rig.throttle.push(74, 64);
    expect(rig.applied).toEqual([]);
    rig.pump();
    expect(rig.applied).toEqual([{ cc: 74, value: 64 }]);
  });

  it('coalesces a burst into the latest value only', () => {
    for (const value of [10, 20, 30, 40, 50]) rig.throttle.push(74, value);
    rig.pump();
    expect(rig.applied).toEqual([{ cc: 74, value: 50 }]);
  });

  it('applies at most once per CC_THROTTLE_MS per controller', () => {
    rig.throttle.push(74, 10);
    rig.pump();
    rig.throttle.push(74, 40);
    rig.pump(); // same instant — still inside the throttle window
    expect(rig.applied).toEqual([{ cc: 74, value: 10 }]);

    rig.advance(CC_THROTTLE_MS);
    rig.pump();
    expect(rig.applied).toEqual([
      { cc: 74, value: 10 },
      { cc: 74, value: 40 },
    ]);
  });

  it('never drops the final value of a gesture', () => {
    rig.throttle.push(74, 10);
    rig.pump();
    rig.throttle.push(74, 90);
    rig.throttle.push(74, 95);
    rig.advance(CC_THROTTLE_MS);
    rig.pump();
    expect(rig.applied.at(-1)).toEqual({ cc: 74, value: 95 });
  });

  it('throttles each controller independently', () => {
    rig.throttle.push(74, 10);
    rig.throttle.push(75, 20);
    rig.pump();
    expect(rig.applied).toEqual([
      { cc: 74, value: 10 },
      { cc: 75, value: 20 },
    ]);
  });

  it('rejects ±1 dither around the last applied value (hysteresis, spec §10.4)', () => {
    rig.throttle.push(74, 64);
    rig.pump();
    for (const value of [65, 63, 64, 65, 63]) {
      rig.advance(CC_THROTTLE_MS);
      rig.throttle.push(74, value);
      rig.pump();
    }
    expect(rig.applied).toEqual([{ cc: 74, value: 64 }]);
  });

  it('applies a genuine move of more than one step', () => {
    rig.throttle.push(74, 64);
    rig.pump();
    rig.advance(CC_THROTTLE_MS);
    rig.throttle.push(74, 66);
    rig.pump();
    expect(rig.applied.at(-1)).toEqual({ cc: 74, value: 66 });
  });

  it('always lets the endpoints through so the full range stays reachable', () => {
    rig.throttle.push(74, 1);
    rig.pump();
    rig.advance(CC_THROTTLE_MS);
    rig.throttle.push(74, 0); // one step away, but 0 must be reachable
    rig.pump();
    expect(rig.applied.at(-1)).toEqual({ cc: 74, value: 0 });

    rig.throttle.push(74, 126);
    rig.advance(CC_THROTTLE_MS);
    rig.pump();
    rig.throttle.push(74, 127);
    rig.advance(CC_THROTTLE_MS);
    rig.pump();
    expect(rig.applied.at(-1)).toEqual({ cc: 74, value: 127 });
  });

  it('stops scheduling frames once everything is applied', () => {
    rig.throttle.push(74, 10);
    rig.pump();
    rig.pump();
    expect(rig.pendingFrames()).toBe(0);
  });

  it('keeps re-scheduling while a value is still waiting out its window', () => {
    rig.throttle.push(74, 10);
    rig.pump();
    rig.throttle.push(74, 90);
    rig.pump(); // too soon — must have queued another frame to retry
    expect(rig.pendingFrames()).toBe(1);
  });

  it('drops pending values and hysteresis state on reset (spec §10.4 reconnect)', () => {
    rig.throttle.push(74, 64);
    rig.pump();
    rig.throttle.push(74, 100);
    rig.throttle.reset();
    rig.advance(CC_THROTTLE_MS);
    rig.pump();
    expect(rig.applied).toEqual([{ cc: 74, value: 64 }]);

    // After a reset the next value is treated as a first value again.
    rig.throttle.push(74, 65);
    rig.pump();
    expect(rig.applied.at(-1)).toEqual({ cc: 74, value: 65 });
  });

  it('survives an apply callback that throws without stalling later values', () => {
    const applied: number[] = [];
    let now = 0;
    const frames: (() => void)[] = [];
    const throttle = createCcThrottle(
      (_cc, value) => {
        applied.push(value);
        if (value === 10) throw new Error('consumer blew up');
      },
      { now: () => now, schedule: (callback) => void frames.push(callback) },
    );
    throttle.push(74, 10);
    expect(() => frames.splice(0)[0]!()).not.toThrow();
    now += CC_THROTTLE_MS;
    throttle.push(74, 90);
    frames.splice(0).forEach((callback) => callback());
    expect(applied).toEqual([10, 90]);
  });

  it('defaults to requestAnimationFrame alignment when no scheduler is injected', () => {
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const throttle = createCcThrottle(() => {});
    throttle.push(74, 10);
    expect(raf).toHaveBeenCalled();
    raf.mockRestore();
  });
});
