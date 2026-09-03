/**
 * Ambient declarations for the AudioWorkletGlobalScope — TypeScript ships no lib for
 * worklet scope, so the processor base class and registration function are declared
 * here (used only by *.worklet.ts modules).
 */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

/** The context sample rate, exposed as a global inside the worklet scope. */
declare const sampleRate: number;

/**
 * The frame index of the first sample of the current render quantum, in the same domain as
 * `currentTime × sampleRate`. The warp source (spec §5.7.9) uses it to begin and end a
 * voice on an exact frame rather than on a quantum boundary.
 */
declare const currentFrame: number;

/** One entry of a processor's `parameterDescriptors` (spec §4.3 worklet parameters). */
interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}
