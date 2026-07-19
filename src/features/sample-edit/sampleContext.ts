/**
 * Shared helpers for the sample modes (Browser + Sample Edit) — build the import/edit
 * context from the active project stores (spec §4.2) and refresh the Browser sample cache
 * (spec §4.2 useBrowserStore) from the repositories. Keeps the two functional panels DRY.
 */
import { getActiveRepositories, getAudioEngine } from '@/core/project';
import type { ImportContext } from '@/core/audio/sampleImport';
import { useBrowserStore, useProjectStore, useUIStore } from '@/store';
import { isGlobalLibraryPath } from '../browser/libraryLocation';

/** The message of an unknown thrown value, for reporting a failure the user can act on. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

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

/**
 * The variant an effect can call: it records a query failure in the store instead of leaving
 * an unhandled rejection behind. {@link refreshSamples} still throws for the action flows
 * (import, purge, edit) that run inside a `try`/`catch` and report through a toast — there,
 * the toast names the action that failed, which is more use than "could not load samples".
 */
export async function reloadSampleList(): Promise<void> {
  try {
    await refreshSamples();
  } catch (error) {
    useBrowserStore.getState().setSamplesError(messageOf(error, 'The sample library could not be read.'));
  }
}

/**
 * Audition a sample through the preview channel (spec §5.9), reporting both ways it can fail.
 * With no engine the call used to be swallowed by an optional chain, so the button was dead
 * rather than disabled; a missing or corrupt OPFS file was silence indistinguishable from a
 * silent sample.
 */
export async function auditionSample(opfsPath: string, name: string): Promise<void> {
  const { pushToast } = useUIStore.getState();
  const engine = getAudioEngine();
  if (!engine) {
    pushToast('Start the audio engine before auditioning.', 'warning');
    return;
  }
  try {
    await engine.auditionSample(opfsPath);
  } catch (error) {
    pushToast(`Could not audition ${name}: ${messageOf(error, 'the audio could not be read.')}`, 'error');
  }
}
