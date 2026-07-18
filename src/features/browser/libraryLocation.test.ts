/**
 * Library-location mapping (spec §8.5.7 folder tree, §9.1 layout, §9.3 scope). The tree, the
 * sample query and the import destination all derive from `currentPath` through these, so a
 * path that is misclassified would silently write a global sample into a project.
 */
import { describe, expect, it } from 'vitest';
import { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } from '@/core/storage/opfs';
import { isGlobalLibraryPath, scopeOfPath } from './libraryLocation';

describe('isGlobalLibraryPath (spec §9.1)', () => {
  it('recognises the global-library root and paths beneath it', () => {
    expect(isGlobalLibraryPath(GLOBAL_LIBRARY_ROOT)).toBe(true);
    expect(isGlobalLibraryPath(`${GLOBAL_LIBRARY_ROOT}/kick.wav`)).toBe(true);
  });

  it('rejects project paths and the bare root', () => {
    expect(isGlobalLibraryPath(projectSamplesRoot('p1'))).toBe(false);
    expect(isGlobalLibraryPath('/')).toBe(false);
  });

  it('does not match a directory that merely shares the prefix', () => {
    expect(isGlobalLibraryPath('/global_library_backup')).toBe(false);
  });
});

describe('scopeOfPath (spec §9.3)', () => {
  it('maps the global root to the global scope and everything else to the project', () => {
    expect(scopeOfPath(GLOBAL_LIBRARY_ROOT)).toBe('global');
    expect(scopeOfPath(projectSamplesRoot('p1'))).toBe('project');
    expect(scopeOfPath('/')).toBe('project');
  });
});
