import { useState } from 'react';
import {
  gainProofWasmUrl,
  type GainProofResultMessage,
  type KernelDisposeMessage,
} from '@/core/dsp/gainProofKernel';
import { loadKernelModule } from '@/core/dsp/kernelLoader';
// spec §2.3.8/§2.7 (corrected via §14, 2026-07-17 (e)) — Vite's `?worker&url` suffix is
// the sanctioned way to build a worklet module as a REAL emitted file (es format, never
// an inline/blob URL): the bare `new URL('./x.worklet.ts', import.meta.url)` form has
// no build-time worklet handling in Vite 8 and inlines raw TypeScript as a data: URL.
import gainProofWorkletUrl from '../core/audio/worklets/gainProof.worklet.ts?worker&url';

/**
 * Engine self-test panel — proves the §5.6.2 worklet-module-transfer path end-to-end
 * in the Phase 0 shell: AudioContext (user gesture) → addModule → WASM compile on the
 * main thread → WebAssembly.Module via processorOptions → synchronous instantiation
 * inside the processor → real kernel DSP → result posted back and shown here. The
 * browser smoke test drives this control (§11.4).
 */
// STUB(phase-3): superseded by the real start gate + audio bootstrap of §5.1.

const PROOF_GAIN = 0.5;
const PROOF_TIMEOUT_MS = 5000;

type SelfTestStatus = 'idle' | 'running' | 'passed' | 'failed';

async function runEngineSelfTest(): Promise<string> {
  // spec §5.1 — interactive latency hint; created inside the click's user gesture.
  const audioContext = new AudioContext({ latencyHint: 'interactive' });
  try {
    // Worklet modules load as real files, never blob URLs (spec §2.3.8).
    await audioContext.audioWorklet.addModule(gainProofWorkletUrl);
    const module = await loadKernelModule(gainProofWasmUrl());
    const node = new AudioWorkletNode(audioContext, 'gain-proof', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { module, gain: PROOF_GAIN },
    });
    try {
      const proof = await new Promise<GainProofResultMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Worklet proof timed out — no result received.')),
          PROOF_TIMEOUT_MS,
        );
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data as GainProofResultMessage | null;
          if (data?.kind === 'proofResult') {
            clearTimeout(timer);
            resolve(data);
          }
        };
      });

      const tolerance = 1e-5;
      const matches =
        proof.output.length === proof.input.length &&
        proof.input.every(
          (value, i) => Math.abs((proof.output[i] ?? Number.NaN) - value * PROOF_GAIN) < tolerance,
        );
      if (!matches) {
        throw new Error(
          `Kernel output mismatch: expected input × ${PROOF_GAIN}, got [${proof.output.join(', ')}].`,
        );
      }
      const last = proof.input.length - 1;
      return (
        `WASM kernel applied gain ${PROOF_GAIN} inside the AudioWorklet ` +
        `(${proof.input[last]} → ${proof.output[last]}).`
      );
    } finally {
      // spec §5.6.3 — free kernel linear memory before the node is dropped.
      const dispose: KernelDisposeMessage = { kind: 'dispose' };
      node.port.postMessage(dispose);
      node.disconnect();
    }
  } finally {
    await audioContext.close();
  }
}

export function EngineSelfTest() {
  const [status, setStatus] = useState<SelfTestStatus>('idle');
  const [detail, setDetail] = useState('Not yet run.');

  const run = async () => {
    setStatus('running');
    setDetail('Loading worklet module and WASM kernel…');
    try {
      const summary = await runEngineSelfTest();
      setStatus('passed');
      setDetail(summary);
    } catch (error) {
      setStatus('failed');
      setDetail(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section aria-labelledby="engine-self-test-heading" className="mt-6">
      <h3 id="engine-self-test-heading" className="text-sm font-semibold">
        Engine self-test
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-bb-muted">
        Runs a WebAssembly DSP kernel inside an AudioWorklet to verify the audio engine foundations on this
        device.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          data-testid="engine-self-test-run"
          onClick={() => void run()}
          disabled={status === 'running'}
          className="rounded-bb-md bg-bb-accent px-4 py-2 text-sm font-semibold text-bb-bg transition-colors duration-150 hover:bg-bb-accent-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === 'running' ? 'Running…' : 'Run engine self-test'}
        </button>
        <span
          data-testid="engine-self-test-status"
          data-status={status}
          className={
            status === 'passed'
              ? 'text-sm font-semibold text-bb-ok'
              : status === 'failed'
                ? 'text-sm font-semibold text-bb-danger'
                : 'text-sm text-bb-muted'
          }
        >
          {status === 'idle' ? 'Idle' : status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
      </div>
      <p aria-live="polite" data-testid="engine-self-test-detail" className="mt-2 text-xs text-bb-muted">
        {detail}
      </p>
    </section>
  );
}
