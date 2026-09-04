/**
 * AudioParam ramp helpers — spec §4.3. The sync layer never sets `.value` directly
 * during playback; it dezippers changes over `PARAM_RAMP_MS` so live moves do not click.
 * These are the only sanctioned way to write a native `AudioParam` from the bridge
 * (§4.3) and the voice envelopes (§5.4). Kept pure of store/graph imports.
 *
 * **Non-finite values are refused, not substituted** (issue #97). A NaN written to an
 * `AudioParam` poisons that param — and every node downstream of it — for the rest of the
 * session, with no error and no way back but a reload; that is the worst failure any of
 * these helpers can cause, so it is the one they will not perform. Substituting a number
 * instead would be worse than refusing: the graph would keep sounding, at a value nobody
 * asked for and nothing recorded. Range clamping is deliberately NOT done here — a helper
 * that takes any param cannot know its range, and the §4.1 store actions, the §6 schemas and
 * the §7.8 registry each already own that for their own values.
 */
import { PARAM_RAMP_MS } from '@/core/constants';

/**
 * Divisor turning the dezipper window into a `setTargetAtTime` time constant. One time
 * constant settles to ~63 %; dividing the window by 3 settles it to ~95 % within
 * `PARAM_RAMP_MS`, which reads as instant-but-click-free.
 */
const SETTLE_DIVISOR = 3;

/**
 * True when a value and a context time are both safe to hand to an `AudioParam` (issue #97).
 * Web Audio throws for a non-finite argument in some engines and silently poisons the param
 * in others, so neither outcome is left to the browser.
 */
function schedulable(value: number, ctxTime: number, ms: number): boolean {
  return Number.isFinite(value) && Number.isFinite(ctxTime) && Number.isFinite(ms);
}

/** Absolute context time at which a ramp started at `ctxTime` should complete. */
export function rampEndTime(ctxTime: number, ms: number = PARAM_RAMP_MS): number {
  return ctxTime + ms / 1000;
}

/** `setTargetAtTime` time constant (seconds) for a `ms`-long dezipper window. */
export function rampTimeConstantSeconds(ms: number = PARAM_RAMP_MS): number {
  return ms / 1000 / SETTLE_DIVISOR;
}

/**
 * Linearly ramp `param` to `target`, anchoring the contour's own value at `ctxTime` first so
 * the segment starts where the signal actually is (no discontinuity). Preferred for
 * bounded controls (level, pan, send) where a predictable end time matters.
 *
 * The anchor is `cancelAndHoldAtTime`, not `setValueAtTime(param.value, …)` (issue #134).
 * `param.value` reports the value NOW; `ctxTime` is routinely in the future, because §7.8
 * automation is scheduled up to `LOOKAHEAD_MS` ahead of the playhead — so anchoring on it
 * pinned each ramp to a stale reading and flattened the run-up between windows. Offline it is
 * worse than stale: an `OfflineAudioContext` renders only once `startRendering()` is called,
 * so every ramp a §9.5 bounce schedules would have read the SAME pre-render value and each
 * window would have jumped the param back to it. `cancelAndHoldAtTime` asks the timeline
 * instead of the clock, which is what the anchor always meant; it is the method
 * `voiceEnvelope.ts` already uses for a param that keeps sounding, and Firefox's missing
 * implementation is supplied by the §14 (issue #109) polyfill installed at context creation.
 *
 * Cancelling from `ctxTime` is the other half, and it is deliberate: a later write to the
 * same param supersedes whatever was queued beyond it, so a live gesture wins over automation
 * already scheduled ahead of the playhead rather than being overwritten by it a moment later.
 */
export function rampParamLinear(
  param: AudioParam,
  target: number,
  ctxTime: number,
  ms: number = PARAM_RAMP_MS,
): void {
  if (!schedulable(target, ctxTime, ms)) return; // refuse rather than poison (issue #97)
  param.cancelAndHoldAtTime(ctxTime);
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
  if (!schedulable(target, ctxTime, ms)) return; // refuse rather than poison (issue #97)
  param.setTargetAtTime(target, ctxTime, rampTimeConstantSeconds(ms));
}

/** Set a value immediately (pre-playback init / graph construction) — no dezipper. */
export function setParamNow(param: AudioParam, value: number, ctxTime: number): void {
  if (!schedulable(value, ctxTime, 0)) return; // refuse rather than poison (issue #97)
  param.setValueAtTime(value, ctxTime);
}

/**
 * Erase every pending automation event on `params` — the second conjunct of the §3.2
 * destroy obligation, which every node-creating factory owes alongside `disconnect()`
 * and dropping references.
 *
 * Cancelling from time 0 (rather than `currentTime`) is deliberate: a destroy is not a
 * musical transition, so there is nothing to hold or ramp from, and events scheduled for
 * the past can still be part of a segment that is currently interpolating. The
 * {@link rampParamTarget} case matters most — `setTargetAtTime` schedules an event with
 * no end time, so without this it stays pending on the param forever.
 *
 * This is teardown-only. To stop automation on a param that keeps sounding, use
 * `cancelAndHoldAtTime` (see `voiceEnvelope.ts`), which leaves the signal where it is
 * instead of jumping it back to the last set value.
 */
export function cancelParams(...params: readonly (AudioParam | null | undefined)[]): void {
  for (const param of params) param?.cancelScheduledValues(0);
}
