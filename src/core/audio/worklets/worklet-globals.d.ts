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
