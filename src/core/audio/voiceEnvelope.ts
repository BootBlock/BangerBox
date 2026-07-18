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
 * Schedule a modulation param over the AHDSR contour from `base`, excursing by `depth`
 * (positive or negative) and settling at `base + depth × sustain` (spec §6 pitch/filter
 * envelopes). Segments are linear — a modulation param may legitimately cross or reach
 * zero, so the exponential-floor restriction does not apply. Returns the decay-end time.
 */
export function scheduleModEnvelope(
  param: AudioParam,
  base: number,
  depth: number,
  env: AhdsrEnvelope,
  when: number,
): number {
  const attackEnd = when + env.attack / 1000;
  const holdEnd = attackEnd + env.hold / 1000;
  const decayEnd = holdEnd + env.decay / 1000;
  param.setValueAtTime(base, when);
  param.linearRampToValueAtTime(base + depth, attackEnd);
  param.setValueAtTime(base + depth, holdEnd);
  param.linearRampToValueAtTime(base + depth * env.sustain, decayEnd);
  return decayEnd;
}

/**
 * Schedule the declick fade that lands a voice on silence at `endTime` — the moment its
 * buffer runs out (spec §5.4: a voice never ends on a hard cut). Without this the amp gain
 * sits at the sustain level and output steps from the sample's last frame straight to zero,
 * which clicks for any sample not ending at a zero crossing.
 *
 * The fade starts `declickMs` before `endTime`, or at `earliest` (the voice's start) for a
 * voice shorter than the fade itself, so the ramp never reaches back before the note-on.
 * `cancelAndHoldAtTime` truncates whatever AHDSR segment is still running at that point:
 * reaching zero by `endTime` outranks completing the contour. A later note-off or steal
 * cancels this ramp in turn, since both hold the param at their own earlier time.
 *
 * Returns the context time the fade begins.
 */
export function scheduleAmpDeclick(
  param: AudioParam,
  endTime: number,
  earliest: number,
  declickMs: number,
): number {
  const fadeStart = Math.max(earliest, endTime - declickMs / 1000);
  if (endTime <= fadeStart) return fadeStart; // zero-length region: nothing to fade
  param.cancelAndHoldAtTime(fadeStart);
  param.linearRampToValueAtTime(0, endTime);
  return fadeStart;
}

/**
 * Schedule the release ramp from `when` to silence over `releaseMs`, holding whatever
 * level the envelope had reached. Returns the context time the voice is silent (when the
 * source should stop).
 */
export function scheduleAmpRelease(param: AudioParam, when: number, releaseMs: number): number {
  const end = when + releaseMs / 1000;
  param.cancelAndHoldAtTime(when);
  param.linearRampToValueAtTime(0, end);
  return end;
}
