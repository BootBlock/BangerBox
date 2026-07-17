import { describe, expect, it } from 'vitest';
import { EFFECT_TYPES, type EffectType } from '@/core/project/schemas';
import { createFakeAudioContext, liveNodeCount } from '@/test/mocks/audioContext';
import { createTrackChannel } from '../factory';
import { createInsert, equalPowerMix } from './insert';

/** The six effects with a real native DSP core this phase (spec §5.7). */
const NATIVE_EFFECTS: EffectType[] = ['eq4', 'filter', 'delay', 'compressor', 'saturator', 'reverb'];

function outputCount(node: AudioNode): number {
  return (node as unknown as { outputs: unknown[] }).outputs.length;
}

describe('equal-power dry/wet mix (spec §5.7)', () => {
  it('is fully dry at 0 and fully wet at 1', () => {
    expect(equalPowerMix(0)).toEqual({ dry: 1, wet: 0 });
    const wet = equalPowerMix(1);
    expect(wet.dry).toBeCloseTo(0, 12);
    expect(wet.wet).toBeCloseTo(1, 12);
  });

  it('preserves constant power across the sweep (dry² + wet² = 1)', () => {
    for (const mix of [0, 0.25, 0.5, 0.75, 1]) {
      const { dry, wet } = equalPowerMix(mix);
      expect(dry * dry + wet * wet).toBeCloseTo(1, 12);
    }
  });
});

describe('insert wrapper (spec §5.7)', () => {
  it('builds and tears down every native effect leak-free (spec §3.2)', () => {
    for (const effectType of NATIVE_EFFECTS) {
      const { context, fake } = createFakeAudioContext();
      const insert = createInsert(context, effectType);
      expect(insert.effectType).toBe(effectType);
      expect(insert.latencySamples).toBe(0); // native effects report no latency (§5.7.3)
      insert.destroy();
      expect(liveNodeCount(fake)).toBe(0);
    }
  });

  it('routes through the effect when enabled and bypasses it when disabled (spec §5.7)', () => {
    const { context } = createFakeAudioContext();
    const insert = createInsert(context, 'filter');
    // Enabled: input fans out to the effect core and the PDC dry leg.
    expect(outputCount(insert.input)).toBe(2);
    insert.setEnabled(false);
    // Bypassed: input feeds the output directly (true bypass, not zero-gain).
    expect(outputCount(insert.input)).toBe(1);
    insert.setEnabled(true);
    expect(outputCount(insert.input)).toBe(2);
    insert.destroy();
  });

  it('accepts every declared effect id (incl. deferred worklet effects as passthrough)', () => {
    for (const effectType of EFFECT_TYPES) {
      const { context } = createFakeAudioContext();
      const insert = createInsert(context, effectType);
      insert.setParam('mix', 0.5, 0);
      insert.destroy();
    }
  });
});

describe('insert chain on a channel strip (spec §5.7)', () => {
  it('splices inserts serially and disposes them on replace and destroy', () => {
    const { context, fake } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    const a = createInsert(context, 'eq4');
    const b = createInsert(context, 'compressor');
    channel.setInserts([a, b]);
    expect(channel.insertLatencySamples()).toBe(0);
    // Replacing the chain disposes the previous inserts…
    channel.setInserts([]);
    // …and destroying the strip leaves nothing connected.
    channel.destroy();
    expect(liveNodeCount(fake)).toBe(0);
  });
});
