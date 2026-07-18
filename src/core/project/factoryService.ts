/**
 * Factory content install service (spec §9.8).
 *
 * Fetches the `/factory/` catalogue and packs on demand, then installs a pack through the
 * EXISTING `.mpcweb` pipeline (spec §9.8 "Delivery format": no new format, no new pipeline,
 * no new dependency) — `unpackMpcwebInWorker` → Zod validation → `remapSnapshot` →
 * OPFS write → row insert. Nothing here forks that path.
 *
 * Two install modes (spec §9.8):
 *   • `demo` installs as a new project and opens it — literally the user-import path.
 *   • `kit`  MERGES into the active project: programs and samples in, sequences, tracks
 *            and song entries discarded.
 *
 * Both remap every UUID (§9.6) and both are transactional in the §9.6 sense. For `demo`
 * that is free — nothing is visible until the new project is opened. For `kit` it is not:
 * the merge writes into a LIVE project, so this module records every OPFS file it writes
 * and every row it inserts, and unwinds them on failure (see `installKitPack`).
 *
 * Installing is a storage-growing write, so it passes the §9.7 hard stop first — measured
 * against the pack's UNCOMPRESSED sample payload, before any OPFS write (spec §9.8).
 */
import { checkWriteHeadroom } from '@/core/storage/safeguards';
import { deleteFile, writeFileAtomic } from '@/core/storage/opfs';
import { programSchema } from './schemas';
import { useProgramStore, useUIStore } from '@/store';
import { parseFactoryCatalogue, type FactoryCatalogue, type FactoryPack } from './factoryCatalogue';
import { buildKitMerge, uncompressedSampleBytes } from './factoryMerge';
import { remapSnapshot } from './mpcweb';
import { unpackMpcwebInWorker } from './packClient';
import { getActiveRepositories, installUnpackedAsNewProject } from './projectService';
import type { UnpackedProject } from './mpcwebZip';

/** Directory the build writes and the service worker runtime-caches (spec §9.8). */
const FACTORY_DIR = 'factory';

/**
 * Thrown when a pack would breach the §9.7 headroom. Carries a distinct type so the UI can
 * offer the Browser-mode purge affordance rather than showing a generic failure (spec §9.8).
 */
export class FactoryStorageError extends Error {
  constructor(readonly requiredBytes: number) {
    super(
      'Not enough storage space to install this pack. Free space with “Purge unused samples” below, then try again.',
    );
    this.name = 'FactoryStorageError';
  }
}

/** Resolve a path under `/factory/`, honouring the deployment base path (spec §1.3 #14). */
function factoryUrl(file: string): string {
  return new URL(`${FACTORY_DIR}/${file}`, new URL(import.meta.env.BASE_URL, window.location.href)).href;
}

/**
 * Fetch and Zod-validate the pack catalogue (spec §9.8). A failure propagates so the
 * Browser-mode Factory section can surface it as a RETRYABLE error rather than rendering an
 * empty list that looks like "no content exists" (spec §8.5 item 7).
 */
export async function fetchFactoryCatalogue(signal?: AbortSignal): Promise<FactoryCatalogue> {
  const response = await fetch(factoryUrl('index.json'), { signal });
  if (!response.ok) {
    throw new Error(`Could not load the factory catalogue (HTTP ${response.status}).`);
  }
  return parseFactoryCatalogue(await response.json());
}

/**
 * Service-worker cache holding factory content (spec §9.8) — mirrors `FACTORY_CACHE` in
 * `src/sw.ts`. Read-only here: the page inspects the cache to tell the user whether a pack
 * is already available offline; only the worker ever writes it.
 */
const FACTORY_CACHE = 'bangerbox-factory-v1';

/**
 * Whether a pack is already in the runtime cache, so the Browser list can say when a pack
 * "is not yet cached" and will need downloading (spec §8.5 item 7). Absence of the Cache
 * API is reported as not-cached rather than thrown — it is an advisory label, not a gate.
 */
export async function isPackCached(pack: FactoryPack): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(FACTORY_CACHE);
    return (await cache.match(factoryUrl(pack.file))) !== undefined;
  } catch {
    return false;
  }
}

/** Fetch and unpack one pack's archive (spec §9.8; validated inside the pack worker, §9.6). */
async function fetchPack(pack: FactoryPack, signal?: AbortSignal): Promise<UnpackedProject> {
  const response = await fetch(factoryUrl(pack.file), { signal });
  if (!response.ok) {
    throw new Error(`Could not download “${pack.title}” (HTTP ${response.status}).`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return unpackMpcwebInWorker(bytes);
}

/**
 * The §9.7 hard stop, checked against what the pack will actually occupy once written
 * (spec §9.8). Runs BEFORE any OPFS write, so a refusal leaves nothing behind.
 */
async function assertStorageHeadroom(unpacked: UnpackedProject): Promise<void> {
  const required = uncompressedSampleBytes(unpacked.samples);
  const headroom = await checkWriteHeadroom(required);
  if (!headroom.allowed) throw new FactoryStorageError(required);
}

/**
 * Merge a `kit` pack's programs and samples into the active project (spec §9.8).
 *
 * Transactional by compensation: unlike a new-project import, these writes land in a
 * project the user is already working in, so there is no "nothing is visible until the end"
 * safety net. Every OPFS file written and every row inserted is recorded, and a failure at
 * any point unwinds them in reverse before rethrowing — leaving no partial merge and no
 * orphaned files (spec §9.8, §9.6).
 */
async function installKitPack(unpacked: UnpackedProject, projectId: string): Promise<void> {
  const { snapshot, sampleIdMap } = remapSnapshot(unpacked.snapshot);
  const merge = buildKitMerge(snapshot, projectId);
  const repos = getActiveRepositories();

  // Old sample id → its packed bytes, re-keyed onto the remapped ids the rows now carry.
  const bytesByNewId = new Map<string, Uint8Array>();
  for (const [oldId, data] of unpacked.samples) {
    const newId = sampleIdMap.get(oldId);
    if (newId) bytesByNewId.set(newId, data);
  }

  const writtenPaths: string[] = [];
  const insertedSamples: string[] = [];
  const insertedPrograms: string[] = [];

  try {
    for (const sample of merge.samples) {
      const data = bytesByNewId.get(sample.id);
      if (!data) throw new Error(`Pack is missing audio for sample “${sample.name}”.`);
      // Fresh ArrayBuffer-backed view — the OPFS stream API rejects shared buffers.
      await writeFileAtomic(sample.opfs_path, new Uint8Array(data));
      writtenPaths.push(sample.opfs_path);
    }

    for (const program of merge.programs) {
      await repos.programs.create({
        id: program.id,
        project_id: program.project_id,
        name: program.name,
        type: program.type,
        payload: program.payload,
      });
      insertedPrograms.push(program.id);
    }

    for (const sample of merge.samples) {
      await repos.samples.create({
        id: sample.id,
        project_id: sample.project_id,
        name: sample.name,
        opfs_path: sample.opfs_path,
        frames: sample.frames,
        sample_rate: sample.sample_rate,
        channels: sample.channels,
        root_note: sample.root_note,
      });
      insertedSamples.push(sample.id);
    }
  } catch (error) {
    await unwindKitMerge({ writtenPaths, insertedSamples, insertedPrograms });
    throw error;
  }

  // Publish the new programs to the runtime store so they appear without reloading the
  // project (spec §1.3 #16: Zustand is runtime truth, SQLite durable truth — both are now
  // written, so the store must not be left stale).
  for (const program of merge.programs) {
    useProgramStore.getState().addProgram(programSchema.parse(JSON.parse(program.payload)));
  }
}

/**
 * Undo a partial kit merge (spec §9.8 transactionality). Best-effort per item: one failed
 * cleanup must not abort the rest, or the "no orphaned files" guarantee degrades to
 * whichever item happened to fail first. The original error is what the caller sees.
 */
async function unwindKitMerge(applied: {
  writtenPaths: string[];
  insertedSamples: string[];
  insertedPrograms: string[];
}): Promise<void> {
  const repos = getActiveRepositories();
  for (const id of applied.insertedSamples) {
    try {
      await repos.samples.remove(id);
    } catch {
      // Already absent, or the DB is the thing that failed — nothing more to do here.
    }
  }
  for (const id of applied.insertedPrograms) {
    try {
      await repos.programs.remove(id);
    } catch {
      // As above.
    }
  }
  for (const path of applied.writtenPaths) {
    try {
      await deleteFile(path);
    } catch {
      // As above.
    }
  }
}

export interface InstallResult {
  readonly kind: FactoryPack['kind'];
  /** The project the pack landed in — newly created for a `demo`, the active one for a `kit`. */
  readonly projectId: string;
}

/**
 * Install a factory pack (spec §9.8). `demo` opens as a new project; `kit` merges into the
 * active one. Throws {@link FactoryStorageError} when the §9.7 hard stop refuses the write.
 */
export async function installFactoryPack(
  pack: FactoryPack,
  activeProjectId: string | null,
  signal?: AbortSignal,
): Promise<InstallResult> {
  const unpacked = await fetchPack(pack, signal);
  await assertStorageHeadroom(unpacked);

  if (pack.kind === 'demo') {
    return { kind: 'demo', projectId: await installUnpackedAsNewProject(unpacked) };
  }

  if (!activeProjectId) {
    throw new Error('Open a project before installing a kit — a kit merges into the project you are in.');
  }
  await installKitPack(unpacked, activeProjectId);
  return { kind: 'kit', projectId: activeProjectId };
}

/** Sample-count-free human summary used by the Browser list (spec §8.5 item 7). */
export function describeInstall(result: InstallResult, pack: FactoryPack): string {
  return result.kind === 'demo' ? `Opened “${pack.title}”.` : `Merged “${pack.title}” into this project.`;
}

/** Surface an install failure as a toast, keeping the storage refusal distinguishable. */
export function reportInstallFailure(error: unknown): void {
  const message =
    error instanceof FactoryStorageError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Could not install this pack.';
  useUIStore.getState().pushToast(message, 'error');
}
