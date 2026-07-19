/**
 * A `.mpcweb` archive's sample locations are untrusted input (spec §9.1, §9.6).
 *
 * `opfs_path` and `project_id` arrive from a file the user was handed, and both are later
 * consumed as authority: the Browser's "Purge unused samples" passes `opfs_path` straight to
 * `deleteFile`, and a NULL `project_id` means "global library". A crafted archive naming
 * `/bangerbox.sqlite3` would aim that purge at the database holding every project.
 *
 * The installer therefore re-derives both from the ids it just generated. These tests pin that
 * the stored row describes where the bytes were actually written, whatever the archive claimed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSnapshot } from './mpcweb';

vi.mock('@/core/storage/client', () => ({ getDatabaseDriver: () => ({}) }));

const sampleCreate = vi.fn();
vi.mock('@/core/storage/repositories', () => ({
  createRepositories: () => ({
    projects: { create: vi.fn(async ({ name }: { name: string }) => ({ id: 'p', name })) },
    programs: { create: vi.fn() },
    sequences: { create: vi.fn() },
    tracks: { create: vi.fn() },
    midiEvents: { insertMany: vi.fn() },
    automation: { insertMany: vi.fn() },
    samples: { create: sampleCreate },
    songs: { replaceForProject: vi.fn() },
  }),
}));

const writeFileAtomic = vi.fn();
vi.mock('@/core/storage/opfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/storage/opfs')>()),
  writeFileAtomic: (path: string, data: unknown) => writeFileAtomic(path, data),
}));

vi.mock('./persist', () => ({ flushDirtyKeys: vi.fn() }));
vi.mock('./hydrate', () => ({ hydrateStores: vi.fn() }));

const { installUnpackedAsNewProject } = await import('./projectService');

const SAMPLE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const PROJECT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

/** A minimal snapshot whose one sample claims whatever `opfs_path`/`project_id` a test wants. */
function snapshotClaiming(opfsPath: string, projectId: string | null = PROJECT_ID): ProjectSnapshot {
  return {
    version: 1,
    project: {
      id: PROJECT_ID,
      name: 'Shared',
      created_at: 1,
      modified_at: 1,
      sample_rate: 48_000,
      bit_depth: '24',
      bpm_default: 120,
      insert_limit: 4,
      payload: '{}',
    },
    sequences: [],
    tracks: [],
    midiEvents: [],
    automation: [],
    programs: [],
    samples: [
      {
        id: SAMPLE_ID,
        project_id: projectId,
        name: 'Kick',
        opfs_path: opfsPath,
        frames: 100,
        sample_rate: 48_000,
        channels: 1,
        root_note: 60,
        created_at: 1,
      },
    ],
    songEntries: [],
  };
}

function install(snapshot: ProjectSnapshot): Promise<string> {
  return installUnpackedAsNewProject({
    snapshot,
    samples: new Map([[SAMPLE_ID, new Uint8Array([1, 2, 3])]]),
  });
}

beforeEach(() => {
  sampleCreate.mockClear();
  writeFileAtomic.mockClear();
});

describe('imported sample paths (spec §9.1, §9.6)', () => {
  it('stores the path the bytes were written to, not the one the archive claimed', async () => {
    const newProjectId = await install(snapshotClaiming('/bangerbox.sqlite3'));

    const row = sampleCreate.mock.calls[0]![0] as { id: string; opfs_path: string };
    expect(row.opfs_path).toBe(`/projects/${newProjectId}/samples/${row.id}.wav`);
    // The row must name the file that actually exists, or a purge deletes the wrong thing.
    expect(writeFileAtomic).toHaveBeenCalledWith(row.opfs_path, expect.anything());
  });

  it('keeps an imported sample inside its own project even if the archive says global', async () => {
    const newProjectId = await install(snapshotClaiming('/global_library/kick.wav', null));

    // A NULL project_id would promote the user's audio into the shared library, where another
    // project's purge could reach it (spec §9.6).
    const row = sampleCreate.mock.calls[0]![0] as { project_id: string | null; opfs_path: string };
    expect(row.project_id).toBe(newProjectId);
    expect(row.opfs_path.startsWith(`/projects/${newProjectId}/samples/`)).toBe(true);
  });
});

describe('deleteFile content roots (spec §9.1)', () => {
  it('refuses to delete outside /projects and /global_library', async () => {
    const { deleteFile } = await vi.importActual<typeof import('@/core/storage/opfs')>('@/core/storage/opfs');
    await expect(deleteFile('/bangerbox.sqlite3')).rejects.toThrow(/content roots/i);
    await expect(deleteFile('/projects')).rejects.toThrow(/content roots/i);
  });
});
