import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope, type AhdsrEnvelope } from '@/core/project/schemas';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import {
  ampLevelAt,
  declickFadeStart,
  scheduleAmpAttack,
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
    // Attack, hold and decay all zero: `scheduleAmpAttack` writes four events at one time and
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
    // …and a sustain of zero falls back to the linear decay, exactly as `scheduleAmpAttack` does.
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

  it('writes the departure level after the hold, so the hold cannot overwrite it', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    const methods = calls(gain.gain).map((c) => c.method);
    expect(methods).toEqual(['cancelAndHoldAtTime', 'setValueAtTime', 'linearRampToValueAtTime']);
  });

  it('refuses a non-finite level rather than poisoning the param (issue #97)', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, Number.NaN);
    expect(calls(gain.gain).map((c) => c.method)).toEqual(['cancelAndHoldAtTime', 'linearRampToValueAtTime']);
  });

  it('holds the running envelope at the fade start so the contour is truncated', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    const hold = calls(gain.gain).find((c) => c.method === 'cancelAndHoldAtTime');
    expect(hold?.args[0]).toBeCloseTo(2 - 0.003);
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
  it('anchors on the hold alone, because a declick ramp is always scheduled beyond it', () => {
    // The counterpart to the test above, and the reason a release needs no departure level
    // (issue #144): a steal, a choke and a note-off all interrupt a voice whose §5.4 fade is
    // still queued past them, so `cancelAndHoldAtTime` has an event to rewrite and pins the
    // level itself. The declick is the last thing on the timeline and never has one.
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3, 0.5);
    const silentAt = scheduleAmpRelease(gain.gain, 1, 5);
    expect(silentAt).toBeCloseTo(1.005);
    const after = calls(gain.gain).slice(3);
    expect(after.map((c) => c.method)).toEqual(['cancelAndHoldAtTime', 'linearRampToValueAtTime']);
    expect(after[0]!.args[0]).toBe(1); // cancels BEFORE the declick's own ramp at 2 s
    expect(after[1]!.args).toEqual([0, 1.005]);
  });
});

describe('scheduleAmpAttack (spec §6 curve)', () => {
  it('ramps 0→peak→sustain linearly for a linear envelope', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 10, hold: 0, decay: 20, sustain: 0.5, curve: 'linear' });
    scheduleAmpAttack(gain.gain, 1, env, 0);
    const methods = calls(gain.gain).map((c) => c.method);
    expect(methods).toContain('linearRampToValueAtTime');
    expect(methods).not.toContain('exponentialRampToValueAtTime');
  });

  it('uses an exponential decay when the curve is exponential and sustain > 0', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 5, hold: 0, decay: 40, sustain: 0.6, curve: 'exponential' });
    scheduleAmpAttack(gain.gain, 1, env, 0);
    expect(calls(gain.gain).map((c) => c.method)).toContain('exponentialRampToValueAtTime');
  });

  it('falls back to a linear decay when the exponential target would be zero', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const env = createDefaultEnvelope({ attack: 5, hold: 0, decay: 40, sustain: 0, curve: 'exponential' });
    scheduleAmpAttack(gain.gain, 1, env, 0);
    expect(calls(gain.gain).map((c) => c.method)).not.toContain('exponentialRampToValueAtTime');
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
