/**
 * AudioParam ramp helpers — spec §4.3. The sync layer never sets `.value` directly
 * during playback; it dezippers changes over `PARAM_RAMP_MS` so live moves do not click.
 * These are the only sanctioned way to write a native `AudioParam` from the bridge
 * (§4.3) and the voice envelopes (§5.4). Kept pure of store/graph imports.
 */
import { PARAM_RAMP_MS } from '@/core/constants';

/**
 * Divisor turning the dezipper window into a `setTargetAtTime` time constant. One time
 * constant settles to ~63 %; dividing the window by 3 settles it to ~95 % within
 * `PARAM_RAMP_MS`, which reads as instant-but-click-free.
 */
const SETTLE_DIVISOR = 3;

/** Absolute context time at which a ramp started at `ctxTime` should complete. */
export function rampEndTime(ctxTime: number, ms: number = PARAM_RAMP_MS): number {
  return ctxTime + ms / 1000;
}

/** `setTargetAtTime` time constant (seconds) for a `ms`-long dezipper window. */
export function rampTimeConstantSeconds(ms: number = PARAM_RAMP_MS): number {
  return ms / 1000 / SETTLE_DIVISOR;
}

/**
 * Linearly ramp `param` to `target`, anchoring the current value at `ctxTime` first so
 * the segment starts where the signal actually is (no discontinuity). Preferred for
 * bounded controls (level, pan, send) where a predictable end time matters.
 */
export function rampParamLinear(
  param: AudioParam,
  target: number,
  ctxTime: number,
  ms: number = PARAM_RAMP_MS,
): void {
  param.setValueAtTime(param.value, ctxTime);
  param.linearRampToValueAtTime(target, rampEndTime(ctxTime, ms));
}

/**
 * Exponential-approach ramp via `setTargetAtTime` — smoother for continuous automation
 * where the target keeps moving (§4.3). Never fully reaches the target, so not for
 * hard-stop transitions (use {@link rampParamLinear} there).
 */
export function rampParamTarget(
  param: AudioParam,
  target: number,
  ctxTime: number,
  ms: number = PARAM_RAMP_MS,
): void {
  param.setTargetAtTime(target, ctxTime, rampTimeConstantSeconds(ms));
}

/** Set a value immediately (pre-playback init / graph construction) — no dezipper. */
export function setParamNow(param: AudioParam, value: number, ctxTime: number): void {
  param.setValueAtTime(value, ctxTime);
}
