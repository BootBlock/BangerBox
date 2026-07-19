/**
 * Vitest globalSetup (spec §11.2 / §11.3) — build the DSP kernel `.wasm` artefacts ONCE,
 * before any test worker starts.
 *
 * The artefacts are gitignored (spec §2.5), so a fresh checkout or worktree has none and
 * something has to build them on demand. Doing that from the test helper meant every kernel
 * test file raced to spawn its own `build-wasm` run: six concurrent `asc` processes writing
 * the same six output paths, which on Windows intermittently fails the whole run with a
 * locked output file (~1 run in 5), and even when it wins wastes six builds' worth of time.
 *
 * globalSetup is the seam that removes the race rather than retrying around it: it runs in
 * the main process, exactly once, with no workers alive to compete with it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Kernels whose artefacts the tests load — mirrors the registry in scripts/build-wasm.mjs. */
const KERNELS = [
  'gainProof',
  'lookaheadLimiter',
  'multibandComp',
  'fdnReverb',
  'transientDetect',
  'granularStretch',
];

export default function setup(): void {
  const root = process.cwd();
  const missing = KERNELS.filter((name) => !existsSync(resolve(root, `src/core/dsp/dist/${name}.wasm`)));
  if (missing.length === 0) return;
  // One build covers every kernel, so a single missing artefact is enough to justify the run.
  execFileSync(process.execPath, [resolve(root, 'scripts/build-wasm.mjs')], { stdio: 'inherit' });
}
