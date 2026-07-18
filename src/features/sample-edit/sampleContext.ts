/**
 * Shared helpers for the Phase 6 sample modes (Browser + Sample Edit) — build the import/edit
 * context from the active project stores (spec §4.2) and refresh the Browser sample cache
 * (spec §4.2 useBrowserStore) from the repositories. Keeps the two functional panels DRY.
 */
import { getActiveRepositories } from '@/core/project';
import type { ImportContext } from '@/core/audio/sampleImport';
import { useBrowserStore, useProjectStore } from '@/store';

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

/** Reload the current project's samples into the Browser store (spec §9.2 pages at 200). */
export async function refreshSamples(): Promise<void> {
  const { projectId } = useProjectStore.getState();
  if (!projectId) return;
  const page = await getActiveRepositories().samples.listByProject(projectId);
  useBrowserStore.getState().setSamples(page.rows);
}
