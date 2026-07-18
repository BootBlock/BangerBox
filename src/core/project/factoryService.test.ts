/**
 * Factory install path (spec §9.8) — driven with the REAL shipped packs as fixtures, so
 * these tests exercise the archives the build actually emits rather than hand-made stand-ins.
 *
 * The two guarantees §9.8 is most specific about are the ones proven here: the §9.7 storage
 * hard stop refuses BEFORE any OPFS write, and a failed `kit` merge leaves no partial
 * project and no orphaned files.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — plain-ESM build script, deliberately untyped (spec §9.8).
import { buildFactory } from '../../../scripts/build-factory.mjs';
import { unpackMpcweb } from './mpcwebZip';

const built = buildFactory('0.1.0') as { archives: { file: string; bytes: Uint8Array }[] };
const archiveFor = (file: string) => built.archives.find((entry) => entry.file === file)!.bytes;

const ACTIVE_PROJECT = 'active-project-id';

// --- Mocks: everything below the service, so the service's own logic is what is tested ---

const writeFileAtomic = vi.fn<(path: string, bytes: Uint8Array) => Promise<void>>();
const deleteFile = vi.fn<(path: string) => Promise<void>>();
vi.mock('@/core/storage/opfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/storage/opfs')>();
  return {
    ...actual,
    writeFileAtomic: (path: string, bytes: Uint8Array) => writeFileAtomic(path, bytes),
    deleteFile: (path: string) => deleteFile(path),
  };
});

const checkWriteHeadroom = vi.fn();
vi.mock('@/core/storage/safeguards', () => ({ checkWriteHeadroom: (bytes: number) => checkWriteHeadroom(bytes) }));

const programCreate = vi.fn();
const programRemove = vi.fn();
const sampleCreate = vi.fn();
const sampleRemove = vi.fn();
const installUnpackedAsNewProject = vi.fn();
vi.mock('./projectService', () => ({
  getActiveRepositories: () => ({
    programs: { create: programCreate, remove: programRemove },
    samples: { create: sampleCreate, remove: sampleRemove },
  }),
  installUnpackedAsNewProject: (unpacked: unknown) => installUnpackedAsNewProject(unpacked),
}));

// The pack worker is a real Worker; unpack synchronously with the same pure function it runs.
vi.mock('./packClient', () => ({
  unpackMpcwebInWorker: (bytes: Uint8Array) => Promise.resolve(unpackMpcweb(bytes)),
}));

const { FactoryStorageError, fetchFactoryCatalogue, installFactoryPack } = await import('./factoryService');
const { useProgramStore } = await import('@/store');

function pack(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kit-808',
    title: '808 Kit',
    kind: 'kit' as const,
    file: 'kit-808.mpcweb',
    bytes: 1,
    description: '',
    ...overrides,
  };
}

/** Serve a built archive (or an arbitrary body) from `fetch`. */
function stubFetch(body: Uint8Array | object, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok,
        status,
        arrayBuffer: () => Promise.resolve(body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0)),
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  writeFileAtomic.mockResolvedValue(undefined);
  deleteFile.mockResolvedValue(undefined);
  checkWriteHeadroom.mockResolvedValue({ allowed: true, usage: 0, quota: 1e12, ratio: 0, supported: true });
  programCreate.mockResolvedValue(undefined);
  programRemove.mockResolvedValue(undefined);
  sampleCreate.mockResolvedValue(undefined);
  sampleRemove.mockResolvedValue(undefined);
  installUnpackedAsNewProject.mockResolvedValue('new-project-id');
  useProgramStore.getState().setPrograms({});
});

describe('catalogue fetch (spec §9.8)', () => {
  it('validates the fetched catalogue', async () => {
    stubFetch([{ ...pack(), bytes: 10 }]);
    await expect(fetchFactoryCatalogue()).resolves.toHaveLength(1);
  });

  it('surfaces an HTTP failure as a retryable error rather than an empty list', async () => {
    stubFetch({}, false, 503);
    // An empty list would read as "no factory content exists" (spec §8.5 item 7).
    await expect(fetchFactoryCatalogue()).rejects.toThrow(/could not load the factory catalogue/i);
  });

  it('rejects a malformed catalogue body', async () => {
    stubFetch([{ id: 'x' }]);
    await expect(fetchFactoryCatalogue()).rejects.toThrow();
  });
});

describe('demo install (spec §9.8)', () => {
  it('installs as a new project through the shared import path', async () => {
    stubFetch(archiveFor('demo-house.mpcweb'));
    const result = await installFactoryPack(pack({ kind: 'demo', file: 'demo-house.mpcweb' }), ACTIVE_PROJECT);

    expect(result).toEqual({ kind: 'demo', projectId: 'new-project-id' });
    // The demo path must NOT hand-roll writes — it delegates to the §9.6 import path.
    expect(installUnpackedAsNewProject).toHaveBeenCalledTimes(1);
    expect(writeFileAtomic).not.toHaveBeenCalled();
  });
});

describe('kit merge (spec §9.8)', () => {
  it('writes every sample and inserts programs and samples into the active project', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    const expected = unpackMpcweb(archiveFor('kit-808.mpcweb'));

    const result = await installFactoryPack(pack(), ACTIVE_PROJECT);

    expect(result).toEqual({ kind: 'kit', projectId: ACTIVE_PROJECT });
    expect(writeFileAtomic).toHaveBeenCalledTimes(expected.snapshot.samples.length);
    expect(sampleCreate).toHaveBeenCalledTimes(expected.snapshot.samples.length);
    expect(programCreate).toHaveBeenCalledTimes(expected.snapshot.programs.length);
    // It never opens or reloads a project — the user stays where they were.
    expect(installUnpackedAsNewProject).not.toHaveBeenCalled();
  });

  it('re-parents every written sample under the active project (spec §9.1)', async () => {
    stubFetch(archiveFor('kit-909.mpcweb'));
    await installFactoryPack(pack({ file: 'kit-909.mpcweb' }), ACTIVE_PROJECT);

    for (const [path] of writeFileAtomic.mock.calls) {
      expect(path.startsWith(`/projects/${ACTIVE_PROJECT}/samples/`)).toBe(true);
    }
    for (const [row] of sampleCreate.mock.calls) {
      expect((row as { project_id: string }).project_id).toBe(ACTIVE_PROJECT);
    }
  });

  it('remaps ids so a kit installed twice never collides (spec §9.6)', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    await installFactoryPack(pack(), ACTIVE_PROJECT);
    const first = programCreate.mock.calls.map(([row]) => (row as { id: string }).id);

    vi.clearAllMocks();
    programCreate.mockResolvedValue(undefined);
    sampleCreate.mockResolvedValue(undefined);
    stubFetch(archiveFor('kit-808.mpcweb'));
    await installFactoryPack(pack(), ACTIVE_PROJECT);
    const second = programCreate.mock.calls.map(([row]) => (row as { id: string }).id);

    expect(second).not.toEqual(first);
  });

  it('publishes merged programs to the runtime store', async () => {
    stubFetch(archiveFor('kit-acoustic.mpcweb'));
    await installFactoryPack(pack({ file: 'kit-acoustic.mpcweb' }), ACTIVE_PROJECT);

    const programs = Object.values(useProgramStore.getState().programs);
    expect(programs).toHaveLength(1);
    expect(programs[0]!.type).toBe('drum');
  });

  it('refuses to merge when no project is open', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    await expect(installFactoryPack(pack(), null)).rejects.toThrow(/open a project/i);
    expect(writeFileAtomic).not.toHaveBeenCalled();
  });
});

describe('storage hard stop (spec §9.7, §9.8)', () => {
  it('refuses before any OPFS write when headroom is breached', async () => {
    checkWriteHeadroom.mockResolvedValue({ allowed: false, usage: 9, quota: 10, ratio: 0.9, supported: true });
    stubFetch(archiveFor('kit-808.mpcweb'));

    await expect(installFactoryPack(pack(), ACTIVE_PROJECT)).rejects.toBeInstanceOf(FactoryStorageError);

    // "Before any OPFS write" is the whole point — nothing may have been written or inserted.
    expect(writeFileAtomic).not.toHaveBeenCalled();
    expect(sampleCreate).not.toHaveBeenCalled();
    expect(programCreate).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('checks headroom against the uncompressed payload, not the archive size', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    const unpacked = unpackMpcweb(archiveFor('kit-808.mpcweb'));
    const uncompressed = [...unpacked.samples.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);

    await installFactoryPack(pack(), ACTIVE_PROJECT);

    expect(checkWriteHeadroom).toHaveBeenCalledWith(uncompressed);
    // A pack that deflates well would otherwise slip past a gate sized on the archive.
    expect(uncompressed).toBeGreaterThan(archiveFor('kit-808.mpcweb').byteLength);
  });

  it('carries a distinct error type so the UI can offer the purge affordance', async () => {
    checkWriteHeadroom.mockResolvedValue({ allowed: false, usage: 9, quota: 10, ratio: 0.9, supported: true });
    stubFetch(archiveFor('kit-808.mpcweb'));
    await expect(installFactoryPack(pack(), ACTIVE_PROJECT)).rejects.toThrow(/purge unused samples/i);
  });
});

describe('kit merge transactionality (spec §9.8, §9.6)', () => {
  it('unwinds every written file and inserted row when a row insert fails', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    const total = unpackMpcweb(archiveFor('kit-808.mpcweb')).snapshot.samples.length;
    // Fail partway through the sample rows, after files and programs have landed.
    sampleCreate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk on fire'));

    await expect(installFactoryPack(pack(), ACTIVE_PROJECT)).rejects.toThrow('disk on fire');

    // No orphaned OPFS files: every file written is deleted again (spec §9.8).
    expect(deleteFile).toHaveBeenCalledTimes(total);
    const written = writeFileAtomic.mock.calls.map(([path]) => path);
    expect(deleteFile.mock.calls.map(([path]) => path).sort()).toEqual(written.sort());
    // No partial project: both successfully inserted sample rows are removed again...
    expect(sampleRemove).toHaveBeenCalledTimes(2);
    // ...and so is the program row.
    expect(programRemove).toHaveBeenCalledTimes(1);
  });

  it('unwinds when an OPFS write fails midway', async () => {
    stubFetch(archiveFor('kit-909.mpcweb'));
    writeFileAtomic.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('quota exceeded'));

    await expect(installFactoryPack(pack({ file: 'kit-909.mpcweb' }), ACTIVE_PROJECT)).rejects.toThrow(
      'quota exceeded',
    );

    // The one file that did land is removed; no rows were ever inserted.
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(programCreate).not.toHaveBeenCalled();
    expect(sampleCreate).not.toHaveBeenCalled();
  });

  it('leaves the runtime program store untouched when the merge fails', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    programCreate.mockRejectedValueOnce(new Error('constraint failed'));

    await expect(installFactoryPack(pack(), ACTIVE_PROJECT)).rejects.toThrow('constraint failed');
    expect(Object.keys(useProgramStore.getState().programs)).toHaveLength(0);
  });

  it('continues unwinding even when a cleanup step itself fails', async () => {
    stubFetch(archiveFor('kit-808.mpcweb'));
    const total = unpackMpcweb(archiveFor('kit-808.mpcweb')).snapshot.samples.length;
    sampleCreate.mockRejectedValueOnce(new Error('insert failed'));
    // A cleanup failure must not abort the remaining cleanup, or "no orphaned files"
    // would degrade to "no orphaned files up to the first cleanup error".
    deleteFile.mockRejectedValueOnce(new Error('delete failed'));

    await expect(installFactoryPack(pack(), ACTIVE_PROJECT)).rejects.toThrow('insert failed');
    expect(deleteFile).toHaveBeenCalledTimes(total);
  });
});
