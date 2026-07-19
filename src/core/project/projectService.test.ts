/**
 * Project switch flushes autosave (spec §4.4) — the write-behind queue is flushed
 * "immediately on `visibilitychange → hidden` and before project switch/export".
 *
 * The switch is the case worth pinning: `dispose()` clears the dirty set without writing
 * it, so an edit made inside the debounce window is dropped — and dropped silently, since
 * a cleared set never reaches `onIdle` while the incoming hydration calls `setModified(false)`
 * and clears the dot that represented the loss.
 *
 * Everything below the service is mocked so the ordering the service owns is what is proven.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/core/storage/client', () => ({ getDatabaseDriver: () => ({}) }));

const projectCreate = vi.fn(async ({ name }: { name: string }) => ({ id: 'new-project', name }));
vi.mock('@/core/storage/repositories', () => ({
  createRepositories: () => ({
    projects: { create: projectCreate },
    programs: { create: vi.fn() },
    sequences: { create: vi.fn() },
    tracks: { create: vi.fn() },
  }),
}));

/** Records the call order against the flush, which is the whole point of the test. */
const calls: string[] = [];
const flushDirtyKeys = vi.fn(async (_repos: unknown, keys: readonly string[]) => {
  calls.push(`flush:${[...keys].sort().join(',')}`);
});
vi.mock('./persist', () => ({
  flushDirtyKeys: (repos: unknown, keys: readonly string[]) => flushDirtyKeys(repos, keys),
}));

const hydrateStores = vi.fn(async () => {
  calls.push('hydrate');
});
vi.mock('./hydrate', () => ({ hydrateStores: () => hydrateStores() }));

const { projectService } = await import('./projectService');
const { markDirty } = await import('./dirty');
const { useProjectStore } = await import('@/store');

beforeEach(() => {
  calls.length = 0;
  flushDirtyKeys.mockClear();
  hydrateStores.mockClear();
});

describe('project switch', () => {
  it('writes edits made inside the debounce window before switching', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    markDirty('events:track-1');
    // No timer advance: the debounce has NOT elapsed, so only an explicit flush can save this.

    await projectService.loadProject('project-b');

    expect(flushDirtyKeys).toHaveBeenCalledTimes(1);
    expect(flushDirtyKeys.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(['sequence:seq-1', 'events:track-1']),
    );
  });

  it('flushes the outgoing project before hydrating the incoming one', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');

    await projectService.loadProject('project-b');

    // The flush writes from store state, which still holds the outgoing project until
    // hydration replaces it — so flushing after hydrate would persist the wrong project.
    expect(calls).toEqual(['hydrate', 'flush:sequence:seq-1', 'hydrate']);
  });

  it('leaves the switched-to project unmodified, having actually saved', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    expect(useProjectStore.getState().modifiedSinceLastSave).toBe(true);

    await projectService.loadProject('project-b');

    // The dot may only be down because the work reached storage, not because it was dropped.
    expect(flushDirtyKeys).toHaveBeenCalled();
    expect(useProjectStore.getState().modifiedSinceLastSave).toBe(false);
  });

  it('flushes on New Project, which routes through the same switch', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');

    await projectService.newProject();

    expect(flushDirtyKeys).toHaveBeenCalledWith(expect.anything(), ['sequence:seq-1']);
  });
});
