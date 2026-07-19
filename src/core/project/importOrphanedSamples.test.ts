/**
 * A failed `.mpcweb` install leaves no orphaned audio (spec §9.6).
 *
 * The rows are atomic because the restore is one transaction ({@link snapshotService}), but the
 * OPFS writes are not covered by it: each `writeFileAtomic` is atomic alone and the set is not.
 * Without compensation a failed import leaves WAVs nothing references — and nothing can reclaim
 * them, because "Purge unused samples" reasons from program payloads, which the rollback removed.
 * So the installer records what it wrote and deletes it on the way out.
 *
 * Everything below the installer is mocked so the ordering and cleanup it owns are what is proven.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSnapshot } from './mpcweb';

vi.mock('@/core/storage/client', () => ({ getDatabaseDriver: () => ({}) }));

const transaction = vi.fn();
vi.mock('@/core/storage/repositories', () => ({
  createRepositories: () => ({
    driver: { transaction },
    projects: { insertStatement: vi.fn(() => ({ sql: '', params: [] })) },
    programs: { insertStatement: vi.fn(() => ({ sql: '', params: [] })) },
    sequences: { insertStatement: vi.fn(() => ({ sql: '', params: [] })) },
    tracks: { insertStatement: vi.fn(() => ({ sql: '', params: [] })) },
    midiEvents: { insertStatements: vi.fn(() => []) },
    automation: { insertStatements: vi.fn(() => []) },
    samples: { insertStatement: vi.fn(() => ({ sql: '', params: [] })) },
    songs: { replaceStatements: vi.fn(() => []) },
  }),
}));

const writeFileAtomic = vi.fn();
const deleteFile = vi.fn();
vi.mock('@/core/storage/opfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/storage/opfs')>()),
  writeFileAtomic: (path: string, data: unknown) => writeFileAtomic(path, data),
  deleteFile: (path: string) => deleteFile(path),
}));

vi.mock('./persist', () => ({ flushDirtyKeys: vi.fn() }));
vi.mock('./hydrate', () => ({ hydrateStores: vi.fn() }));

const { installUnpackedAsNewProject } = await import('./projectService');

const PROJECT_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const SAMPLE_IDS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000003',
];

function snapshot(): ProjectSnapshot {
  return {
    version: 1,
    project: {
      id: PROJECT_ID,
      name: 'Imported',
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
    samples: SAMPLE_IDS.map((id) => ({
      id,
      project_id: PROJECT_ID,
      name: `Sample ${id}`,
      opfs_path: `/projects/${PROJECT_ID}/samples/${id}.wav`,
      frames: 100,
      sample_rate: 48_000,
      channels: 1 as const,
      root_note: 60,
      created_at: 1,
    })),
    songEntries: [],
  };
}

function install(): Promise<string> {
  return installUnpackedAsNewProject({
    snapshot: snapshot(),
    samples: new Map(SAMPLE_IDS.map((id) => [id, new Uint8Array([1, 2, 3])])),
  });
}

beforeEach(() => {
  transaction.mockReset();
  writeFileAtomic.mockReset();
  deleteFile.mockReset();
});

describe('failed import cleanup (spec §9.6)', () => {
  it('deletes every written sample when the row insert fails', async () => {
    transaction.mockRejectedValueOnce(new Error('constraint failed'));

    await expect(install()).rejects.toThrow('constraint failed');

    const written = writeFileAtomic.mock.calls.map(([path]) => path as string);
    expect(written).toHaveLength(SAMPLE_IDS.length);
    expect(deleteFile.mock.calls.map(([path]) => path as string).sort()).toEqual([...written].sort());
  });

  it('deletes the files that had landed when a write fails partway', async () => {
    writeFileAtomic.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(install()).rejects.toThrow('quota exceeded');

    // Only the one completed file exists to clean up, and no rows were ever attempted.
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(writeFileAtomic.mock.calls[0]![0]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('continues cleaning up after a delete itself fails', async () => {
    transaction.mockRejectedValueOnce(new Error('constraint failed'));
    // One failed delete must not abort the rest, or "no orphaned files" degrades into
    // "no orphaned files up to the first cleanup error".
    deleteFile.mockRejectedValueOnce(new Error('delete failed'));

    await expect(install()).rejects.toThrow('constraint failed');
    expect(deleteFile).toHaveBeenCalledTimes(SAMPLE_IDS.length);
  });

  it('keeps the samples of a successful import', async () => {
    await install();

    expect(writeFileAtomic).toHaveBeenCalledTimes(SAMPLE_IDS.length);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
