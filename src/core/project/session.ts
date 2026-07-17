/**
 * Project session bootstrap (spec §4.4). Run once at app start (after the capability
 * gate and multi-tab guard): boot the database, open or create the active project and
 * hydrate the stores, then register the store→graph sync subscribers (spec §4.3) and
 * an autosave flush on tab-hide (spec §4.4). A failure surfaces as a toast, never a
 * white screen (spec §8.1) — the storage panel independently reports the boot fault.
 */
import { bootDatabase } from '@/core/storage/client';
import { useUIStore } from '@/store';
import { registerSyncSubscribers, type Unsubscribe } from '@/store/syncLayer';
import { installProjectService, loadOrCreateActiveProject, projectService } from './projectService';

let syncDispose: Unsubscribe | null = null;
let visibilityHandler: (() => void) | null = null;

export async function startProjectSession(): Promise<void> {
  installProjectService();
  try {
    await bootDatabase();
    await loadOrCreateActiveProject();
    syncDispose = registerSyncSubscribers();
    visibilityHandler = () => {
      if (document.visibilityState === 'hidden') void projectService.saveNow();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  } catch {
    useUIStore
      .getState()
      .pushToast('BangerBox could not open your project — storage may be unavailable.', 'error');
  }
}

/** Tear the session down (test teardown / hot reload). */
export function stopProjectSession(): void {
  syncDispose?.();
  syncDispose = null;
  if (visibilityHandler !== null) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}
