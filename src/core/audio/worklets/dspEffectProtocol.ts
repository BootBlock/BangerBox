/**
 * Shared protocol for the DSP-effect worklet (spec §5.6.2, §5.7) — the processor-options and
 * port-message shapes exchanged between the main-thread effect core ({@link effects.ts}) and
 * the {@link dspEffect.worklet.ts} processor. Kept in a plain module so both sides import one
 * definition (spec §2.5) and the kernel-name/param names never drift (naming freeze, §13.6).
 */
import type { WorkletKernelName } from '@/core/dsp/kernelModules';

export const DSP_EFFECT_PROCESSOR = 'dsp-effect';

export interface DspEffectProcessorOptions {
  /** Precompiled kernel module transferred via processorOptions (spec §5.6.2). */
  module: WebAssembly.Module;
  kernel: WorkletKernelName;
  /** Render-quantum size the per-channel kernel pre-allocates for (spec §5.5). */
  maxBlock: number;
  /** Initial parameter values, keyed by the effect's param names (spec §5.7). */
  params: Record<string, number>;
}

/** Update one parameter value (spec §4.3 dezipper is native-node only; kernels apply directly). */
export interface DspEffectParamMessage {
  kind: 'param';
  name: string;
  value: number;
}

/** Free the per-channel kernel memory before the node is disconnected (spec §5.6.3). */
export interface DspEffectDisposeMessage {
  kind: 'dispose';
}

export type DspEffectMessage = DspEffectParamMessage | DspEffectDisposeMessage;
