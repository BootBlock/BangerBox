/**
 * Envelope scheduling for a voice (spec §5.4 / §6 AhdsrEnvelope). Schedules the
 * attack→hold→decay→sustain contour on note-on and the release ramp on note-off against
 * a voice's amp `GainNode.gain`, and the same AHDSR contour against a modulation param
 * (source `detune` for the pitch envelope, filter `frequency` for the filter envelope,
 * spec §6). Amp attack/release stay linear so the release always reaches true zero
 * (exponential ramps cannot); the `curve` field shapes the amp decay toward the sustain
 * level (spec §6). Times are milliseconds (schema units); the AudioParam clock is seconds.
 */
import type { AhdsrEnvelope } from '@/core/project/schemas';
import { setParamNow } from './params/ramps';
import type { DetuneBreakpoint } from './detuneSchedule';

/** Smallest non-zero value an exponential ramp may target (they cannot reach 0). */
const EXP_FLOOR = 1e-4;

/** Peak amp gain for a hit: linear velocity scaling × the layer's gain trim (spec §5.4). */
export function velocityToGain(velocity: number, gainDb: number): number {
  const normalised = Math.min(127, Math.max(0, velocity)) / 127;
  return normalised * 10 ** (gainDb / 20);
}

/**
 * Schedule attack→hold→decay→sustain from `when`. The decay follows the envelope's
 * `curve` (spec §6): an exponential decay tracks toward the sustain level, a linear
 * decay ramps straight to it. Returns the context time the sustain level is reached
 * (the earliest a note-off release can begin).
 */
export function scheduleAmpAttack(param: AudioParam, peak: number, amp: AhdsrEnvelope, when: number): number {
  const attackEnd = when + amp.attack / 1000;
  const holdEnd = attackEnd + amp.hold / 1000;
  const decayEnd = holdEnd + amp.decay / 1000;
  const sustain = peak * amp.sustain;
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, attackEnd); // attack stays linear (0 → peak)
  param.setValueAtTime(peak, holdEnd); // hold the peak before decay begins
  if (amp.curve === 'exponential' && sustain > EXP_FLOOR && amp.decay > 0) {
    param.exponentialRampToValueAtTime(sustain, decayEnd);
  } else {
    param.linearRampToValueAtTime(sustain, decayEnd);
  }
  return decayEnd;
}

/**
 * The AHDSR modulation contour as breakpoints: `base` at note-on, excursing by `depth`
 * (positive or negative) across the attack, held over the hold, and settling at
 * `base + depth × sustain` by the end of the decay (spec §6 pitch/filter envelopes).
 *
 * This is the single description of the contour: {@link scheduleModEnvelope} writes it to
 * an AudioParam, and the declick integrator (spec §5.4, issue #87) reads the same points
 * to work out how a pitch envelope moves a voice's playback rate — so the two can never
 * disagree about the shape.
 */
export function modEnvelopeBreakpoints(
  base: number,
  depth: number,
  env: AhdsrEnvelope,
  when: number,
): DetuneBreakpoint[] {
  const attackEnd = when + env.attack / 1000;
  const holdEnd = attackEnd + env.hold / 1000;
  const decayEnd = holdEnd + env.decay / 1000;
  return [
    { time: when, cents: base },
    { time: attackEnd, cents: base + depth },
    { time: holdEnd, cents: base + depth },
    { time: decayEnd, cents: base + depth * env.sustain },
  ];
}

/**
 * Schedule a modulation param over the AHDSR contour (see {@link modEnvelopeBreakpoints}).
 * Segments are linear — a modulation param may legitimately cross or reach zero, so the
 * exponential-floor restriction does not apply. A breakpoint that repeats the previous
 * value is written as a hold rather than a ramp, which is what makes the hold stage flat.
 * Returns the decay-end time.
 */
export function scheduleModEnvelope(
  param: AudioParam,
  base: number,
  depth: number,
  env: AhdsrEnvelope,
  when: number,
): number {
  const points = modEnvelopeBreakpoints(base, depth, env, when);
  param.setValueAtTime(points[0]!.cents, points[0]!.time);
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    if (point.cents === points[i - 1]!.cents) param.setValueAtTime(point.cents, point.time);
    else param.linearRampToValueAtTime(point.cents, point.time);
  }
  return points[points.length - 1]!.time;
}

/**
 * The level the amp contour {@link scheduleAmpAttack} lays down holds at `time` (spec §6).
 *
 * It is evaluated from the same four segment boundaries that function writes, so the model
 * and the sound cannot disagree — the discipline {@link modEnvelopeBreakpoints} already keeps
 * for the declick's detune integrator. The §5.4 declick needs it because it cannot ask the
 * param: no public `AudioParam` member reports the value a contour WILL hold at a future
 * time, and `cancelAndHoldAtTime` pins one only where there is an event at or after the
 * cancel time to rewrite (issue #144).
 *
 * The boundaries are tested from the last segment backwards, so a zero-length attack, hold
 * or decay resolves to the stage that follows it — which is what Web Audio does with several
 * events written at one time, and what a flat §6 envelope is made of.
 */
export function ampLevelAt(peak: number, amp: AhdsrEnvelope, when: number, time: number): number {
  const attackEnd = when + amp.attack / 1000;
  const holdEnd = attackEnd + amp.hold / 1000;
  const decayEnd = holdEnd + amp.decay / 1000;
  const sustain = peak * amp.sustain;
  if (time >= decayEnd) return sustain;
  if (time >= holdEnd) {
    const progress = (time - holdEnd) / (decayEnd - holdEnd);
    // Exactly the condition `scheduleAmpAttack` applies the exponential decay on (spec §6).
    if (amp.curve === 'exponential' && sustain > EXP_FLOOR && amp.decay > 0) {
      return peak * (sustain / peak) ** progress;
    }
    return peak + (sustain - peak) * progress;
  }
  if (time >= attackEnd) return peak;
  if (time <= when) return 0;
  return peak * ((time - when) / (attackEnd - when));
}

/**
 * Where a `declickMs` fade landing on `endTime` begins (spec §5.4).
 *
 * The clamp is on the fade's START rather than on its length: `earliest` is the voice's own
 * note-on, or on a re-lay the moment of the retune, and §5.4 forbids a ramp that reaches back
 * before it. A voice shorter than the fade therefore gets a shorter fade rather than an
 * earlier one, and still lands on true zero at its end.
 *
 * Callers need the time as well as the schedule, because the level the fade departs from is
 * the contour's value THERE — so this is exported rather than left inside
 * {@link scheduleAmpDeclick}.
 */
export function declickFadeStart(endTime: number, earliest: number, declickMs: number): number {
  return Math.max(earliest, endTime - declickMs / 1000);
}

/**
 * Schedule the declick fade that lands a voice on silence at `endTime` — the moment its
 * buffer runs out (spec §5.4: a voice never ends on a hard cut). Without this the amp gain
 * sits at the sustain level and output steps from the sample's last frame straight to zero,
 * which clicks for any sample not ending at a zero crossing.
 *
 * **The fade departs from `level`, and the caller supplies it** (issue #144).
 * `cancelAndHoldAtTime` was used as the anchor, and it inserts a held value only where there
 * is an event at or after the cancel time to rewrite; a voice's amp timeline has nothing
 * after its decay, so the ramp interpolated from the AHDSR's last event instead and every
 * voice faded across its whole length. {@link ampLevelAt} is where a pool voice gets the
 * number; a §5.9 audition sits at unity and passes 1. A non-finite level is refused by the
 * §4.3 guard rather than written, which leaves the fade departing from the contour — the
 * defect's own shape, and audible rather than the silence a NaN would leave behind.
 *
 * `cancelAndHoldAtTime` stays for the job it can do: erasing whatever is scheduled beyond
 * the fade's start, and truncating an AHDSR segment still running there — reaching zero by
 * `endTime` outranks completing the contour. A later note-off, steal or choke cancels this
 * ramp in turn through {@link scheduleAmpRelease}, which needs a departure level of its own
 * for the reason recorded there.
 */
export function scheduleAmpDeclick(
  param: AudioParam,
  endTime: number,
  earliest: number,
  declickMs: number,
  level: number,
): void {
  const fadeStart = declickFadeStart(endTime, earliest, declickMs);
  if (endTime <= fadeStart) return; // zero-length region: nothing to fade
  param.cancelAndHoldAtTime(fadeStart);
  setParamNow(param, level, fadeStart);
  param.linearRampToValueAtTime(0, endTime);
}

/**
 * Schedule the release ramp from `level` at `when` down to silence over `releaseMs` — a §5.4
 * note-off, voice steal or choke. Returns the context time the voice is silent (when the
 * source should stop).
 *
 * **The caller supplies the departure level here too, and the reason issue #144 gave for why
 * it need not is measured wrong.** That reasoning was: an interruption always finds the
 * declick's ramp scheduled beyond it, so `cancelAndHoldAtTime` has an event to rewrite and
 * pins the level itself. It was never measured in a browser, and the condition is weaker than
 * the truth: **the method inserts the hold only when the event it finds at or after the cancel
 * time is itself a RAMP.** Where that event is a `setValueAtTime`, it inserts nothing at all,
 * on the reasoning that the preceding event already gives the value there — which is true of
 * the param's held value and false of the next `linearRampToValueAtTime`, whose line is drawn
 * from the PRECEDING event's time and value.
 *
 * Measured in Edge on a bare param: `setValueAtTime(1, 0)`, then a following event at 0.8,
 * then `cancelAndHoldAtTime(0.4)` and `linearRampToValueAtTime(0, 0.42)`. With the following
 * event a linear ramp the param reads **1.00000** at 0.2 s and 0.5 at 0.41 — a true 20 ms
 * fade. With it a `setValueAtTime` the param reads **0.52381** at 0.2 s and **0.07143** at
 * 0.39 — one straight line from the note-on.
 *
 * That second shape is what every steal and choke in the application has had since §14 `(ay)`,
 * because `(ay)`'s own fix put a `setValueAtTime` at the declick's fade start where a
 * `linearRampToValueAtTime` had been. The fade is only as loud as wherever that line has
 * reached, so a voice interrupted late in its life drops to near silence before its fade
 * begins.
 *
 * `cancelAndHoldAtTime` stays for the job it does do: erasing the declick scheduled beyond
 * this interruption, which §5.4 says outranks it.
 */
export function scheduleAmpRelease(
  param: AudioParam,
  when: number,
  releaseMs: number,
  level: number,
): number {
  const end = when + releaseMs / 1000;
  param.cancelAndHoldAtTime(when);
  setParamNow(param, level, when);
  param.linearRampToValueAtTime(0, end);
  return end;
}
