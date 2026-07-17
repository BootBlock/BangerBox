import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireDatabaseTabLock } from './multiTabGuard';

type LockCallback = (lock: unknown) => Promise<unknown> | unknown;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubLocks(request: (name: string, options: LockOptions, callback: LockCallback) => Promise<unknown>) {
  vi.stubGlobal('navigator', { ...navigator, locks: { request } });
}

interface LockOptions {
  mode?: string;
  ifAvailable?: boolean;
}

describe('acquireDatabaseTabLock', () => {
  it('acquires when the lock is free and holds until release()', async () => {
    let heldPromise: Promise<unknown> | undefined;
    stubLocks(async (name, options, callback) => {
      expect(name).toBe('bangerbox-db'); // spec §9.7 — binding lock name
      expect(options.ifAvailable).toBe(true);
      heldPromise = Promise.resolve(callback({ name }));
      // The lock manager awaits the callback's promise to keep the lock held.
      await heldPromise;
      return undefined;
    });

    const outcome = await acquireDatabaseTabLock();
    expect(outcome.acquired).toBe(true);

    // Releasing settles the held promise, letting the lock go.
    if (outcome.acquired) outcome.handle.release();
    await expect(heldPromise).resolves.toBeUndefined();
  });

  it('reports blocked with a whenReleased promise when another tab owns the lock', async () => {
    let queuedResolve: (() => void) | undefined;
    let callIndex = 0;
    stubLocks(async (_name, options, callback) => {
      callIndex += 1;
      if (callIndex === 1) {
        expect(options.ifAvailable).toBe(true);
        return callback(null); // ifAvailable probe: blocked
      }
      // The queued blocking request resolves when the owner goes away.
      await new Promise<void>((resolve) => {
        queuedResolve = resolve;
      });
      return callback({});
    });

    const outcome = await acquireDatabaseTabLock();
    expect(outcome.acquired).toBe(false);
    if (outcome.acquired) throw new Error('unreachable');

    let released = false;
    void outcome.whenReleased.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    queuedResolve?.();
    await outcome.whenReleased;
    expect(released).toBe(true);
  });

  it('degrades to sole-tab when Web Locks is missing or erroring', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    // The guard checks for the API's presence, not its value — remove it entirely.
    const bare = { ...navigator } as Record<string, unknown>;
    delete bare.locks;
    vi.stubGlobal('navigator', bare);
    await expect(acquireDatabaseTabLock()).resolves.toMatchObject({ acquired: true });

    stubLocks(async () => {
      throw new Error('lock manager unavailable');
    });
    await expect(acquireDatabaseTabLock()).resolves.toMatchObject({ acquired: true });
  });
});
