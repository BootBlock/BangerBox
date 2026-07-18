import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope } from '@/core/project/schemas';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import {
  scheduleAmpAttack,
  scheduleAmpDeclick,
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

describe('scheduleAmpDeclick (spec §5.4)', () => {
  it('ramps to true zero exactly at the end of the buffer', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    const fadeStart = scheduleAmpDeclick(gain.gain, 2, 0, 3);
    expect(fadeStart).toBeCloseTo(2 - 0.003);
    const ramp = calls(gain.gain).find((c) => c.method === 'linearRampToValueAtTime');
    expect(ramp?.args).toEqual([0, 2]);
  });

  it('holds the running envelope at the fade start so the contour is truncated', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 2, 0, 3);
    const hold = calls(gain.gain).find((c) => c.method === 'cancelAndHoldAtTime');
    expect(hold?.args[0]).toBeCloseTo(2 - 0.003);
  });

  it('never reaches back before note-on for a voice shorter than the fade', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    // A 1 ms voice with a 3 ms declick: the fade is clamped to the voice's own start.
    const fadeStart = scheduleAmpDeclick(gain.gain, 5.001, 5, 3);
    expect(fadeStart).toBe(5);
    expect(calls(gain.gain).find((c) => c.method === 'linearRampToValueAtTime')?.args).toEqual([0, 5.001]);
  });

  it('schedules nothing for a zero-length region', () => {
    const { context } = createFakeAudioContext();
    const gain = context.createGain();
    scheduleAmpDeclick(gain.gain, 5, 5, 3);
    expect(calls(gain.gain)).toHaveLength(0);
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
