// Builds every AssemblyScript DSP kernel to WASM — spec §5.6, §1.3 #5 (npm-only
// toolchain) and §2.7 (asc with `--runtime stub -O3`; manual buffer lifetimes).
// Output goes to src/core/dsp/dist/ (gitignored; rebuilt on demand).
//
//   npm run build:wasm
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const assemblyDir = resolve(root, 'src/core/dsp/assembly');
const outDir = resolve(root, 'src/core/dsp/dist');

// Resolve asc the way Node resolves everything else — walking up from this script — rather
// than pinning `<root>/node_modules`. A `git worktree` has no node_modules of its own and
// inherits the parent checkout's, which is how vitest and the app deps already resolve
// there; pinning made this the one step that broke (#88).
let ascEntry;
try {
  ascEntry = createRequire(import.meta.url).resolve('assemblyscript/bin/asc.js');
} catch {
  console.error(
    'assemblyscript is not installed — run `npm install` (in this worktree, or in the ' +
      'checkout it was created from).',
  );
  process.exit(1);
}

/** Kernel registry: one entry per AssemblyScript source (spec §5.6.4 grows this list). */
const kernels = [
  'gainProof',
  'lookaheadLimiter',
  'multibandComp',
  'fdnReverb',
  'transientDetect',
  'granularStretch',
];

mkdirSync(outDir, { recursive: true });

let failed = false;
for (const kernel of kernels) {
  const source = resolve(assemblyDir, `${kernel}.ts`);
  const outFile = resolve(outDir, `${kernel}.wasm`);
  // spec §2.7 pinned form: `--runtime stub -O3` — no incremental GC in the render path.
  // `--use abort=` compiles the env.abort import out (a trap instead), so kernel
  // modules are import-free and consumers never supply an import object (§5.6.1 seam).
  const args = [ascEntry, source, '--outFile', outFile, '--runtime', 'stub', '-O3', '--use', 'abort='];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status === 0) {
    console.log(`built ${kernel}.wasm`);
  } else {
    console.error(`asc failed for ${kernel} (exit ${result.status})`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
