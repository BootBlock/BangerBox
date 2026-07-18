/**
 * Project lifecycle service (spec §4.2, §4.4) — the concrete implementation the store
 * delegates to (spec §4.2). Owns the repositories, the active project's autosave queue,
 * and the create/load/save flows. Registered once at boot via {@link installProjectService};
 * `.mpcweb` export/import land in Phase 6 and are stubbed here.
 */
import { getDatabaseDriver } from '@/core/storage/client';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { readFile, samplePath, writeFileAtomic } from '@/core/storage/opfs';
import { useProjectStore, useUIStore } from '@/store';
import { AutosaveQueue } from './autosave';
import { registerAutosave, unregisterAutosave } from './dirty';
import { hydrateStores } from './hydrate';
import { remapSnapshot } from './mpcweb';
import { packMpcwebInWorker, unpackMpcwebInWorker } from './packClient';
import type { UnpackedProject } from './mpcwebZip';
import { flushDirtyKeys } from './persist';
import { planSharedSamples } from './sampleSharing';
import { registerProjectService, type ProjectService } from './service';
import { dumpSnapshot, restoreSnapshot } from './snapshotService';
import { createDefaultChannelStrip, createDefaultDrumProgram, createDefaultSequence } from './schemas';

let repositories: Repositories | null = null;
let queue: AutosaveQueue | null = null;

function getRepositories(): Repositories {
  repositories ??= createRepositories(getDatabaseDriver());
  return repositories;
}

/** Tear down the previous project's autosave queue before switching (spec §4.4). */
function teardownAutosave(): void {
  if (queue !== null) {
    queue.dispose();
    unregisterAutosave();
    queue = null;
  }
}

async function newProject(name = 'New Project'): Promise<string> {
  const repos = getRepositories();
  const project = await repos.projects.create({ name });

  // Seed the minimal playable skeleton: one drum program, one sequence, one track.
  const program = createDefaultDrumProgram('Program 1');
  await repos.programs.create({
    id: program.id,
    project_id: project.id,
    name: program.name,
    type: 'drum',
    payload: JSON.stringify(program),
  });

  const sequence = createDefaultSequence(project.id, 0, 'Sequence 1');
  await repos.sequences.create({
    id: sequence.id,
    project_id: project.id,
    position: sequence.position,
    name: sequence.name,
    length_bars: sequence.lengthBars,
    time_sig_numerator: sequence.timeSig.numerator,
    time_sig_denominator: sequence.timeSig.denominator,
    tempo: sequence.tempo,
    swing_amount: sequence.swingAmount,
    swing_division: sequence.swingDivision,
  });

  const trackId = crypto.randomUUID();
  await repos.tracks.create({
    id: trackId,
    sequence_id: sequence.id,
    program_id: program.id,
    position: 0,
    name: 'Track 1',
    type: 'drum',
    mixer: JSON.stringify(createDefaultChannelStrip(`track:${trackId}`)),
  });

  await loadProject(project.id);
  return project.id;
}

async function loadProject(id: string): Promise<void> {
  teardownAutosave();
  const repos = getRepositories();
  await hydrateStores(repos, id);

  queue = new AutosaveQueue({
    flush: (keys) => flushDirtyKeys(repos, keys),
    onError: () => useUIStore.getState().pushToast('Autosave failed — will retry.', 'warning'),
    onIdle: () => useProjectStore.getState().setModified(false),
  });
  registerAutosave(queue, { onDirty: () => useProjectStore.getState().setModified(true) });
}

async function saveNow(): Promise<void> {
  await queue?.flushNow();
}

/**
 * Export the active project as a `.mpcweb` archive (spec §9.6): flush autosave, dump the row
 * snapshot, read every referenced sample's WAV bytes from OPFS, then zip in the pack worker.
 */
async function exportMpcweb(): Promise<Blob> {
  await saveNow();
  const projectId = useProjectStore.getState().projectId;
  if (!projectId) throw new Error('No active project to export.');
  const repos = getRepositories();
  const snapshot = await dumpSnapshot(repos, projectId);

  const samples = await Promise.all(
    snapshot.samples.map(async (sample) => ({
      sampleId: sample.id,
      bytes: new Uint8Array(await (await readFile(sample.opfs_path)).arrayBuffer()),
    })),
  );

  const bytes = await packMpcwebInWorker({ snapshot, appVersion: __APP_VERSION__, samples });
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
}

/**
 * Import a `.mpcweb` archive as a new project (spec §9.6): unpack + validate in the worker, remap
 * every UUID so it never collides, write the samples to OPFS under the new ids, insert the rows
 * transactionally-ordered, and open the imported project. A mid-way failure leaves no partial
 * project because the new project id is only opened after all writes complete.
 */
async function importMpcweb(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return installUnpackedAsNewProject(await unpackMpcwebInWorker(bytes));
}

export interface InstallOptions {
  /**
   * Install samples into the content-addressed global library instead of under the new
   * project (spec §9.1, §9.8). Set by factory `demo` installs, whose audio is shipped content
   * the app can re-fetch and legitimately share with the kit pack that also carries it.
   *
   * A USER import must leave this unset: their project has to stay self-contained, and
   * promoting imported audio into a shared library would let one project's purge reach into
   * another's (spec §9.6).
   */
  readonly shareSamples?: boolean;
  /**
   * Gate the §9.7 hard stop against the bytes this install will actually add, once sharing
   * has removed what is already stored. Injected rather than imported so the factory layer
   * keeps ownership of its own refusal type without this module depending on it.
   */
  readonly assertHeadroom?: (requiredBytes: number) => Promise<void>;
}

/**
 * Install an already-unpacked `.mpcweb` payload as a NEW project and open it (spec §9.6).
 *
 * Shared by the user import above and the factory `demo` install (spec §9.8), which is why
 * it takes an unpacked payload rather than a File: §9.8 installs factory content "through
 * the same unpack → Zod-validate → UUID-remap → OPFS-write → row-insert path as a user
 * import", so there is one path here, not two. `options` varies that one path where factory
 * content legitimately differs from a user's, rather than forking it.
 */
export async function installUnpackedAsNewProject(
  unpacked: UnpackedProject,
  options: InstallOptions = {},
): Promise<string> {
  const { snapshot, projectId, sampleIdMap } = remapSnapshot(unpacked.snapshot);
  const repos = getRepositories();

  // Re-key the packed bytes onto the remapped ids the rows now carry.
  const bytesById = new Map<string, Uint8Array>();
  for (const [oldId, data] of unpacked.samples) {
    const newId = sampleIdMap.get(oldId);
    if (newId) bytesById.set(newId, data);
  }

  if (options.shareSamples) {
    const plan = await planSharedSamples(snapshot, bytesById, repos);
    await options.assertHeadroom?.(plan.writes.reduce((sum, write) => sum + write.bytes.byteLength, 0));
    for (const sample of plan.writes) {
      await writeFileAtomic(sample.opfs_path, new Uint8Array(sample.bytes));
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
    }
    // `plan.snapshot` carries no sample rows — they are global now, and its programs already
    // point at whichever stored copy won.
    await restoreSnapshot(repos, plan.snapshot);
    await loadProject(projectId);
    return projectId;
  }

  // Relocate each sample's bytes to its new OPFS path before inserting rows.
  for (const [newId, data] of bytesById) {
    // Copy into a fresh ArrayBuffer-backed view (the OPFS stream API rejects shared buffers).
    await writeFileAtomic(samplePath(projectId, newId), new Uint8Array(data));
  }

  await restoreSnapshot(repos, snapshot);
  await loadProject(projectId);
  return projectId;
}

export const projectService: ProjectService = {
  newProject,
  loadProject,
  saveNow,
  exportMpcweb,
  importMpcweb,
};

/** Register the lifecycle service so the store's lifecycle actions resolve (spec §4.2). */
export function installProjectService(): void {
  registerProjectService(projectService);
}

/** The active repository set — the only RPC clients (spec §3.1); used by Browser/Sample modes. */
export function getActiveRepositories(): Repositories {
  return getRepositories();
}

/** Open the most recently modified project, creating a first project if none exists (spec §8.5.1). */
export async function loadOrCreateActiveProject(): Promise<string> {
  const repos = getRepositories();
  const recent = await repos.projects.listRecent({ limit: 1 });
  const existing = recent.rows[0];
  if (existing !== undefined) {
    await loadProject(existing.id);
    return existing.id;
  }
  return newProject('First Project');
}

/** Flush and tear down the active project's autosave (Safe Mode / shutdown). */
export async function closeActiveProject(): Promise<void> {
  await queue?.flushNow();
  teardownAutosave();
}
