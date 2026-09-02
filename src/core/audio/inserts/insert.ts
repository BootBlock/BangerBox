/**
 * Insert wrapper — spec §5.7 / §5.7.3. Wraps a native {@link EffectCore} in the uniform
 * insert surface every slot shares: `enabled` (TRUE bypass via routing, not zero-gain),
 * `mix` (equal-power dry/wet), and plugin-delay compensation on the dry leg (a DelayNode
 * matching the effect's reported latency, so dry and wet stay phase-coherent — native
 * effects report 0). Params flow through the core's dezipper ramps (spec §4.3).
 *
 * `bpm` is the transport tempo a tempo-synced core locks to (spec §5.7 delay, §7.2); the
 * sync layer keeps it current through {@link InsertHandle.setTempo} (spec §4.3).
 *
 * Topology (enabled): input ─┬─→ effect ─→ wetGain ─┐
 *                            └─→ pdcDelay ─→ dryGain ─┴─→ output
 * Bypassed: input ─────────────────────────────────→ output (unprocessed).
 */
import { DEFAULT_BPM, type EffectType } from '@/core/project/schemas';
import { buildEffectCore, type EffectCore } from './effects';
import { defaultEffectParams } from './effectParams';
import { cancelParams } from '../params/ramps';
import type { InsertHandle } from '../types';

/** Equal-power dry/wet gains for a 0..1 mix (spec §5.7): mix 1 ⇒ fully wet. */
export function equalPowerMix(mix: number): { dry: number; wet: number } {
  const clamped = Math.min(1, Math.max(0, mix));
  return { dry: Math.cos(clamped * (Math.PI / 2)), wet: Math.sin(clamped * (Math.PI / 2)) };
}

export function createInsert(
  context: BaseAudioContext,
  effectType: EffectType,
  params: Record<string, number> = {},
  bpm = DEFAULT_BPM,
): InsertHandle {
  const merged = { ...defaultEffectParams(effectType), ...params };
  const core: EffectCore = buildEffectCore(context, effectType, merged, bpm);

  const input = context.createGain();
  const output = context.createGain();
  const wetGain = context.createGain();
  const dryGain = context.createGain();
  // PDC: delay the dry leg by the wet path's latency (spec §5.7.3); 0 for native effects.
  const pdcDelay = context.createDelay(1);
  pdcDelay.delayTime.value = core.latencySamples / context.sampleRate;

  // Permanent wiring for the wet and dry legs; only `input`'s fan-out changes on bypass.
  core.output.connect(wetGain);
  wetGain.connect(output);
  pdcDelay.connect(dryGain);
  dryGain.connect(output);

  let enabled = true;

  const applyRouting = () => {
    input.disconnect();
    if (enabled) {
      input.connect(core.input);
      input.connect(pdcDelay);
    } else {
      input.connect(output); // true bypass — unprocessed signal
    }
  };

  const setMix = (mix: number) => {
    const { dry, wet } = equalPowerMix(mix);
    dryGain.gain.value = dry;
    wetGain.gain.value = wet;
  };

  setMix(merged.mix ?? 1); // effects without a mix param run fully wet (eq/filter/comp)
  applyRouting();

  return {
    effectType,
    latencySamples: core.latencySamples,
    input,
    output,
    setEnabled: (next) => {
      if (next === enabled) return;
      enabled = next;
      applyRouting();
    },
    setParam: (name, value, when) => {
      if (name === 'mix') setMix(value);
      else core.setParam(name, value, when);
    },
    // Forwarded rather than absorbed: only the core knows whether it has a tempo-synced
    // parameter, and an effect without one leaves `setTempo` undefined (spec §5.7).
    setTempo: (nextBpm, when) => core.setTempo?.(nextBpm, when),
    destroy: () => {
      cancelParams(dryGain.gain, wetGain.gain, pdcDelay.delayTime);
      input.disconnect();
      wetGain.disconnect();
      dryGain.disconnect();
      pdcDelay.disconnect();
      output.disconnect();
      core.destroy();
    },
  };
}
