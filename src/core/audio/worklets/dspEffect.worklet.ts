/**
 * DSP-effect AudioWorkletProcessor — spec §5.6.2 / §5.7. Hosts a WASM DSP kernel
 * (`multibandComp`, `limiter`, or `fdnReverb`) inside the render thread: the precompiled module
 * arrives via processorOptions and is instantiated once per channel in the constructor (§5.6.2),
 * then each render quantum is processed in place (no allocation, §5.5). Parameter changes and
 * disposal (freeing kernel memory, §5.6.3) arrive over the port. A per-channel kernel keeps the
 * two sides of a stereo signal independent.
 */
import { FdnReverbKernel } from '../../dsp/fdnReverbKernel';
import { LookaheadLimiterKernel } from '../../dsp/lookaheadLimiterKernel';
import { MultibandCompKernel } from '../../dsp/multibandCompKernel';
import type { WorkletKernelName } from '../../dsp/kernelModules';
import type { DspEffectMessage, DspEffectProcessorOptions } from './dspEffectProtocol';

const MAX_CHANNELS = 2;

/** The uniform surface the processor drives regardless of which kernel is hosted. */
interface HostedKernel {
  process(input: Float32Array, output: Float32Array): void;
  destroy(): void;
}

function createKernel(
  kernel: WorkletKernelName,
  module: WebAssembly.Module,
  rate: number,
  maxBlock: number,
): HostedKernel {
  switch (kernel) {
    case 'multibandComp':
      return MultibandCompKernel.fromModule(module, rate, maxBlock);
    case 'limiter':
      return LookaheadLimiterKernel.fromModule(module, rate, maxBlock);
    case 'fdnReverb':
      return FdnReverbKernel.fromModule(module, rate, maxBlock);
  }
}

/** Push the full parameter set into every channel kernel (spec §5.7 param mapping). */
function applyParams(
  kernel: WorkletKernelName,
  instances: readonly HostedKernel[],
  params: Record<string, number>,
): void {
  for (const instance of instances) {
    if (kernel === 'limiter') {
      const limiter = instance as LookaheadLimiterKernel;
      if (params.ceiling !== undefined) limiter.setCeiling(params.ceiling);
      if (params.release !== undefined) limiter.setRelease(params.release);
    } else if (kernel === 'fdnReverb') {
      const reverb = instance as FdnReverbKernel;
      if (params.size !== undefined) reverb.setSize(params.size);
      if (params.damping !== undefined) reverb.setDamping(params.damping);
      if (params.predelay !== undefined) reverb.setPredelay(params.predelay);
    } else {
      const comp = instance as MultibandCompKernel;
      comp.setCrossovers(params.crossoverLowMid ?? 200, params.crossoverMidHigh ?? 2000);
      for (let band = 0; band < 3; band++) {
        comp.setBand(band as 0 | 1 | 2, {
          thresholdDb: params[`band${band}Threshold`] ?? 0,
          ratio: params[`band${band}Ratio`] ?? 1,
          attackMs: params[`band${band}Attack`] ?? 10,
          releaseMs: params[`band${band}Release`] ?? 120,
          makeupDb: params[`band${band}Makeup`] ?? 0,
        });
      }
    }
  }
}

class DspEffectProcessor extends AudioWorkletProcessor {
  private kernels: HostedKernel[] | null;
  private readonly kernelName: WorkletKernelName;
  private readonly params: Record<string, number>;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as unknown as DspEffectProcessorOptions;
    this.kernelName = opts.kernel;
    this.params = { ...opts.params };
    this.kernels = [];
    for (let channel = 0; channel < MAX_CHANNELS; channel++) {
      this.kernels.push(createKernel(opts.kernel, opts.module, sampleRate, opts.maxBlock));
    }
    applyParams(this.kernelName, this.kernels, this.params);

    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as DspEffectMessage | null;
      if (!message || !this.kernels) return;
      if (message.kind === 'param') {
        this.params[message.name] = message.value;
        applyParams(this.kernelName, this.kernels, this.params);
      } else if (message.kind === 'dispose') {
        for (const kernel of this.kernels) kernel.destroy();
        this.kernels = null;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const kernels = this.kernels;
    if (!kernels) return false; // disposed — release the processor (§3.2)
    const input = inputs[0];
    const output = outputs[0];
    if (!output) return true;
    for (let channel = 0; channel < output.length; channel++) {
      const outChannel = output[channel]!;
      const inChannel = input && input.length > 0 ? input[Math.min(channel, input.length - 1)] : undefined;
      const kernel = kernels[Math.min(channel, kernels.length - 1)]!;
      if (inChannel) kernel.process(inChannel, outChannel);
      else outChannel.fill(0);
    }
    return true;
  }
}

registerProcessor('dsp-effect', DspEffectProcessor);
