/**
 * gain-proof AudioWorkletProcessor — the Phase 0 proof of the worklet-module-transfer
 * path (spec §5.6.2): the precompiled WebAssembly.Module arrives via processorOptions
 * and is instantiated synchronously in the constructor. At construction it renders a
 * known ramp through the kernel once and posts the result, so the app (and the browser
 * smoke test) can assert real WASM DSP ran inside the worklet.
 */
import {
  GainProofKernel,
  type GainProofResultMessage,
  type KernelDisposeMessage,
} from '../../dsp/gainProofKernel';

interface GainProofProcessorOptions {
  module: WebAssembly.Module;
  gain: number;
}

const PROOF_FRAMES = 8;
const MAX_BLOCK = 128;

class GainProofProcessor extends AudioWorkletProcessor {
  private kernel: GainProofKernel | null;
  /** Pre-allocated silent input block — nothing allocates in process() (spec §5.5). */
  private readonly silence = new Float32Array(MAX_BLOCK);

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { module, gain } = options.processorOptions as unknown as GainProofProcessorOptions;
    this.kernel = GainProofKernel.fromModule(module, sampleRate, MAX_BLOCK);
    this.kernel.setGain(gain);

    // One-off construction-time proof render: a known ramp through the WASM kernel.
    const input = new Float32Array(PROOF_FRAMES);
    for (let i = 0; i < PROOF_FRAMES; i++) input[i] = (i + 1) / PROOF_FRAMES;
    const output = new Float32Array(PROOF_FRAMES);
    this.kernel.process(input, output);
    const message: GainProofResultMessage = {
      kind: 'proofResult',
      input: Array.from(input),
      output: Array.from(output),
    };
    this.port.postMessage(message);

    // spec §5.6.3 — the worklet frees kernel memory in response to a dispose message
    // before the node is disconnected.
    this.port.onmessage = (event: MessageEvent) => {
      if ((event.data as KernelDisposeMessage | null)?.kind === 'dispose') {
        this.kernel?.destroy();
        this.kernel = null;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const kernel = this.kernel;
    // After dispose, return false so the processor is released (§3.2).
    if (!kernel) return false;
    const channel = outputs[0]?.[0];
    // Keep exercising the kernel each quantum (silence in, silence out) so the render
    // path stays live until disposed; no allocation occurs here (spec §5.5).
    if (channel) kernel.process(this.silence, channel);
    return true;
  }
}

registerProcessor('gain-proof', GainProofProcessor);
