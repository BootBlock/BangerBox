/**
 * Test helper (spec §11.2 / §11.3) — compile a built DSP kernel `.wasm` to a
 * `WebAssembly.Module` for the golden-output unit tests. Node has WebAssembly (unlike Web
 * Audio), so kernel numeric contracts are proven directly in Vitest.
 *
 * The artefacts are gitignored (spec §2.5) and built by the `globalSetup` in
 * src/test/buildKernels.ts, which runs once before any worker. This helper deliberately does
 * NOT build them itself: it runs inside a test worker, and every kernel test file calling it
 * meant six concurrent `asc` runs writing the same output paths.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Compile a kernel module by name (e.g. 'lookaheadLimiter') from its built artefact. */
export function loadBuiltKernel(name: string): WebAssembly.Module {
  const wasmPath = resolve(process.cwd(), `src/core/dsp/dist/${name}.wasm`);
  try {
    return new WebAssembly.Module(readFileSync(wasmPath));
  } catch (cause) {
    // Reading this from a worker means globalSetup did not run or did not produce the kernel
    // — say so, rather than surfacing a bare ENOENT that looks like a missing test fixture.
    throw new Error(
      `DSP kernel artefact missing or invalid: ${wasmPath}. It is built by the globalSetup in ` +
        'src/test/buildKernels.ts — run `npm run build:wasm` if you are loading it outside Vitest.',
      { cause },
    );
  }
}
