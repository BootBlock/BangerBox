// Builds the shipped factory content — spec §9.8.
//
// Writes `public/factory/`: one `.mpcweb` archive per pack (§9.6 layout) plus the
// Zod-validated `index.json` catalogue. The directory is a GITIGNORED artefact regenerated
// ahead of `build`, the same discipline as the §5.6 WASM kernels — nothing here is
// committed.
//
// All audio is synthesised procedurally (§9.8 "Provenance") and the output is
// byte-deterministic across rebuilds (§9.8 "Build"): seeded PRNGs, derived ids, pinned
// timestamps and fixed zip entry mtimes. `factoryPacks.test.ts` proves that by building
// twice and comparing bytes — it is not merely asserted here.
//
//   npm run build:factory
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildAllPacks } from './factory/packs.mjs';
import { packArchive } from './factory/snapshot.mjs';

/** Spec §9.8: the total shipped payload stays under 8 MB. */
const PAYLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Repository root. Resolved lazily inside the CLI path only: the test suite imports
 * `buildFactory` from a Vite dev server, where `import.meta.url` is an http URL and
 * `fileURLToPath` would throw at module scope.
 */
function repositoryRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

/**
 * Build every pack and return the archives plus the catalogue. Exported so the test suite
 * can build in-memory, twice, without touching the file system (spec §9.8 determinism).
 */
export function buildFactory(appVersion) {
  const catalogue = [];
  const archives = [];

  for (const pack of buildAllPacks(appVersion)) {
    const bytes = packArchive({ snapshot: pack.snapshot, appVersion, wavs: pack.wavs });
    archives.push({ file: pack.entry.file, bytes, snapshot: pack.snapshot, wavs: pack.wavs });
    catalogue.push({ ...pack.entry, bytes: bytes.byteLength });
  }

  // Two spaces, trailing newline — matches the repo's Prettier JSON style so the artefact
  // reads the same as a committed file would.
  return { catalogue, archives, catalogueJson: `${JSON.stringify(catalogue, null, 2)}\n` };
}

function appVersionFromPackageJson(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return manifest.version;
}

function main() {
  const root = repositoryRoot();
  const outDir = resolve(root, 'public/factory');
  const { catalogue, archives, catalogueJson } = buildFactory(appVersionFromPackageJson(root));

  const total = archives.reduce((sum, archive) => sum + archive.bytes.byteLength, 0);
  if (total > PAYLOAD_LIMIT_BYTES) {
    console.error(
      `Factory payload is ${(total / 1024 / 1024).toFixed(2)} MB, over the ${PAYLOAD_LIMIT_BYTES / 1024 / 1024} MB limit (spec §9.8).`,
    );
    process.exit(1);
  }

  // Rebuild from clean so a renamed or removed pack cannot linger as a stale archive that
  // the catalogue no longer lists.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const archive of archives) writeFileSync(resolve(outDir, archive.file), archive.bytes);
  writeFileSync(resolve(outDir, 'index.json'), catalogueJson);

  for (const entry of catalogue) {
    console.log(
      `  ${entry.file.padEnd(24)} ${(entry.bytes / 1024).toFixed(0).padStart(6)} kB  ${entry.kind}`,
    );
  }
  console.log(`built ${catalogue.length} factory packs, ${(total / 1024 / 1024).toFixed(2)} MB total`);
}

// Only build when invoked as a script — importing this module (the determinism test does)
// must not write to the file system.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main();
}
