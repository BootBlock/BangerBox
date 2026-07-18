/**
 * Multi-tab concurrency guard (spec §8.1, §9.7).
 *
 * The SQLite OPFS VFS holds an exclusive lock on the database file: a second tab
 * would fail to mount SQLite and crash — this guard is mandatory, not cosmetic
 * (spec §9.7). Before booting the database we claim an app-wide exclusive Web
 * Lock held for the lifetime of the tab (released automatically on close). If
 * another tab already holds it, we report `acquired: false` so the UI shows the
 * styled "already open in another tab" screen, plus `whenReleased` — settling
 * once the owning tab goes away — so the blocked tab can offer to take over.
 */

/** The §9.7 lock name — binding. */
const DB_TAB_LOCK = 'bangerbox-db';

export interface TabLockHandle {
  /** Release the lock (also released automatically when the tab is closed). */
  release(): void;
}

export type TabLockOutcome =
  | { readonly acquired: true; readonly handle: TabLockHandle }
  | { readonly acquired: false; readonly whenReleased: Promise<void> };

/**
 * Attempt to become the sole database-owning tab. Resolves as soon as the
 * acquisition outcome is known; when acquired, the underlying lock is held until
 * `release()` or tab close.
 */
export async function acquireDatabaseTabLock(): Promise<TabLockOutcome> {
  // Without the Web Locks API we cannot arbitrate. The capability gate already
  // requires a very modern Chromium (OPFS + cross-origin isolation), so degrade
  // to "sole tab" rather than blocking startup.
  if (!('locks' in navigator)) {
    return { acquired: true, handle: { release: () => {} } };
  }

  return new Promise<TabLockOutcome>((resolveOutcome) => {
    let releaseHeld: (() => void) | null = null;

    void navigator.locks
      // spec §9.7 — ifAvailable probe: never queue behind the owning tab.
      .request(DB_TAB_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (lock === null) {
          // Blocked — another tab owns the database. Queue a second, blocking
          // request so we learn when that tab releases (i.e. closes); the UI uses
          // this to offer a reload that takes ownership.
          const whenReleased = navigator.locks
            .request(DB_TAB_LOCK, { mode: 'exclusive' }, async () => {
              // Acquired momentarily once the owner is gone; release immediately —
              // the caller reloads and re-runs the full boot as the sole tab.
            })
            .then(() => undefined);

          resolveOutcome({ acquired: false, whenReleased });
          return; // resolve the ifAvailable request without holding anything
        }

        // Acquired. Keep the lock by returning a promise that stays pending until
        // we explicitly release (or the tab closes).
        const held = new Promise<void>((resolveHeld) => {
          releaseHeld = resolveHeld;
        });
        resolveOutcome({ acquired: true, handle: { release: () => releaseHeld?.() } });
        return held;
      })
      .catch(() => {
        // Never let a lock-manager error block startup; degrade to "sole tab".
        resolveOutcome({ acquired: true, handle: { release: () => releaseHeld?.() } });
      });
  });
}
