/**
 * WASM kernel module registry (spec §5.6.2) — the main thread compiles each worklet-hosted
 * kernel's `WebAssembly.Module` once (cached) so it can be handed to the DSP-effect worklet via
 * `processorOptions` (worklet scope has no `fetch`, §5.6.2). Loaded during the start gate
 * (spec §5.1) alongside the worklet modules; consumed synchronously by `buildEffectCore` when
 * building the `multibandComp` / `limiter` / `fdnReverb` inserts (spec §5.7), and by the
 * voice pool when building a §5.7.9 warp source.
 */
import { loadKernelModule } from './kernelLoader';
import { multibandCompWasmUrl } from './multibandCompKernel';
import { lookaheadLimiterWasmUrl } from './lookaheadLimiterKernel';
import { fdnReverbWasmUrl } from './fdnReverbKernel';
import { granularStretchWasmUrl } from './granularStretchKernel';

/**
 * The kernels a worklet hosts (spec §5.7, §5.7.9): the three DSP-effect engines, and
 * `granularStretch` for the warp source, which is a §5.2 stage-1 SOURCE rather than an
 * insert but is compiled and handed over by exactly the same §5.6.2 route.
 */
export type WorkletKernelName = 'multibandComp' | 'limiter' | 'fdnReverb' | 'granularStretch';

/**
 * The subset the DSP-effect worklet hosts (spec §5.7). `granularStretch` is excluded: it is
 * a §5.2 stage-1 source with its own processor, not an insert, and keeping it out of this
 * union is what makes that processor's kernel switch exhaustive rather than defensive.
 */
export type DspEffectKernelName = Exclude<WorkletKernelName, 'granularStretch'>;

const URL_FACTORIES: Record<WorkletKernelName, () => URL> = {
  multibandComp: multibandCompWasmUrl,
  limiter: lookaheadLimiterWasmUrl,
  fdnReverb: fdnReverbWasmUrl,
  granularStretch: granularStretchWasmUrl,
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
