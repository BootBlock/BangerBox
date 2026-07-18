/**
 * Screen Wake Lock — spec §2.4: "while the transport is playing or recording, request a
 * Screen Wake Lock (feature-detected, released on stop/blur)". The target device is a
 * tablet, where the screen dimming mid-take is a genuine usability failure.
 *
 * The lock is a *soft* capability (spec §2.1): when the API is missing or the browser
 * refuses, the app carries on silently rather than surfacing an error — losing the lock
 * costs a dimmed screen, never a dropped take.
 *
 * The browser also drops the sentinel whenever the page is hidden, so the controller
 * reacquires on `visibilitychange` if the transport is still running.
 */

/** The slice of the Screen Wake Lock API this controller uses — injectable for tests. */
export interface WakeLockApi {
  readonly supported: boolean;
  request(): Promise<WakeLockSentinelLike>;
}

export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockController {
  /** Follow transport state: `true` while playing or recording (spec §2.4). */
  setActive(active: boolean): Promise<void>;
  isHeld(): boolean;
  dispose(): Promise<void>;
}

/** Feature-detected browser API (spec §2.1 — detection lives with the capability gate). */
export function browserWakeLockApi(): WakeLockApi {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  return {
    supported,
    request: async () => {
      // `screen` is the only lock type in the spec today.
      const sentinel = await navigator.wakeLock.request('screen');
      return sentinel as unknown as WakeLockSentinelLike;
    },
  };
}

export function createWakeLockController(api: WakeLockApi): WakeLockController {
  let sentinel: WakeLockSentinelLike | null = null;
  let active = false;
  /** Serialises acquire/release so rapid transport toggles cannot interleave. */
  let pending: Promise<void> = Promise.resolve();

  const acquire = async () => {
    if (!api.supported || sentinel !== null) return;
    try {
      sentinel = await api.request();
    } catch {
      // Denied or unavailable — a dimmed screen is an acceptable degradation (spec §2.1).
      sentinel = null;
    }
  };

  const release = async () => {
    const held = sentinel;
    sentinel = null;
    if (!held) return;
    try {
      await held.release();
    } catch {
      // A sentinel the browser already reclaimed throws; nothing is left to do.
    }
  };

  // The browser releases the lock when the page hides; reacquire on return if still
  // playing, otherwise the second half of a session runs unprotected.
  const onVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible' && active) {
      pending = pending.then(acquire);
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return {
    setActive(next) {
      active = next;
      pending = pending.then(() => (next ? acquire() : release()));
      return pending;
    },
    isHeld: () => sentinel !== null,
    async dispose() {
      active = false;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      pending = pending.then(release);
      await pending;
    },
  };
}
