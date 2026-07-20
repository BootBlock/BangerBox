/**
 * `AudioParam.cancelAndHoldAtTime` polyfill (issue #109).
 *
 * Firefox has never shipped `cancelAndHoldAtTime`, and the engine leans on it everywhere a
 * sounding param has to stop following its contour without jumping: the end-of-region
 * declick, the release ramp and every voice steal (spec §5.4, `voiceEnvelope.ts`). On a
 * browser without it, the very first audition threw
 * `e.cancelAndHoldAtTime is not a function` and nothing played at all — pads included.
 *
 * The method cannot be emulated from the public `AudioParam` surface, because nothing there
 * reports the value the timeline *will* hold at a future time: `param.value` only reads the
 * value now. So the polyfill keeps a shadow copy of the automation timeline — every
 * scheduling call is recorded alongside the native one — and evaluates it at `when` using
 * the interpolation rules of the Web Audio spec. `cancelAndHoldAtTime(when)` then becomes
 * the pair the real method is defined as: cancel from `when`, then pin the value the
 * contour had reached there.
 *
 * Only installed when the method is genuinely missing, so Chrome and Safari pay nothing —
 * not the patch, not the per-event bookkeeping.
 */

/** One scheduled automation event, in the shape the interpolation rules need. */
type AutomationEvent =
  | { readonly kind: 'set' | 'linear' | 'exponential'; readonly time: number; readonly value: number }
  | { readonly kind: 'target'; readonly time: number; readonly value: number; readonly timeConstant: number }
  | {
      readonly kind: 'curve';
      readonly time: number;
      readonly curve: Float32Array;
      readonly duration: number;
    };

/**
 * Most events retained per param. A voice's whole contour is a handful of events and its
 * param dies with the voice, but a long-lived param (a channel level being ridden for an
 * hour) accumulates two events per move forever. Dropping the oldest keeps the record
 * bounded; only recent and future events can affect the value at a hold time, so the ones
 * that go are the ones that already elapsed.
 */
const MAX_EVENTS = 64;

/** Shadow timelines, keyed weakly so a param's history dies with the param. */
const timelines = new WeakMap<AudioParam, AutomationEvent[]>();

/** Record `event`, keeping the list sorted by time (callers mostly schedule in order). */
function record(param: AudioParam, event: AutomationEvent): void {
  let events = timelines.get(param);
  if (!events) {
    events = [];
    timelines.set(param, events);
  }
  let at = events.length;
  while (at > 0 && events[at - 1]!.time > event.time) at -= 1;
  events.splice(at, 0, event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/** Drop the events a native `cancelScheduledValues(when)` would have removed. */
function forget(param: AudioParam, when: number): void {
  const events = timelines.get(param);
  if (!events) return;
  let keep = events.length;
  while (keep > 0 && events[keep - 1]!.time >= when) keep -= 1;
  events.length = keep;
}

/** Linear segment from (t0, v0) to (t1, v1), sampled at `t`. */
function interpolateLinear(v0: number, t0: number, v1: number, t1: number, t: number): number {
  if (t1 <= t0) return v1;
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
}

/**
 * Exponential segment from (t0, v0) to (t1, v1), sampled at `t`. An exponential cannot
 * cross or start at zero; the spec makes such a ramp behave as a hold, and so does this.
 */
function interpolateExponential(v0: number, t0: number, v1: number, t1: number, t: number): number {
  if (t1 <= t0) return v1;
  if (v0 <= 0 || v1 <= 0) return v0;
  return v0 * (v1 / v0) ** ((t - t0) / (t1 - t0));
}

/** `setValueCurveAtTime` sampled at `t`, interpolating between the curve's points. */
function sampleCurve(event: Extract<AutomationEvent, { kind: 'curve' }>, t: number): number {
  const { curve, duration } = event;
  const last = curve.length - 1;
  if (last < 0) return 0;
  if (last === 0 || duration <= 0 || t >= event.time + duration) return curve[last]!;
  const position = ((t - event.time) / duration) * last;
  const index = Math.min(last - 1, Math.floor(position));
  return interpolateLinear(curve[index]!, index, curve[index + 1]!, index + 1, position);
}

/**
 * The value the shadow timeline holds at `t`. `initial` is the value in force before the
 * first recorded event — the param's default, since anything else has been forgotten.
 *
 * The two segment shapes are anchored differently, which is what most of this walk is
 * about: a ramp is *end*-anchored (it interpolates from the previous event's time and
 * value up to its own), while `setTargetAtTime` and `setValueCurveAtTime` are
 * *start*-anchored and keep moving until the next event interrupts them.
 */
function timelineValueAt(events: readonly AutomationEvent[], t: number, initial: number): number {
  let value = initial;
  let anchor = events[0]?.time ?? t;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.time > t) {
      // `t` falls in the segment running into this event: only a ramp moves through it.
      if (event.kind === 'linear') return interpolateLinear(value, anchor, event.value, event.time, t);
      if (event.kind === 'exponential') {
        return interpolateExponential(value, anchor, event.value, event.time, t);
      }
      return value;
    }
    // Fold the event in, leaving `value` as the timeline's value at `anchor`.
    if (event.kind === 'curve') value = event.curve[0] ?? value;
    else if (event.kind !== 'target') value = event.value;
    anchor = event.time;
    // A start-anchored segment then runs on until the next event, or until `t`.
    const until = Math.min(t, events[i + 1]?.time ?? t);
    if (event.kind === 'target') {
      value =
        event.timeConstant > 0
          ? event.value + (value - event.value) * Math.exp(-(until - event.time) / event.timeConstant)
          : event.value;
      anchor = until;
    } else if (event.kind === 'curve') {
      value = sampleCurve(event, until);
      anchor = until;
    }
  }
  return value;
}

/**
 * Install the polyfill on `paramClass` if it lacks `cancelAndHoldAtTime`. Idempotent, and a
 * no-op on a browser that implements the method (and in any environment without
 * `AudioParam` at all, such as a worker or the unit-test DOM).
 *
 * Patching the prototype rather than wrapping the params the engine happens to own is
 * deliberate: the method is called on plain `AudioParam`s reached through nodes the engine
 * builds in a dozen places, and a wrapper would have to be threaded through every one of
 * them — a far bigger surface to get wrong than one shim installed at context creation.
 */
export function installCancelAndHoldPolyfill(
  paramClass: { prototype: AudioParam } | undefined = globalThis.AudioParam,
): void {
  const proto = paramClass?.prototype;
  if (!proto || typeof proto.cancelAndHoldAtTime === 'function') return;

  const setValueAtTime = proto.setValueAtTime;
  const linearRampToValueAtTime = proto.linearRampToValueAtTime;
  const exponentialRampToValueAtTime = proto.exponentialRampToValueAtTime;
  const setTargetAtTime = proto.setTargetAtTime;
  const setValueCurveAtTime = proto.setValueCurveAtTime;
  const cancelScheduledValues = proto.cancelScheduledValues;

  proto.setValueAtTime = function (value, time) {
    record(this, { kind: 'set', time, value });
    return setValueAtTime.call(this, value, time);
  };
  proto.linearRampToValueAtTime = function (value, time) {
    record(this, { kind: 'linear', time, value });
    return linearRampToValueAtTime.call(this, value, time);
  };
  proto.exponentialRampToValueAtTime = function (value, time) {
    record(this, { kind: 'exponential', time, value });
    return exponentialRampToValueAtTime.call(this, value, time);
  };
  proto.setTargetAtTime = function (value, time, timeConstant) {
    record(this, { kind: 'target', time, value, timeConstant });
    return setTargetAtTime.call(this, value, time, timeConstant);
  };
  proto.setValueCurveAtTime = function (curve, time, duration) {
    record(this, { kind: 'curve', time, curve: Float32Array.from(curve), duration });
    return setValueCurveAtTime.call(this, curve, time, duration);
  };
  proto.cancelScheduledValues = function (time) {
    forget(this, time);
    return cancelScheduledValues.call(this, time);
  };
  proto.cancelAndHoldAtTime = function (time) {
    const events = timelines.get(this) ?? [];
    // Read the held value BEFORE cancelling: cancelling collapses the timeline back to the
    // last value that was set, which is the jump this method exists to prevent.
    const held = timelineValueAt(events, time, this.defaultValue);
    // The first event at or after the hold is the one a cancel truncates; anything before it
    // has already happened, so if this is a ramp it is the segment currently in flight.
    const cut = events.find((event) => event.time >= time);
    this.cancelScheduledValues(time);
    // `cancelScheduledValues` removes an in-flight ramp *wholesale*, taking the part before
    // the hold with it and flattening the run-up — an audible difference from the real
    // method, and one a unit test cannot see (it only inspects what was scheduled). Rescuing
    // it is exact rather than approximate: a ramp is defined by its start anchor and its end
    // point, and the same kind of ramp ending at `held`/`time` passes through every point the
    // cancelled one did up to there.
    if (cut?.kind === 'linear') return this.linearRampToValueAtTime(held, time);
    if (cut?.kind === 'exponential' && held > 0) return this.exponentialRampToValueAtTime(held, time);
    return this.setValueAtTime(held, time);
  };
}
