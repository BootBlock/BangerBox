/**
 * Test helper (spec §11.2 / §11.3) — compile a built DSP kernel `.wasm` to a
 * `WebAssembly.Module` for the golden-output unit tests. Node has WebAssembly (unlike Web
 * Audio), so kernel numeric contracts are proven directly in Vitest. The artefacts are
 * gitignored (spec §2.5), so the helper builds them on demand for a fresh checkout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Compile a kernel module by name (e.g. 'lookaheadLimiter'), building all kernels if absent. */
export function loadBuiltKernel(name: string): WebAssembly.Module {
  const root = process.cwd();
  const wasmPath = resolve(root, `src/core/dsp/dist/${name}.wasm`);
  if (!existsSync(wasmPath)) {
    execFileSync(process.execPath, [resolve(root, 'scripts/build-wasm.mjs')], { stdio: 'inherit' });
  }
  return new WebAssembly.Module(readFileSync(wasmPath));
}
