import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope, type AhdsrEnvelope } from '@/core/project/schemas';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import {
  ampLevelAt,
  declickFadeStart,
  scheduleAmpContour,
  scheduleAmpDeclick,
  scheduleAmpRelease,
  scheduleModEnvelope,
  velocityToGain,
} from './voiceEnvelope';

/** Access a fake AudioParam's recorded schedule calls. */
function calls(param: unknown): { method: string; args: number[] }[] {
  return (param as { calls: { method: string; args: number[] }[] }).calls;
}

describe('velocityToGain (spec §5.4)', () => {
  it('scales velocity 0..127 linearly and applies the gain trim in dB', () => {
    expect(velocityToGain(127, 0)).toBeCloseTo(1);
    expect(velocityToGain(0, 0)).toBe(0);
    expect(velocityToGain(127, 6)).toBeCloseTo(10 ** (6 / 20));
  });
});

describe('ampLevelAt (spec §6, issue #144)', () => {
  const env = (over: Partial<AhdsrEnvelope> = {}): AhdsrEnvelope =>
    createDefaultEnvelope({ attack: 10, hold: 20, decay: 40, sustain: 0.5, curve: 'linear', ...over });

  it('holds the peak for a flat envelope, which is every §6 stage at once', () => {
    // Attack, hold and decay all zero: `scheduleAmpContour` writes four events at one time and
    // Web Audio takes the last, so the contour is the sustain level from the note-on onwards.
    const flat = env({ attack: 0, hold: 0, decay: 0, sustain: 1 });
    expect(ampLevelAt(0.8, flat, 5, 5)).toBeCloseTo(0.8);
    expect(ampLevelAt(0.8, flat, 5, 9.5)).toBeCloseTo(0.8);
  });

  it('rises linearly across the attack and is silent at and before the note-on', () => {
    expect(ampLevelAt(1, env(), 0, -1)).toBe(0);
    expect(ampLevelAt(1, env(), 0, 0)).toBe(0);
    expect(ampLevelAt(1, env(), 0, 0.005)).toBeCloseTo(0.5); // half of a 10 ms attack
    expect(ampLevelAt(1, env(), 0, 0.01)).toBeCloseTo(1);
  });

  it('holds the peak across the hold stage', () => {
    expect(ampLevelAt(1, env(), 0, 0.02)).toBeCloseTo(1); // 10 ms into a 20 ms hold
  });

  it('interpolates a linear decay towards the sustain level', () => {
    // Decay runs 0.030 s → 0.070 s from peak 1 to sustain 0.5.
    expect(ampLevelAt(1, env(), 0, 0.05)).toBeCloseTo(0.75);
    expect(ampLevelAt(1, env(), 0, 0.07)).toBeCloseTo(0.5);
  });

  it('interpolates an exponential decay geometrically, on the same condition the scheduler uses', () => {
    const exp = env({ curve: 'exponential' });
    // Halfway through a peak-1 → sustain-0.5 exponential decay is √0.5, not 0.75.
    expect(ampLevelAt(1, exp, 0, 0.05)).toBeCloseTo(Math.SQRT1_2);
    // …and a sustain of zero falls back to the linear decay, exactly as `scheduleAmpContour` does.
    expect(ampLevelAt(1, env({ curve: 'exponential', sustain: 0 }), 0, 0.05)).toBeCloseTo(0.5);
  });

  it('settles on peak × sustain once the decay has run', () => {
    expect(ampLevelAt(0.6, env(), 0, 5)).toBeCloseTo(0.3);
  });
});

describe('scheduleAmpDeclick (spec §5.4)', () => {
  it('ramps to true zero exactly at the end of the buffer', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    expect(declickFadeStart(2, 0, 3)).toBeCloseTo(2 - 0.003);
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    const ramp = calls(gain.gain).find((c) => c.method === 'linearRampToValueAtTime');
    expect(ramp?.args).toEqual([0, 2]);
  });

  it('departs from the level the caller supplies, not from wherever the contour was', () => {
    // Issue #144. `cancelAndHoldAtTime` pins a value only where there is an event at or after
    // the cancel time to rewrite, and a voice's amp timeline has none after its decay — so
    // without this write the ramp interpolates from the AHDSR's last event, which is the
    // note-on, and every voice fades across its whole length.
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    expect(calls(gain.gain)).toContainEqual({ method: 'setValueAtTime', args: [0.5, 2 - 0.003] });
  });

  it('writes the departure level and the ramp, and CANCELS nothing (issue #146)', () => {
    // The cancel used to lead: `cancelAndHoldAtTime(fadeStart)` cut the §6 contour off here.
    // That works once and destroys the contour the second time, because the method truncates a
    // ramp by REPLACING it with a held value — which a later, earlier cancel then finds, does
    // not recognise as a ramp, and removes along with the segment it stood for. The caller now
    // writes the contour only as far as this fade ({@link scheduleAmpContour}), so there is
    // nothing beyond it to erase.
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    const methods = calls(gain.gain).map((c) => c.method);
    expect(methods).toEqual(['setValueAtTime', 'linearRampToValueAtTime']);
  });

  it('refuses a non-finite level rather than poisoning the param (issue #97)', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, Number.NaN);
    expect(calls(gain.gain).map((c) => c.method)).toEqual(['linearRampToValueAtTime']);
  });

  it('never reaches back before note-on for a voice shorter than the fade', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    // A 1 ms voice with a 3 ms declick: the clamp is on the fade's START, so the fade is
    // 1 ms long rather than beginning 2 ms before the voice exists.
    expect(declickFadeStart(5.001, 5, 3)).toBe(5);
    scheduleAmpDeclick(gain.gain, 5.001, 5, 3, 0.4);
    expect(calls(gain.gain)).toContainEqual({ method: 'setValueAtTime', args: [0.4, 5] });
    expect(calls(gain.gain).find((c) => c.method === 'linearRampToValueAtTime')?.args).toEqual([0, 5.001]);
  });

  it('schedules nothing for a zero-length region', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 5, 5, 3, 0.4);
    expect(calls(gain.gain)).toHaveLength(0);
  });
});

describe('scheduleAmpRelease (spec §5.4)', () => {
  it('writes the departure level, because the hold beyond it is a setValue and pins nothing', () => {
    // Issue #144 left this function anchoring on `cancelAndHoldAtTime` alone, reasoning that a
    // steal, a choke and a note-off all interrupt a voice whose §5.4 fade is still queued past
    // them, so the method has an event to rewrite. Measured in Edge, that condition is weaker
    // than the truth: the hold is inserted only where the event found at or after the cancel
    // time is itself a RAMP — and the declick's first event is the `setValueAtTime` #144 added.
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    const silentAt = scheduleAmpRelease(gain.gain, 1, 5, 0.4);
    expect(silentAt).toBeCloseTo(1.005);
    const after = calls(gain.gain).slice(2); // the declick writes two calls, not three
    expect(after.map((c) => c.method)).toEqual([
      'cancelAndHoldAtTime',
      'setValueAtTime',
      'linearRampToValueAtTime',
    ]);
    expect(after[0]!.args[0]).toBe(1); // cancels BEFORE the declick's own ramp at 2 s
    expect(after[1]!.args).toEqual([0.4, 1]);
    expect(after[2]!.args).toEqual([0, 1.005]);
  });

  it('refuses a non-finite level through the §4.3 guard rather than poisoning the param', () => {
    // The same policy `scheduleAmpDeclick` keeps (issue #97): a NaN written to a gain would
    // silence the chain for the session, so the fade is left interpolating instead.
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpRelease(gain.gain, 1, 5, Number.NaN);
    expect(calls(gain.gain).map((c) => c.method)).toEqual(['cancelAndHoldAtTime', 'linearRampToValueAtTime']);
  });
});

describe('scheduleAmpContour (spec §6 curve, issue #146)', () => {
  it('ramps 0→peak→sustain linearly for a linear envelope', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 10, hold: 0, decay: 20, sustain: 0.5, curve: 'linear' });
    scheduleAmpContour(gain.gain, 1, env, 0, 0, 1);
    const methods = calls(gain.gain).map((c) => c.method);
    expect(methods).toContain('linearRampToValueAtTime');
    expect(methods).not.toContain('exponentialRampToValueAtTime');
  });

  it('uses an exponential decay when the curve is exponential and sustain > 0', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 5, hold: 0, decay: 40, sustain: 0.6, curve: 'exponential' });
    scheduleAmpContour(gain.gain, 1, env, 0, 0, 1);
    expect(calls(gain.gain).map((c) => c.method)).toContain('exponentialRampToValueAtTime');
  });

  it('falls back to a linear decay when the exponential target would be zero', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 5, hold: 0, decay: 40, sustain: 0, curve: 'exponential' });
    scheduleAmpContour(gain.gain, 1, env, 0, 0, 1);
    expect(calls(gain.gain).map((c) => c.method)).not.toContain('exponentialRampToValueAtTime');
  });

  it('writes the span it is given and ends on a RAMP landing on the contour there', () => {
    // The closing ramp is what lets a later re-lay cancel inside this span and still keep it:
    // `cancelAndHoldAtTime` truncates a ramp and preserves everything before it, and loses the
    // segment where it finds a held value instead (issue #146). Two points of one segment
    // reproduce that segment, so a span is the contour rather than an approximation of it.
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 10, hold: 0, decay: 100, sustain: 0.5, curve: 'linear' });
    scheduleAmpContour(gain.gain, 1, env, 0, 0.03, 0.08);
    const written = calls(gain.gain);
    // Anchored on the contour's own value at 30 ms, one fifth of the way down a 100 ms decay.
    expect(written[0]).toEqual({ method: 'setValueAtTime', args: [expect.closeTo(0.9, 6), 0.03] });
    // …and closing on its value at 80 ms, seven tenths of the way down. Nothing beyond it.
    expect(written).toHaveLength(2);
    expect(written[1]).toEqual({
      method: 'linearRampToValueAtTime',
      args: [expect.closeTo(0.65, 6), 0.08],
    });
  });

  it('writes only the anchor for a zero-length span', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpContour(gain.gain, 1, createDefaultEnvelope(), 0, 0.5, 0.5);
    expect(calls(gain.gain).map((c) => c.method)).toEqual(['setValueAtTime']);
  });
});

describe('scheduleModEnvelope (spec §6 pitch/filter envelope)', () => {
  it('excurses from base by depth and settles at base + depth × sustain', () => {
    const { context } = createFakeAudioContext();
    const param = context.createBufferSource().detune;
    const env = createDefaultEnvelope({ attack: 10, hold: 0, decay: 20, sustain: 0.5, curve: 'linear' });
    scheduleModEnvelope(param, 100, 400, env, 0); // base 100 cents, +400 depth
    const ramps = calls(param).filter((c) => c.method === 'linearRampToValueAtTime');
    expect(ramps[0]?.args[0]).toBe(500); // peak = base + depth
    expect(ramps[1]?.args[0]).toBe(300); // sustain = base + depth × 0.5
  });
});
