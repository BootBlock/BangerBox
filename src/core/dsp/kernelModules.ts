/**
 * WASM kernel module registry (spec §5.6.2) — the main thread compiles each worklet-hosted
 * kernel's `WebAssembly.Module` once (cached) so it can be handed to the DSP-effect worklet via
 * `processorOptions` (worklet scope has no `fetch`, §5.6.2). Loaded during the start gate
 * (spec §5.1) alongside the worklet modules; consumed synchronously by `buildEffectCore` when
 * building the `multibandComp` / `limiter` / `fdnReverb` inserts (spec §5.7).
 */
import { loadKernelModule } from './kernelLoader';
import { multibandCompWasmUrl } from './multibandCompKernel';
import { lookaheadLimiterWasmUrl } from './lookaheadLimiterKernel';
import { fdnReverbWasmUrl } from './fdnReverbKernel';

/** The kernels hosted inside the DSP-effect worklet (spec §5.7). */
export type WorkletKernelName = 'multibandComp' | 'limiter' | 'fdnReverb';

const URL_FACTORIES: Record<WorkletKernelName, () => URL> = {
  multibandComp: multibandCompWasmUrl,
  limiter: lookaheadLimiterWasmUrl,
  fdnReverb: fdnReverbWasmUrl,
};

const modules = new Map<WorkletKernelName, WebAssembly.Module>();

/** Compile and cache every worklet kernel module (idempotent — spec §5.1 start gate). */
export async function loadKernelModules(): Promise<void> {
  await Promise.all(
    (Object.keys(URL_FACTORIES) as WorkletKernelName[]).map(async (name) => {
      if (modules.has(name)) return;
      modules.set(name, await loadKernelModule(URL_FACTORIES[name]()));
    }),
  );
}

/** The compiled module for a kernel, or undefined if the modules have not been loaded yet. */
export function getKernelModule(name: WorkletKernelName): WebAssembly.Module | undefined {
  return modules.get(name);
}
