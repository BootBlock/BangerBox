/**
 * Session boot failure (issue #38): a project that fails to open must not leave a
 * fully editable shell behind. Without the autosave queue `startProjectSession()`
 * registers, `markDirty()` is a no-op and the unsaved dot claims "All changes saved"
 * while every edit is discarded — so the boot has to throw and let the caller drop
 * into Safe Mode (spec §4.4, §8.1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bootDatabase = vi.fn(async () => {});
const loadOrCreateActiveProject = vi.fn(async () => {});
const installProjectService = vi.fn(() => {});
const registerSyncSubscribers = vi.fn(() => () => {});
const installUnloadGuard = vi.fn(() => () => {});

vi.mock('@/core/storage/client', () => ({
  bootDatabase: () => bootDatabase(),
  disposeDatabase: async () => {},
  getDatabaseDriver: () => ({ exportBinary: async () => new Uint8Array() }),
}));
vi.mock('./projectService', () => ({
  installProjectService: () => installProjectService(),
  loadOrCreateActiveProject: () => loadOrCreateActiveProject(),
  projectService: { saveNow: async () => {} },
}));
vi.mock('@/store/syncLayer', () => ({ registerSyncSubscribers: () => registerSyncSubscribers() }));
vi.mock('./unloadGuard', () => ({ installUnloadGuard: () => installUnloadGuard() }));

const { ProjectSessionBootError, startProjectSession, stopProjectSession } = await import('./session');
const { markDirty, registerAutosave, unregisterAutosave } = await import('./dirty');

beforeEach(() => {
  vi.clearAllMocks();
  bootDatabase.mockImplementation(async () => {});
  loadOrCreateActiveProject.mockImplementation(async () => {});
});

afterEach(() => {
  stopProjectSession();
  unregisterAutosave();
});

describe('startProjectSession', () => {
  it('registers the visibility flush once the project is open', async () => {
    const addEventListener = vi.spyOn(document, 'addEventListener');
    await startProjectSession();
    expect(registerSyncSubscribers).toHaveBeenCalledOnce();
    expect(installUnloadGuard).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    addEventListener.mockRestore();
  });

  it('throws ProjectSessionBootError when the database will not boot', async () => {
    bootDatabase.mockRejectedValueOnce(new Error('OPFS unavailable'));
    await expect(startProjectSession()).rejects.toBeInstanceOf(ProjectSessionBootError);
  });

  it('throws ProjectSessionBootError when the project will not load', async () => {
    loadOrCreateActiveProject.mockRejectedValueOnce(new Error('corrupt row'));
    const error = await startProjectSession().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProjectSessionBootError);
    // The original fault stays reachable for the Safe Mode diagnostic panel.
    expect((error as Error).cause).toEqual(new Error('corrupt row'));
  });

  it('unwinds whatever registered before a late failure', async () => {
    const syncDispose = vi.fn();
    registerSyncSubscribers.mockReturnValueOnce(syncDispose);
    // Fail after the sync subscribers and the visibility listener are both in place.
    installUnloadGuard.mockImplementationOnce(() => {
      throw new Error('guard failed');
    });
    const removeEventListener = vi.spyOn(document, 'removeEventListener');

    await expect(startProjectSession()).rejects.toBeInstanceOf(ProjectSessionBootError);

    expect(syncDispose).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removeEventListener.mockRestore();
  });

  it('silently loses edits if a caller ignores the throw — the reason Safe Mode is mandatory', async () => {
    bootDatabase.mockRejectedValueOnce(new Error('OPFS unavailable'));
    await startProjectSession().catch(() => {});
    const onDirty = vi.fn();
    // Nothing registered the queue, so markDirty cannot raise the unsaved dot.
    expect(() => markDirty('project:1')).not.toThrow();
    expect(onDirty).not.toHaveBeenCalled();
    // Sanity: the hook does fire once a queue is genuinely wired.
    registerAutosave({ markDirty: () => {} } as never, { onDirty });
    markDirty('project:1');
    expect(onDirty).toHaveBeenCalledOnce();
  });
});
