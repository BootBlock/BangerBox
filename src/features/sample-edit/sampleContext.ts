/**
 * Shared helpers for the Phase 6 sample modes (Browser + Sample Edit) — build the import/edit
 * context from the active project stores (spec §4.2) and refresh the Browser sample cache
 * (spec §4.2 useBrowserStore) from the repositories. Keeps the two functional panels DRY.
 */
import { getActiveRepositories } from '@/core/project';
import type { ImportContext } from '@/core/audio/sampleImport';
import { useBrowserStore, useProjectStore } from '@/store';
import { isGlobalLibraryPath } from '../browser/libraryLocation';

/** The edit/import context (repos + project audio settings) for the sample services. */
export function sampleEditContext(): Omit<ImportContext, 'context'> {
  const project = useProjectStore.getState();
  return {
    repos: getActiveRepositories(),
    projectId: project.projectId,
    projectSampleRate: project.sampleRate,
    projectBitDepth: project.bitDepth,
  };
}

/**
 * Reload the browsed location's samples into the Browser store (spec §9.2 pages at 200).
 * Which query runs follows the folder-tree selection (spec §8.5.7): the global-library node
 * lists the project-less rows (§9.3), any other node lists the active project's.
 */
export async function refreshSamples(): Promise<void> {
  const { currentPath } = useBrowserStore.getState();
  const global = isGlobalLibraryPath(currentPath);
  const { projectId } = useProjectStore.getState();
  // Decide before touching the repositories: reaching for them with nothing to query would
  // spin up the DB worker in environments that have none.
  if (!global && !projectId) return;
  const repos = getActiveRepositories();
  const page = global ? await repos.samples.listGlobal() : await repos.samples.listByProject(projectId);
  useBrowserStore.getState().setSamples(page.rows);
}
