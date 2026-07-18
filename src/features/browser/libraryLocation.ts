/**
 * Browser-mode library locations (spec §8.5.7 "folder tree (projects/global)", §9.1).
 *
 * The folder tree has two roots — the active project's samples and the global library —
 * and `useBrowserStore.currentPath` holds whichever is selected as a canonical §9.1 OPFS
 * directory path. This module is the single place that maps between the two, so the tree,
 * the sample query and the import destination cannot disagree about where "here" is.
 */
import { GLOBAL_LIBRARY_ROOT } from '@/core/storage/opfs';
import type { SampleScope } from '@/core/audio/sampleImport';

/** True when `currentPath` addresses the global library rather than a project. */
export function isGlobalLibraryPath(path: string): boolean {
  return path === GLOBAL_LIBRARY_ROOT || path.startsWith(`${GLOBAL_LIBRARY_ROOT}/`);
}

/** The write scope (spec §9.3) implied by the browsed location. */
export function scopeOfPath(path: string): SampleScope {
  return isGlobalLibraryPath(path) ? 'global' : 'project';
}
