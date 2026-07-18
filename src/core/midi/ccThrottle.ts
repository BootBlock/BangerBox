/**
 * CC jitter throttling — spec §10.4. A DIY ESP32 controller's analogue pots emit noisy,
 * high-rate CC streams; applying every one of them would thrash React renders and spam
 * AudioParams. This coalescer keeps only the latest value per CC, applies it at most every
 * `CC_THROTTLE_MS` (rAF-aligned so applications land with the frame that paints them), and
 * rejects ±1 dither around the last applied value — software-side even when the firmware
 * already has hysteresis (spec §10.4).
 *
 * Pure but for the injected clock and scheduler, so the whole policy is unit-testable
 * against a fake clock (spec §2.5).
 */
import { CC_THROTTLE_MS } from '@/core/constants';

/**
 * Dither band, in raw CC steps, around the last applied value (spec §10.4 "±1 value
 * hysteresis"). A move must exceed this to be applied.
 */
const HYSTERESIS_STEPS = 1;

/** CC extremes always pass the hysteresis gate, so the ends of a pot's travel stay reachable. */
const CC_MIN = 0;
const CC_MAX = 127;

export interface CcThrottleOptions {
  /** Minimum interval between applied updates per controller (spec §2.6 `CC_THROTTLE_MS`). */
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Frame scheduler; defaults to `requestAnimationFrame` (spec §10.4 rAF alignment). */
  readonly schedule?: (callback: () => void) => void;
  /**
   * Dither band in raw controller steps (spec §10.4 "±1"). Pitch bend passes its 14-bit
   * value through the same coalescing, where one step of 16 384 is not dither, so it
   * lowers this to zero.
   */
  readonly hysteresisSteps?: number;
  /** Values that always pass the hysteresis gate, keeping the travel ends reachable. */
  readonly endpoints?: readonly [number, number];
}

export interface CcThrottle {
  /** Record an incoming CC value; the latest per controller wins (spec §10.4). */
  push(cc: number, value: number): void;
  /** Drop pending values and hysteresis state — used on disconnect/reconnect (spec §10.4). */
  reset(): void;
}

function defaultSchedule(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
  else setTimeout(callback, 0);
}

export function createCcThrottle(
  apply: (cc: number, value: number) => void,
  options: CcThrottleOptions = {},
): CcThrottle {
  const intervalMs = options.intervalMs ?? CC_THROTTLE_MS;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? defaultSchedule;
  const hysteresisSteps = options.hysteresisSteps ?? HYSTERESIS_STEPS;
  const [endpointMin, endpointMax] = options.endpoints ?? [CC_MIN, CC_MAX];

  /** Latest unapplied value per CC — the coalescing buffer (spec §10.4). */
  const pending = new Map<number, number>();
  /** Last applied value and when, per CC, driving both the throttle and the hysteresis. */
  const lastApplied = new Map<number, { value: number; at: number }>();
  let scheduled = false;

  const scheduleFlush = (): void => {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  };

  function flush(): void {
    scheduled = false;
    const at = now();
    for (const [cc, value] of [...pending]) {
      const last = lastApplied.get(cc);
      // Still inside this controller's window — leave it pending and retry next frame.
      if (last && at - last.at < intervalMs) continue;
      pending.delete(cc);
      const isEndpoint = value === endpointMin || value === endpointMax;
      if (last && !isEndpoint && Math.abs(value - last.value) <= hysteresisSteps) continue;
      lastApplied.set(cc, { value, at });
      try {
        apply(cc, value);
      } catch {
        // A consumer failure must not stall the stream for every later value (spec §10.4:
        // a hardware event never crashes the app).
      }
    }
    if (pending.size > 0) scheduleFlush();
  }

  return {
    push(cc, value) {
      pending.set(cc, value);
      scheduleFlush();
    },
    reset() {
      pending.clear();
      lastApplied.clear();
      scheduled = false;
    },
  };
}
