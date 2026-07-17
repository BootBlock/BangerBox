/**
 * usePwaUpdate — detect when a newer build has installed in the background and is
 * waiting to take over, so the app can offer the "Reload to update" toast (spec §2.4).
 *
 * BangerBox ships with `registerType: 'prompt'` (vite.config.ts): a new service worker
 * installs but never activates on its own, so a deploy can never reload the page out
 * from under an unsaved project. Registration goes through an injectable seam so the
 * hook is testable with a fake — the real seam lazily imports `virtual:pwa-register`
 * (§2.7 pinned form), which is never evaluated in test environments. Adapted from the
 * proven Gubbins hook (§13.6 reference-implementation rule).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Callbacks the seam invokes for the service-worker lifecycle transitions we surface. */
export interface PwaUpdateHandlers {
  /** A new worker has installed and is waiting — a refresh is available. */
  onNeedRefresh(): void;
}

/** Applies the waiting worker and reloads the page onto it. */
export type PwaUpdater = (reloadPage?: boolean) => Promise<void>;

/** Injectable seam over service-worker registration + the update handshake. */
export interface PwaUpdateApi {
  register(handlers: PwaUpdateHandlers): PwaUpdater;
  /** Re-check for a newer waiting worker (no-op until the registration is ready). */
  checkForUpdate(): Promise<void>;
}

/** The real browser seam, backed by vite-plugin-pwa's `registerSW`. */
export function browserPwaUpdateApi(): PwaUpdateApi {
  let registration: ServiceWorkerRegistration | undefined;
  return {
    register(handlers) {
      let updateSW: PwaUpdater | undefined;
      void import('virtual:pwa-register').then(({ registerSW }) => {
        updateSW = registerSW({
          immediate: true,
          onNeedRefresh: handlers.onNeedRefresh,
          onRegisteredSW: (_swUrl, reg) => {
            registration = reg;
          },
        });
      });
      return async (reloadPage = true) => {
        await updateSW?.(reloadPage);
      };
    },
    async checkForUpdate() {
      await registration?.update();
    },
  };
}

export interface PwaUpdateState {
  /** A newer version has installed and is waiting — show the toast. */
  readonly needRefresh: boolean;
  /** Increments per waiting-worker notification, so a snoozed prompt can re-surface. */
  readonly updateAvailableSeq: number;
  /** Activate the waiting worker and reload the page onto the new version. */
  update: PwaUpdater;
}

/** Cadence for the active "is there a newer worker?" check — once an hour. */
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function usePwaUpdate(
  apiOverride?: PwaUpdateApi,
  checkIntervalMs: number = DEFAULT_CHECK_INTERVAL_MS,
): PwaUpdateState {
  const api = useMemo(() => apiOverride ?? browserPwaUpdateApi(), [apiOverride]);
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updateAvailableSeq, setUpdateAvailableSeq] = useState(0);
  const updaterRef = useRef<PwaUpdater | null>(null);
  // Register exactly once even under StrictMode's double-invoke.
  const registeredRef = useRef(false);

  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;
    updaterRef.current = api.register({
      onNeedRefresh: () => {
        setNeedRefresh(true);
        setUpdateAvailableSeq((seq) => seq + 1);
      },
    });
  }, [api]);

  // Actively re-check on a timer and when the tab regains visibility, so a long-lived
  // tab (the tablet form factor) still notices a new build.
  useEffect(() => {
    const check = () => {
      void api.checkForUpdate().catch(() => {});
    };
    const interval = setInterval(check, checkIntervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, checkIntervalMs]);

  const update = useCallback<PwaUpdater>(async (reloadPage = true) => {
    await updaterRef.current?.(reloadPage);
  }, []);

  return { needRefresh, updateAvailableSeq, update };
}
