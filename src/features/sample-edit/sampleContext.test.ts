/**
 * `refreshSamples` query routing (spec §8.5.7, §9.2, §9.3). Which query the Browser list runs
 * follows the folder-tree selection; getting this wrong is what left the global library
 * unreachable, so the routing is pinned here rather than left to the panel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listByProject = vi.fn();
const listGlobal = vi.fn();
const getActiveRepositories = vi.fn(() => ({ samples: { listByProject, listGlobal } }));

vi.mock('@/core/project', () => ({ getActiveRepositories: () => getActiveRepositories() }));

const { refreshSamples } = await import('./sampleContext');
const { useBrowserStore, useProjectStore } = await import('@/store');
const { GLOBAL_LIBRARY_ROOT, projectSamplesRoot } = await import('@/core/storage/opfs');

const PROJECT_ROW = { id: 's1', name: 'Kick' };
const GLOBAL_ROW = { id: 's2', name: 'Shared snare' };

beforeEach(() => {
  vi.clearAllMocks();
  listByProject.mockResolvedValue({ rows: [PROJECT_ROW] });
  listGlobal.mockResolvedValue({ rows: [GLOBAL_ROW] });
  useProjectStore.setState({ projectId: 'p1' });
  useBrowserStore.setState({ currentPath: projectSamplesRoot('p1'), samples: [] });
});

describe('refreshSamples (spec §8.5.7)', () => {
  it('lists the active project when a project node is browsed', async () => {
    await refreshSamples();
    expect(listByProject).toHaveBeenCalledWith('p1');
    expect(listGlobal).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().samples).toEqual([PROJECT_ROW]);
  });

  it('lists the project-less rows when the global library is browsed', async () => {
    useBrowserStore.setState({ currentPath: GLOBAL_LIBRARY_ROOT });
    await refreshSamples();
    expect(listGlobal).toHaveBeenCalled();
    expect(listByProject).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().samples).toEqual([GLOBAL_ROW]);
  });

  it('reads the global library even with no project open', async () => {
    useProjectStore.setState({ projectId: '' });
    useBrowserStore.setState({ currentPath: GLOBAL_LIBRARY_ROOT });
    await refreshSamples();
    expect(useBrowserStore.getState().samples).toEqual([GLOBAL_ROW]);
  });

  it('does not touch the repositories when there is nothing to query', async () => {
    useProjectStore.setState({ projectId: '' });
    await refreshSamples();
    expect(getActiveRepositories).not.toHaveBeenCalled();
  });
});
