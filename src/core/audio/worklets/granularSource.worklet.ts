/**
 * Warp source AudioWorkletProcessor — spec §5.7.9 / §5.2 stage 1. Plays one voice's region
 * through the `granularStretch` kernel so pitch and duration are independent: `detune`
 * shifts pitch and leaves the length alone, which is exactly what an `AudioBufferSourceNode`
 * cannot do (spec §5.5 — plain `playbackRate` is coupled repitch by design).
 *
 * The precompiled module arrives via processorOptions and is instantiated once per channel
 * in the constructor (spec §5.6.2); each render quantum is produced in place with no
 * allocation (spec §5.5). Kernel memory is freed on `dispose` (spec §5.6.3), and the end of
 * the region is reported over the port because a worklet source has no `ended` event.
 *
 * Start and stop are frame-accurate against `currentFrame`, not quantum-accurate: a
 * scheduled note is placed up to `LOOKAHEAD_MS` ahead (spec §7.1.4), so a source that began
 * producing the moment its node existed would be a tenth of a second into its own region by
 * the time the note was due.
 */
import { GranularSourceKernel } from '../../dsp/granularStretchKernel';
import type { GranularSourceMessage, GranularSourceProcessorOptions } from './granularSourceProtocol';
import { GRANULAR_SOURCE_DETUNE, GRANULAR_SOURCE_PROCESSOR } from './granularSourceProtocol';

class GranularSourceProcessor extends AudioWorkletProcessor {
  private kernels: GranularSourceKernel[] | null;
  private readonly startFrame: number;
  private stopFrame = Infinity;
  private ended = false;

  /**
   * `detune` is k-rate: the kernel takes one pitch per grain placement, so a per-sample
   * curve would be sampled down to the block anyway. One value per render quantum is
   * 2.7 ms at 48 kHz — far finer than any §6 LFO or §7.8 automation ramp needs.
   */
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: GRANULAR_SOURCE_DETUNE,
        defaultValue: 0,
        minValue: -100_000,
        maxValue: 100_000,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const opts = options.processorOptions as unknown as GranularSourceProcessorOptions;
    this.startFrame = Math.round(opts.startTime * sampleRate);
    this.kernels = opts.channels.map((channel) =>
      GranularSourceKernel.fromModule(opts.module, sampleRate, opts.maxBlock, channel, opts.rate),
    );

    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as GranularSourceMessage | null;
      if (!message) return;
      if (message.kind === 'stop') {
        this.stopFrame = Math.round(message.when * sampleRate);
      } else if (message.kind === 'dispose' && this.kernels) {
        for (const kernel of this.kernels) kernel.destroy();
        this.kernels = null;
      }
    };
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const kernels = this.kernels;
    if (!kernels) return false; // disposed — release the processor (spec §3.2)
    const output = outputs[0];
    const first = output?.[0];
    if (!output || !first) return true;

    const blockFrames = first.length;
    const blockStart = currentFrame;
    // Not due yet: hold silence rather than consuming the region early.
    if (this.startFrame >= blockStart + blockFrames) return true;
    if (blockStart >= this.stopFrame) return this.finish();

    // Frames of this quantum the voice actually occupies, so its first sample lands exactly
    // where the scheduler placed it and a stolen voice stops exactly where it was cut.
    const from = Math.max(0, this.startFrame - blockStart);
    const to = Math.min(blockFrames, Math.max(0, this.stopFrame - blockStart));

    let written = 0;
    // One kernel per region channel, each advancing its own stream — so a kernel is stepped
    // exactly once per quantum even when the output carries more channels than the region.
    for (let channel = 0; channel < kernels.length && channel < output.length; channel++) {
      const target = output[channel]!;
      target.fill(0, 0, from);
      target.fill(0, to);
      if (to > from) {
        written = Math.max(
          written,
          kernels[channel]!.process(target.subarray(from, to), detuneOf(parameters)),
        );
      }
    }
    for (let channel = kernels.length; channel < output.length; channel++) {
      output[channel]!.set(first);
    }

    if (written > 0 && to > from) return true;
    return this.finish();
  }

  /** Report the end once and release the processor (spec §3.2). */
  private finish(): boolean {
    if (!this.ended) {
      this.ended = true;
      const message: GranularSourceMessage = { kind: 'ended' };
      this.port.postMessage(message);
    }
    return false;
  }
}

/** The block's detune in cents (k-rate, so a single value per quantum). */
function detuneOf(parameters: Record<string, Float32Array>): number {
  return parameters[GRANULAR_SOURCE_DETUNE]?.[0] ?? 0;
}

registerProcessor(GRANULAR_SOURCE_PROCESSOR, GranularSourceProcessor);
