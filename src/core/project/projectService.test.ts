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
let flushFailure: Error | null = null;
const flushDirtyKeys = vi.fn(async (_repos: unknown, keys: readonly string[]) => {
  calls.push(`flush:${[...keys].sort().join(',')}`);
  if (flushFailure) throw flushFailure;
});
vi.mock('./persist', () => ({
  flushDirtyKeys: (repos: unknown, keys: readonly string[]) => flushDirtyKeys(repos, keys),
}));

const hydrateStores = vi.fn(async () => {
  calls.push('hydrate');
});
vi.mock('./hydrate', () => ({ hydrateStores: () => hydrateStores() }));

// --- export seams (spec §9.6) -------------------------------------------------------------
const SAMPLE_ROWS = [
  { id: 'sample-a', name: 'kick', opfs_path: '/projects/p/samples/a.wav' },
  { id: 'sample-b', name: 'snare', opfs_path: '/projects/p/samples/b.wav' },
];
const dumpSnapshot = vi.fn(async () => ({ version: 1, samples: [...SAMPLE_ROWS] }));
vi.mock('./snapshotService', () => ({
  dumpSnapshot: () => dumpSnapshot(),
  restoreSnapshot: vi.fn(),
}));

/** Paths whose read fails, standing in for a sample whose OPFS file is gone. */
const unreadablePaths = new Set<string>();
vi.mock('@/core/storage/opfs', () => ({
  samplePath: (projectId: string, sampleId: string) => `/projects/${projectId}/samples/${sampleId}.wav`,
  readFile: async (path: string) => {
    if (unreadablePaths.has(path)) throw new DOMException('gone', 'NotFoundError');
    return new Blob([new Uint8Array([1, 2, 3])]);
  },
  writeFileAtomic: vi.fn(),
  deleteFile: vi.fn(),
}));

const packMpcwebInWorker = vi.fn(async () => new Uint8Array([0x50, 0x4b]));
vi.mock('./packClient', () => ({
  packMpcwebInWorker: (input: unknown) => packMpcwebInWorker(input as never),
  unpackMpcwebInWorker: vi.fn(),
}));

const { projectService, closeActiveProject } = await import('./projectService');
const { markDirty } = await import('./dirty');
const { useProjectStore, useUIStore } = await import('@/store');

beforeEach(() => {
  calls.length = 0;
  flushFailure = null;
  unreadablePaths.clear();
  packMpcwebInWorker.mockClear();
  useUIStore.setState({ toasts: [] });
  flushDirtyKeys.mockClear();
  hydrateStores.mockClear();
  projectCreate.mockClear();
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

/**
 * Issue #103: the flush before a switch happened but its outcome was discarded, so a switch
 * proceeded over work that had NOT reached storage — and `dispose()` then cleared the batch
 * the queue had re-queued for retry. The toast named the loss while hydration removed the
 * project the user would have exported from.
 */
describe('project switch — a failed flush refuses the switch (spec §4.4)', () => {
  it('does not hydrate the incoming project when the outgoing flush fails', async () => {
    await projectService.loadProject('project-a');
    calls.length = 0;
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');

    await expect(projectService.loadProject('project-b')).rejects.toThrow(/not saved|could not/i);

    // One flush attempt, and no hydration after it: the user is still on project-a.
    expect(calls).toEqual(['flush:sequence:seq-1']);
  });

  it('says what it could not save', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    markDirty('track:trk-1');
    flushFailure = new Error('quota exceeded');

    await expect(projectService.loadProject('project-b')).rejects.toThrow(/sequence/i);
  });

  it('leaves the unsaved dot up rather than clearing it behind the refusal', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');

    await expect(projectService.loadProject('project-b')).rejects.toThrow();
    expect(useProjectStore.getState().modifiedSinceLastSave).toBe(true);
  });

  it('keeps the outgoing project autosaving, so a later save can still land', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');
    await expect(projectService.loadProject('project-b')).rejects.toThrow();

    // The queue was NOT torn down: the work is still queued and a retry can write it.
    flushFailure = null;
    expect(await projectService.saveNow()).toBe('saved');
    expect(flushDirtyKeys).toHaveBeenLastCalledWith(expect.anything(), ['sequence:seq-1']);
  });

  it('lets the switch through once the work has been saved', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');
    await expect(projectService.loadProject('project-b')).rejects.toThrow();

    flushFailure = null;
    await expect(projectService.loadProject('project-b')).resolves.toBeUndefined();
  });

  it('refuses New Project too, before it writes the new project rows', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');

    await expect(projectService.newProject()).rejects.toThrow(/not saved|could not/i);
    // Nothing was created: a refused switch must not leave an empty project behind.
    expect(projectCreate).not.toHaveBeenCalled();
  });

  it('lets Safe Mode close the project regardless, because that is the escape hatch', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');

    // §8.1's Safe Mode exists to get the user OUT; refusing here would trap them in the
    // shell that is already failing.
    await expect(closeActiveProject()).resolves.toBeUndefined();
  });
});

/**
 * Issue #99: `exportMpcweb` read every sample through one `Promise.all`, so a single missing
 * OPFS file made the project impossible to export at all — at exactly the moment a user
 * reaches for export, which is when a project is already misbehaving.
 */
describe('export — one unreadable sample does not lose the whole project (spec §9.6)', () => {
  async function exportWith(missing: readonly string[]): Promise<void> {
    await projectService.loadProject('project-a');
    useProjectStore.setState({ projectId: 'project-a' });
    for (const path of missing) unreadablePaths.add(path);
    await projectService.exportMpcweb();
  }

  it('exports everything that can be read', async () => {
    await exportWith(['/projects/p/samples/a.wav']);

    const input = packMpcwebInWorker.mock.calls[0]![0] as unknown as {
      samples: { sampleId: string }[];
    };
    expect(input.samples.map((sample) => sample.sampleId)).toEqual(['sample-b']);
  });

  it('drops the unreadable sample ROW too, so the archive re-imports cleanly', async () => {
    await exportWith(['/projects/p/samples/a.wav']);

    // The §9.6 completeness check refuses an archive declaring a sample it does not carry,
    // so an export that keeps the row would produce a file it then refuses to open.
    const input = packMpcwebInWorker.mock.calls[0]![0] as unknown as {
      snapshot: { samples: { id: string }[] };
    };
    expect(input.snapshot.samples.map((row) => row.id)).toEqual(['sample-b']);
  });

  it('tells the user what was left out rather than shrinking the export quietly', async () => {
    await exportWith(['/projects/p/samples/a.wav']);
    expect(
      useUIStore
        .getState()
        .toasts.map((toast) => toast.message)
        .join(' '),
    ).toMatch(/kick/);
  });

  it('leaves a healthy export byte-for-byte as it was', async () => {
    await exportWith([]);

    const input = packMpcwebInWorker.mock.calls[0]![0] as unknown as {
      snapshot: { samples: { id: string }[] };
      samples: { sampleId: string }[];
    };
    expect(input.samples.map((sample) => sample.sampleId)).toEqual(['sample-a', 'sample-b']);
    expect(input.snapshot.samples.map((row) => row.id)).toEqual(['sample-a', 'sample-b']);
    expect(useUIStore.getState().toasts).toEqual([]);
  });
});
