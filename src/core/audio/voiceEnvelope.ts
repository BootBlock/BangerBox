/**
 * Amp-envelope scheduling for a voice (spec §5.4 / §6 AhdsrEnvelope). Schedules the
 * attack→hold→decay→sustain contour on note-on and the release ramp on note-off against
 * a voice's amp `GainNode.gain`. Linear segments are used so the release always reaches
 * true zero (exponential ramps cannot) — the `curve` refinement is Program-Edit work
 * (Phase 5). Times are milliseconds (schema units); the AudioParam clock is seconds.
 */
import type { AhdsrEnvelope } from '@/core/project/schemas';

/** Peak amp gain for a hit: linear velocity scaling × the layer's gain trim (spec §5.4). */
export function velocityToGain(velocity: number, gainDb: number): number {
  const normalised = Math.min(127, Math.max(0, velocity)) / 127;
  return normalised * 10 ** (gainDb / 20);
}

/**
 * Schedule attack→hold→decay→sustain from `when`. Returns the context time the sustain
 * level is reached (the earliest a note-off release can begin).
 */
export function scheduleAmpAttack(
  param: AudioParam,
  peak: number,
  amp: AhdsrEnvelope,
  when: number,
): number {
  const attackEnd = when + amp.attack / 1000;
  const holdEnd = attackEnd + amp.hold / 1000;
  const decayEnd = holdEnd + amp.decay / 1000;
  param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(peak, attackEnd);
  param.setValueAtTime(peak, holdEnd); // hold the peak before decay begins
  param.linearRampToValueAtTime(peak * amp.sustain, decayEnd);
  return decayEnd;
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
