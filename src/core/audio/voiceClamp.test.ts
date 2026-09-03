/**
 * The voice builder's own clamps at the point of use (spec §6, issue #76). `modMatrix.ts`
 * documents the summed modulation as un-clamped precisely so the voice builder clamps it
 * against each target's range; the filter already did, detune and amp gain did not.
 *
 * These drive the real {@link VoicePool} against the §11.3 fake context and read back what
 * was written to `source.detune` and the amp `GainNode.gain`.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultEnvelope, type ModRoute } from '@/core/project/schemas';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import { VoicePool, type VoiceTriggerSpec } from './voicePool';

function spec(context: AudioContext, over: Partial<VoiceTriggerSpec> = {}): VoiceTriggerSpec {
  return {
    id: 'clamp-voice',
    buffer: context.createBuffer(1, 48_000, 48_000),
    destination: context.createGain(),
    when: 0,
    velocity: 127,
    playbackMode: 'poly',
    chokeGroup: 0,
    programId: 'p1',
    padKey: 'p1:0',
    amp: createDefaultEnvelope(),
    gainDb: 0,
    tuneSemitones: 0,
    tuneCents: 0,
    ...over,
  };
}

/** The detune the built voice's source ended up carrying. */
function detuneOf(fake: ReturnType<typeof createFakeAudioContext>['fake']): number {
  const source = fake.nodes.find((node) => node.nodeType === 'bufferSource') as unknown as {
    detune: { value: number };
  };
  return source.detune.value;
}

/** The peak the amp envelope ramped to (spec §5.4 attack). */
function ampPeakOf(fake: ReturnType<typeof createFakeAudioContext>['fake']): number {
  for (const node of fake.nodes) {
    if (node.nodeType !== 'gain') continue;
    const gain = (node as unknown as { gain: { calls: { method: string; args: number[] }[] } }).gain;
    const attack = gain.calls.find((call) => call.method === 'linearRampToValueAtTime');
    if (attack) return attack.args[0]!;
  }
  return 0;
}

/** 32 routes onto one target — the §6 shape that validates but sums past full scale. */
function pileUp(target: ModRoute['target']): ModRoute[] {
  return Array.from({ length: 32 }, () => ({ source: 'velocity' as const, target, amount: 1 }));
}

describe('VoicePool clamps detune and amp gain (spec §6, issue #76)', () => {
  it('keeps a 32-route pitch pile-up inside one octave rather than 32', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { modMatrix: pileUp('pitch') }));
    expect(Math.abs(detuneOf(fake))).toBeLessThanOrEqual(1200);
    pool.destroy();
  });

  it('keeps a 32-route amp pile-up from reaching 33x gain', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { modMatrix: pileUp('amp') }));
    expect(ampPeakOf(fake)).toBeLessThanOrEqual(2);
    pool.destroy();
  });

  it('bounds a detune the caller supplied out of range', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    // §6 caps `tuneSemitones` at ±36; a caller bypassing the schema must not reach the source.
    pool.trigger(spec(context, { tuneSemitones: 5_000, tuneCents: 0 }));
    expect(Math.abs(detuneOf(fake))).toBeLessThanOrEqual(4_900);
    pool.destroy();
  });

  it('never writes a non-finite detune to the source', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { tuneCents: Number.NaN }));
    expect(Number.isFinite(detuneOf(fake))).toBe(true);
    pool.destroy();
  });

  it('never writes a non-finite amp peak', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { gainDb: Number.NaN }));
    expect(Number.isFinite(ampPeakOf(fake))).toBe(true);
    pool.destroy();
  });

  it('leaves an ordinary pad exactly where it was', () => {
    const { context, fake } = createFakeAudioContext();
    const pool = new VoicePool(context);
    pool.trigger(spec(context, { tuneSemitones: 12, tuneCents: 25 }));
    expect(detuneOf(fake)).toBe(1225);
    pool.destroy();
  });
});
