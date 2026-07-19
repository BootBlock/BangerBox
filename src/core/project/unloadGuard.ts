/**
 * Unload guard (spec §4.4). Autosave is write-behind, so closing the tab, reloading, or
 * accepting a PWA update inside the debounce window would otherwise discard the pending
 * edits silently. This registers a `beforeunload` handler that asks the browser to confirm
 * the navigation whenever the project is modified, and kicks off a best-effort flush at the
 * same time — the confirmation dialog blocks the teardown, so the write usually lands while
 * the user is deciding. `beforeunload` cannot await, so the warning is the guarantee here;
 * the awaited flush belongs on the paths that control their own reload (the update prompt).
 *
 * The listener is attached only while there is unflushed work, because a permanently
 * registered `beforeunload` listener disqualifies the page from the back/forward cache.
 */
import { useProjectStore } from '@/store';
import type { Unsubscribe } from '@/store/syncLayer';

function onBeforeUnload(event: BeforeUnloadEvent): void {
  // Best-effort: may still complete while the confirmation dialog is up. Never allowed to
  // throw — an exception here would skip the warning that is the actual guarantee.
  try {
    void useProjectStore.getState().saveNow();
  } catch {
    // No service registered (teardown races); the warning below still stands.
  }
  // Both forms are needed — browsers disagree on which one arms the dialog.
  event.preventDefault();
  event.returnValue = '';
}

/**
 * Warn before unload while the project has unsaved edits. Call the returned disposer to
 * unwire the subscription and any attached listener (session teardown — spec §3.5 lens 5).
 */
export function installUnloadGuard(): Unsubscribe {
  let attached = false;

  const sync = (modified: boolean) => {
    if (modified === attached) return;
    if (modified) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
    attached = modified;
  };

  sync(useProjectStore.getState().modifiedSinceLastSave);
  const unsubscribe = useProjectStore.subscribe((state) => state.modifiedSinceLastSave, sync);

  return () => {
    unsubscribe();
    sync(false);
  };
}
