/**
 * Shared audio-graph handle types (spec §5.3). Every node-creating factory returns a
 * handle with a paired `destroy()` that disconnects everything it built and drops all
 * references — orphaned nodes are a critical failure (spec §3.2).
 */
import type { EffectType } from '@/core/project/schemas';

/** A sub-graph with a single input and output plus mandatory teardown (spec §5.3). */
export interface AudioNodeHandle {
  readonly input: AudioNode;
  readonly output: AudioNode;
  /** Disconnect every node this handle created and release references (spec §3.2). */
  destroy(): void;
}

/**
 * One insert effect (spec §5.7). `enabled` is true-bypass via routing (not zero-gain);
 * `latencySamples` feeds plugin-delay compensation on the dry leg (spec §5.7.3 — native
 * effects report 0). Params are applied through the dezipper ramps (spec §4.3).
 */
export interface InsertHandle extends AudioNodeHandle {
  readonly effectType: EffectType;
  readonly latencySamples: number;
  setEnabled(enabled: boolean): void;
  setParam(name: string, value: number, when: number): void;
}
