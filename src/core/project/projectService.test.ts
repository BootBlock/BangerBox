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

let createFailure: Error | null = null;
const projectCreate = vi.fn(async ({ name }: { name: string }) => {
  if (createFailure) throw createFailure;
  return { id: 'new-project', name };
});
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
let restoreFailure: Error | null = null;
const restoreSnapshot = vi.fn(async () => {
  if (restoreFailure) throw restoreFailure;
});
vi.mock('./snapshotService', () => ({
  dumpSnapshot: () => dumpSnapshot(),
  restoreSnapshot: () => restoreSnapshot(),
}));

/** A minimal snapshot the install path can remap — UUID-shaped ids, no samples. */
function importSnapshot() {
  const id = (tail: string) => `00000000-0000-4000-8000-00000000000${tail}`;
  return {
    version: 1,
    project: {
      id: id('1'),
      name: 'Imported',
      created_at: 1,
      modified_at: 1,
      sample_rate: 48_000,
      bit_depth: '24' as const,
      bpm_default: 120,
      insert_limit: 4,
      payload: '{}',
    },
    sequences: [],
    tracks: [],
    midiEvents: [],
    automation: [],
    programs: [],
    samples: [],
    songEntries: [],
  };
}

/** Paths whose read fails, standing in for a sample whose OPFS file is gone. */
const unreadablePaths = new Set<string>();
/** Paths that read back larger than the §9.6 import budget allows for one entry. */
const oversizedSamplePaths = new Set<string>();
vi.mock('@/core/storage/opfs', () => ({
  samplePath: (projectId: string, sampleId: string) => `/projects/${projectId}/samples/${sampleId}.wav`,
  readFile: async (path: string) => {
    if (unreadablePaths.has(path)) throw new DOMException('gone', 'NotFoundError');
    const size = oversizedSamplePaths.has(path) ? 300 * 1024 * 1024 : 3;
    return new Blob([new Uint8Array(size)]);
  },
  writeFileAtomic: vi.fn(),
  deleteFile: vi.fn(),
}));

/**
 * A fake pack session recording what the export streamed into it (issue #99).
 *
 * The export no longer hands the worker one object holding every sample; it opens a session
 * and pushes samples through it one at a time, so the assertions below read the ORDER of
 * `addSample` calls and the snapshot handed to `finish` — which together are exactly what
 * the archive ends up containing.
 */
const packedSamples: { sampleId: string; byteLength: number }[] = [];
const finishedSnapshots: { samples: { id: string }[] }[] = [];
let packAborted = false;
const beginMpcwebPack = vi.fn(async () => ({
  addSample: async ({ sampleId, bytes }: { sampleId: string; bytes: Uint8Array }) => {
    packedSamples.push({ sampleId, byteLength: bytes.byteLength });
  },
  finish: async (snapshot: { samples: { id: string }[] }) => {
    finishedSnapshots.push(snapshot);
    // `finish` filters the rows down to what was added, exactly as the real session does —
    // otherwise the test would pass against an export that packed an inconsistent archive.
    const added = new Set(packedSamples.map((sample) => sample.sampleId));
    finishedSnapshots[finishedSnapshots.length - 1] = {
      ...snapshot,
      samples: snapshot.samples.filter((row) => added.has(row.id)),
    };
    return new Blob([new Uint8Array([0x50, 0x4b])]);
  },
  abort: async () => {
    packAborted = true;
  },
}));
vi.mock('./packClient', () => ({
  beginMpcwebPack: (appVersion: string) => beginMpcwebPack(appVersion),
  unpackMpcwebInWorker: vi.fn(),
}));

const { projectService, closeActiveProject, installUnpackedAsNewProject } = await import('./projectService');
const { markDirty } = await import('./dirty');
const { useProjectStore, useUIStore } = await import('@/store');

beforeEach(() => {
  calls.length = 0;
  flushFailure = null;
  createFailure = null;
  restoreFailure = null;
  oversizedSamplePaths.clear();
  restoreSnapshot.mockClear();
  unreadablePaths.clear();
  packedSamples.length = 0;
  finishedSnapshots.length = 0;
  packAborted = false;
  beginMpcwebPack.mockClear();
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

  /**
   * The refusal must not cost the open project its autosave. Flushing and TEARING DOWN before
   * the work would leave `markDirty` a no-op the moment anything after it failed: the unsaved
   * dot never lights again and every later edit is lost on reload — a worse failure than the
   * one the refusal exists to prevent.
   */
  it('keeps the open project autosaving when the new project cannot be created', async () => {
    await projectService.loadProject('project-a');
    createFailure = new Error('disk full');

    await expect(projectService.newProject()).rejects.toThrow(/disk full/);

    // The queue is still wired: an edit still arms it and still reaches storage.
    flushDirtyKeys.mockClear();
    markDirty('sequence:seq-1');
    expect(await projectService.saveNow()).toBe('saved');
    expect(flushDirtyKeys).toHaveBeenCalledWith(expect.anything(), ['sequence:seq-1']);
  });

  it('keeps the open project autosaving when an import cannot be installed', async () => {
    await projectService.loadProject('project-a');
    restoreFailure = new Error('quota exceeded mid-install');

    await expect(
      installUnpackedAsNewProject({
        manifest: {} as never,
        snapshot: importSnapshot(),
        samples: new Map(),
      }),
    ).rejects.toThrow(/quota exceeded mid-install/);

    flushDirtyKeys.mockClear();
    markDirty('sequence:seq-1');
    expect(await projectService.saveNow()).toBe('saved');
    expect(flushDirtyKeys).toHaveBeenCalledWith(expect.anything(), ['sequence:seq-1']);
  });

  it('still refuses an import over work it could not write, before touching storage', async () => {
    await projectService.loadProject('project-a');
    markDirty('sequence:seq-1');
    flushFailure = new Error('quota exceeded');

    await expect(
      installUnpackedAsNewProject({
        manifest: {} as never,
        snapshot: importSnapshot(),
        samples: new Map(),
      }),
    ).rejects.toThrow(/not saved|could not/i);
    expect(restoreSnapshot).not.toHaveBeenCalled();
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
    expect(packedSamples.map((sample) => sample.sampleId)).toEqual(['sample-b']);
    expect(packAborted).toBe(false);
  });

  it('drops the unreadable sample ROW too, so the archive re-imports cleanly', async () => {
    await exportWith(['/projects/p/samples/a.wav']);

    // The §9.6 completeness check refuses an archive declaring a sample it does not carry,
    // so an export that keeps the row would produce a file it then refuses to open.
    expect(finishedSnapshots[0]!.samples.map((row) => row.id)).toEqual(['sample-b']);
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

  it('warns when it writes an archive its own import would refuse (spec §9.6)', async () => {
    // Import enforces MPCWEB_MAX_ENTRY_BYTES; export enforced nothing, so BangerBox could
    // write a file it then refused to open — while telling the user to ask for a fresh export.
    oversizedSamplePaths.add('/projects/p/samples/a.wav');
    await projectService.loadProject('project-a');
    useProjectStore.setState({ projectId: 'project-a' });
    await projectService.exportMpcweb();

    const toasts = useUIStore.getState().toasts;
    expect(toasts.map((toast) => toast.message).join(' ')).toMatch(/too large|cannot be opened|reopen/i);
    expect(toasts.some((toast) => toast.message.includes('kick'))).toBe(true);
  });

  it('leaves a healthy export byte-for-byte as it was', async () => {
    await exportWith([]);

    expect(packedSamples.map((sample) => sample.sampleId)).toEqual(['sample-a', 'sample-b']);
    expect(finishedSnapshots[0]!.samples.map((row) => row.id)).toEqual(['sample-a', 'sample-b']);
    expect(useUIStore.getState().toasts).toEqual([]);
  });

  /**
   * Issue #99, the memory half. The export must never be holding more than one sample's
   * audio: each is read, handed over and dropped before the next is read. Proven by the size
   * the session was given, since the real session transfers (detaches) the buffer — a caller
   * that had kept the bytes to pack them all at the end would be measuring a detached view.
   */
  it('streams one sample at a time rather than gathering them all first', async () => {
    await exportWith([]);
    expect(packedSamples).toEqual([
      { sampleId: 'sample-a', byteLength: 3 },
      { sampleId: 'sample-b', byteLength: 3 },
    ]);
  });
});
