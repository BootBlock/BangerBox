/**
 * AudioContext bootstrap & start gate — spec §5.1. A single `AudioContext` is created at
 * the project sample rate with `latencyHint: 'interactive'` (locked decision §1.3 #18).
 * The browser autoplay policy requires `resume()` from a user gesture: the Start screen
 * calls {@link resumeAudioContext} inside the click before any audio runs, and re-surfaces
 * the gate on external suspension via `statechange` (spec §5.1). All worklet modules load
 * during the start gate (spec §5.1) via Vite's `?worker&url` real-file suffix (§2.7).
 */
// spec §2.7 / §14 2026-07-17 (e): worklet modules load as real es-format files.
import meterTapWorkletUrl from './worklets/meterTap.worklet.ts?worker&url';
import dspEffectWorkletUrl from './worklets/dspEffect.worklet.ts?worker&url';
import recorderWorkletUrl from './worklets/recorder.worklet.ts?worker&url';
import { loadKernelModules } from '@/core/dsp/kernelModules';
import { installCancelAndHoldPolyfill } from './params/cancelAndHold';

/** Create the single application AudioContext at the project sample rate (spec §5.1). */
export function createAudioContext(sampleRate: number): AudioContext {
  // Before any node exists, so every param the engine builds is recorded from its first
  // event (issue #109 — Firefox has no `cancelAndHoldAtTime`, and §5.4 declick needs it).
  installCancelAndHoldPolyfill();
  return new AudioContext({ latencyHint: 'interactive', sampleRate });
}

/** Resume from a user gesture (spec §5.1 start gate). Safe to call when already running. */
export async function resumeAudioContext(context: AudioContext): Promise<void> {
  if (context.state !== 'running') await context.resume();
}

/** Every AudioWorklet processor module the engine needs (loaded during the gate). */
const WORKLET_MODULE_URLS: readonly string[] = [meterTapWorkletUrl, dspEffectWorkletUrl, recorderWorkletUrl];

/**
 * Load all worklet processor modules AND compile the WASM kernel modules the DSP-effect
 * worklet hosts (spec §5.1 start gate). Worklet scope has no fetch, so the kernels are compiled
 * here on the main thread and handed over via processorOptions (spec §5.6.2).
 */
export async function loadAudioWorklets(context: BaseAudioContext): Promise<void> {
  for (const url of WORKLET_MODULE_URLS) {
    await context.audioWorklet.addModule(url);
  }
  await loadKernelModules();
}

/**
 * Prepare a (typically offline) context for the worklet-hosted effects: register the DSP-effect
 * processor and compile the kernel modules (spec §5.6.2). Used by the offline effect renders
 * (spec §11.2) so `multibandComp` / `limiter` / `fdnReverb` inserts build synchronously.
 */
export async function prepareWorkletEffects(context: BaseAudioContext): Promise<void> {
  await context.audioWorklet.addModule(dspEffectWorkletUrl);
  await loadKernelModules();
}
