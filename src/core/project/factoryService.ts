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
 * and every row it inserts, and unwinds them on failure (see `applyKitMerge`).
 *
 * That same record is what makes a SUCCESSFUL kit merge undoable (spec §4.5). A demo install
 * is harmless to mis-tap — it lands in a new project — but a kit merges into the project the
 * user is working in, and before this the only recourse was the §8.5.7 purge, which would take
 * the user's own unreferenced samples along with the kit's. So the merge pushes one composite
 * undo entry ("Install …") whose undo replays the compensation and whose redo replays the
 * merge, both over the retained {@link KitMergeRecord}.
 *
 * Installing is a storage-growing write, so it passes the §9.7 hard stop first — measured
 * against the pack's UNCOMPRESSED sample payload, before any OPFS write (spec §9.8).
 */
import { checkWriteHeadroom, StorageHeadroomError } from '@/core/storage/safeguards';
import { deleteFile, writeFileAtomic } from '@/core/storage/opfs';
import type { Repositories } from '@/core/storage/repositories';
import { programSchema } from './schemas';
import { pushUndo, useProgramStore, useUIStore } from '@/store';
import type { Program } from './schemas';
import { parseFactoryCatalogue, type FactoryCatalogue, type FactoryPack } from './factoryCatalogue';
import { buildKitMerge, type KitMerge } from './factoryMerge';
import { planSharedSamples, type SharedSampleWrite } from './sampleSharing';
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
export class FactoryStorageError extends StorageHeadroomError {
  constructor(requiredBytes: number) {
    super(requiredBytes);
    this.message =
      'Not enough storage space to install this pack. Free space with “Purge unused samples” below, then try again.';
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
 * The §9.7 hard stop, checked against what the install will actually ADD to storage
 * (spec §9.8). Runs BEFORE any OPFS write, so a refusal leaves nothing behind.
 *
 * Sized on the bytes still to be written, not on the pack's whole payload: once samples are
 * de-duplicated against the global library (§9.8), a demo whose kit is already installed adds
 * almost nothing, and gating it on the full payload would refuse an install that needs no room.
 */
async function assertStorageHeadroom(required: number): Promise<void> {
  const headroom = await checkWriteHeadroom(required);
  if (!headroom.allowed) throw new FactoryStorageError(required);
}

/** Map a pack's remapped sample ids to the bytes the archive shipped for them (spec §9.6). */
function bytesByRemappedId(
  unpacked: UnpackedProject,
  sampleIdMap: ReadonlyMap<string, string>,
): Map<string, Uint8Array> {
  const bytes = new Map<string, Uint8Array>();
  for (const [oldId, data] of unpacked.samples) {
    const newId = sampleIdMap.get(oldId);
    if (newId) bytes.set(newId, data);
  }
  return bytes;
}

/**
 * Write a plan's samples into the content-addressed global library (spec §9.1, §9.8).
 *
 * Returns the paths written and rows inserted so a failing install can unwind exactly what it
 * added. Reused samples appear in neither list — they were already installed, possibly by a
 * pack the user still has, so undoing this install must never remove them.
 *
 * Idempotent, because REDO runs it too: between an undo and its redo another install may have
 * adopted the same content-addressed path, in which case the bytes are already stored and this
 * install owns nothing to re-add. `planSharedSamples` has made the check redundant on the
 * first pass, but doing it here is what lets one function serve both.
 */
async function installSharedSamples(
  writes: readonly SharedSampleWrite[],
  repos: Repositories,
  written: string[],
  inserted: string[],
): Promise<void> {
  const missing: SharedSampleWrite[] = [];
  for (const sample of writes) {
    if ((await repos.samples.getGlobalByPath(sample.opfs_path)) === undefined) missing.push(sample);
  }

  for (const sample of missing) {
    // Fresh ArrayBuffer-backed view — the OPFS stream API rejects shared buffers.
    await writeFileAtomic(sample.opfs_path, new Uint8Array(sample.bytes));
    written.push(sample.opfs_path);
  }
  for (const sample of missing) {
    await repos.samples.create({
      id: sample.id,
      // NULL project id IS the global-library encoding (spec §9.3).
      project_id: null,
      name: sample.name,
      opfs_path: sample.opfs_path,
      frames: sample.frames,
      sample_rate: sample.sample_rate,
      channels: sample.channels,
      root_note: sample.root_note,
    });
    inserted.push(sample.id);
  }
}

/**
 * Everything one kit merge contributes, retained for the lifetime of its undo entry so the
 * merge can be reversed and replayed (spec §4.5, §9.8).
 *
 * Holding the sample BYTES is what costs something here, and it is deliberate: undo has to
 * free the storage the install consumed — that quota is half of why a mis-tapped kit hurts —
 * so redo cannot recover the audio from OPFS and must carry its own copy. A shipped kit is
 * ~14 sub-second one-shots, on the order of a megabyte, held until the §2.6 undo depth evicts
 * the entry. The alternative — re-fetching the pack on redo — trades that for a redo that can
 * fail offline, which is the worse deal for an app whose first premise is offline-first (§1.1).
 */
interface KitMergeRecord {
  /** Samples this install would add; reused ones are absent (see {@link planSharedSamples}). */
  readonly writes: readonly SharedSampleWrite[];
  /** Program rows re-parented onto the active project (spec §9.8). */
  readonly programs: KitMerge['programs'];
}

/** The runtime form of a merged program row — the store holds parsed programs, not payloads. */
function runtimeProgram(program: KitMergeRecord['programs'][number]): Program {
  return programSchema.parse(JSON.parse(program.payload));
}

/**
 * Plan a `kit` merge into the active project without writing anything (spec §9.8).
 *
 * Split from {@link applyKitMerge} because only the FIRST install plans: it remaps ids, decides
 * what de-duplicates against the global library, and passes the §9.7 hard stop. A redo replays
 * the resulting record as-is — re-planning would mint fresh ids and the undo entry would no
 * longer describe what is actually stored.
 */
async function planKitMerge(unpacked: UnpackedProject, projectId: string): Promise<KitMergeRecord> {
  const repos = getActiveRepositories();
  const { snapshot, sampleIdMap } = remapSnapshot(unpacked.snapshot);

  // De-duplicate against the global library before sizing the write: a kit whose audio is
  // already installed (its demo got there first) adds nothing and must not be refused (§9.8).
  const plan = await planSharedSamples(snapshot, bytesByRemappedId(unpacked, sampleIdMap), repos);
  await assertStorageHeadroom(plan.writes.reduce((sum, write) => sum + write.bytes.byteLength, 0));

  return { writes: plan.writes, programs: buildKitMerge(plan.snapshot, projectId).programs };
}

/**
 * Write a planned kit merge into the active project (spec §9.8) — the initial install and
 * every redo of it.
 *
 * Transactional by compensation: unlike a new-project import, these writes land in a
 * project the user is already working in, so there is no "nothing is visible until the end"
 * safety net. Every OPFS file written and every row inserted is recorded, and a failure at
 * any point unwinds them in reverse before rethrowing — leaving no partial merge and no
 * orphaned files (spec §9.8, §9.6).
 *
 * No §9.7 gate on the redo path: redo restores exactly the bytes its undo freed, so it is not
 * storage-growing relative to the state the user last chose. Should the space have gone
 * elsewhere meanwhile, the OPFS write fails and unwinds like any other mid-merge failure.
 */
async function applyKitMerge(record: KitMergeRecord): Promise<void> {
  const repos = getActiveRepositories();

  const writtenPaths: string[] = [];
  const insertedSamples: string[] = [];
  const insertedPrograms: string[] = [];

  try {
    await installSharedSamples(record.writes, repos, writtenPaths, insertedSamples);

    for (const program of record.programs) {
      await repos.programs.create({
        id: program.id,
        project_id: program.project_id,
        name: program.name,
        type: program.type,
        payload: program.payload,
      });
      insertedPrograms.push(program.id);
    }
  } catch (error) {
    await unwindKitMerge({ writtenPaths, insertedSamples, insertedPrograms });
    throw error;
  }

  // Publish the new programs to the runtime store so they appear without reloading the
  // project (spec §1.3 #16: Zustand is runtime truth, SQLite durable truth — both are now
  // written, so the store must not be left stale). `mergePrograms`, not `addProgram`: the
  // caller pushes ONE undo entry for the merge, so the store must not push one per program.
  useProgramStore.getState().mergePrograms(record.programs.map(runtimeProgram));
}

/**
 * Undo a merged kit: take back its programs, then the audio nothing else still plays
 * (spec §4.5, §9.8).
 *
 * Programs go first, and not only because it reverses the install order. The samples are in the
 * shared global library, and between this install and this undo another pack may have ADOPTED
 * one of them — `planSharedSamples` reuses a stored row rather than writing a second copy, so
 * "this install wrote it" stops meaning "this install is its only owner". So each sample is put
 * to the §8.5.7 question — does any program left in the database reference it? — which is only
 * answerable once the kit's own programs, which reference all of them, are gone.
 *
 * Best-effort per item, as {@link unwindKitMerge} is and for the same reason: one failed step
 * must not strand the rest half-removed.
 */
async function revertKitMerge(record: KitMergeRecord): Promise<void> {
  const repos = getActiveRepositories();

  useProgramStore.getState().dropPrograms(record.programs.map((program) => program.id));
  for (const program of record.programs) {
    try {
      await repos.programs.remove(program.id);
    } catch {
      // Already absent, or the DB is the thing that failed — nothing more to do here.
    }
  }

  // Unpaged deliberately (spec §8.5.7): a payload missed past a page boundary reads as
  // "nothing references this" and the sample is deleted out from under whatever does.
  const payloads = await repos.programs.allPayloads();
  const orphaned = record.writes.filter((write) => !payloads.some((payload) => payload.includes(write.id)));
  await unwindKitMerge({
    writtenPaths: orphaned.map((write) => write.opfs_path),
    insertedSamples: orphaned.map((write) => write.id),
    insertedPrograms: [],
  });
}

/**
 * Run one leg of the kit-merge undo entry. The §4.5 command stack is synchronous — every other
 * undoable action is a store mutation — but this one has to reach OPFS and SQLite, so it is
 * fired and its failure reported as a toast rather than thrown into the stack, which has
 * already moved the entry by the time the work settles.
 */
function runKitMergeStep(work: () => Promise<void>, failureMessage: string): void {
  void work().catch(() => {
    useUIStore.getState().pushToast(failureMessage, 'error');
  });
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

  if (pack.kind === 'demo') {
    // Both install modes share their samples; each checks headroom against its own de-duplicated
    // write set, so the gate lives inside them rather than on the whole payload out here (§9.8).
    const projectId = await installUnpackedAsNewProject(unpacked, {
      shareSamples: true,
      assertHeadroom: assertStorageHeadroom,
    });
    return { kind: 'demo', projectId };
  }

  if (!activeProjectId) {
    throw new Error('Open a project before installing a kit — a kit merges into the project you are in.');
  }
  const record = await planKitMerge(unpacked, activeProjectId);
  await applyKitMerge(record);

  // A kit merges into the project the user is already in, so a mis-tap must be reversible
  // (spec §4.5). One entry for the whole merge — programs and audio together.
  pushUndo({
    label: `Install “${pack.title}”`,
    undo: () => runKitMergeStep(() => revertKitMerge(record), `Could not fully remove “${pack.title}”.`),
    redo: () => runKitMergeStep(() => applyKitMerge(record), `Could not reinstall “${pack.title}”.`),
  });
  return { kind: 'kit', projectId: activeProjectId };
}

/**
 * Sample-count-free human summary used by the Browser list (spec §8.5 item 7).
 *
 * A kit's message names the global library because that is where its audio actually goes
 * (§9.1, §9.8 de-duplication — see `buildKitMerge`): only the PROGRAMS are re-parented onto
 * the open project. "Merged into this project" alone left the user watching an unchanged
 * project sample list, with nothing to say the audio had landed one node over.
 */
export function describeInstall(result: InstallResult, pack: FactoryPack): string {
  return result.kind === 'demo'
    ? `Opened “${pack.title}”.`
    : `Merged “${pack.title}” into this project — its samples are in the global library.`;
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
