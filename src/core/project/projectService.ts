/**
 * Project lifecycle service (spec §4.2, §4.4) — the concrete implementation the store
 * delegates to (spec §4.2). Owns the repositories, the active project's autosave queue,
 * and the create/load/save flows. Registered once at boot via {@link installProjectService};
 * `.mpcweb` export/import land in Phase 6 and are stubbed here.
 */
import { getDatabaseDriver } from '@/core/storage/client';
import { createRepositories, type Repositories } from '@/core/storage/repositories';
import { useProjectStore, useUIStore } from '@/store';
import { AutosaveQueue } from './autosave';
import { registerAutosave, unregisterAutosave } from './dirty';
import { hydrateStores } from './hydrate';
import { flushDirtyKeys } from './persist';
import { registerProjectService, type ProjectService } from './service';
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

async function exportMpcweb(): Promise<Blob> {
  // STUB(phase-6): .mpcweb pack pipeline (spec §9.6) is not built until Phase 6.
  throw new Error('Project export (.mpcweb) arrives in Phase 6.');
}

async function importMpcweb(_file: File): Promise<string> {
  // STUB(phase-6): .mpcweb unpack/import pipeline (spec §9.6) is not built until Phase 6.
  throw new Error('Project import (.mpcweb) arrives in Phase 6.');
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
