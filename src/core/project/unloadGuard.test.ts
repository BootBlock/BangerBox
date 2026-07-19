/**
 * Unload guard (issue #42): the tab must not close on unflushed edits without a warning,
 * and the listener must exist only while there is something to lose — a permanently
 * registered `beforeunload` listener would cost the page its back/forward cache entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '@/store';
import { registerProjectService } from './service';
import { installUnloadGuard } from './unloadGuard';

let dispose: (() => void) | null = null;
let saveNow: ReturnType<typeof vi.fn>;

/** Fire a `beforeunload` and report whether a listener asked to block the navigation. */
function fireBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  saveNow = vi.fn(async () => {});
  registerProjectService({
    newProject: async () => '',
    loadProject: async () => {},
    saveNow: saveNow as unknown as () => Promise<void>,
    exportMpcweb: async () => new Blob(),
    importMpcweb: async () => '',
  });
  useProjectStore.getState().setModified(false);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  useProjectStore.getState().setModified(false);
});

describe('installUnloadGuard', () => {
  it('does not warn while every edit is flushed', () => {
    dispose = installUnloadGuard();
    expect(fireBeforeUnload()).toBe(false);
  });

  it('warns and attempts a flush once the project is modified', () => {
    dispose = installUnloadGuard();
    useProjectStore.getState().setModified(true);

    expect(fireBeforeUnload()).toBe(true);
    expect(saveNow).toHaveBeenCalledTimes(1);
  });

  it('attaches to an already-modified project at install time', () => {
    useProjectStore.getState().setModified(true);
    dispose = installUnloadGuard();

    expect(fireBeforeUnload()).toBe(true);
  });

  it('stops warning once the queue drains', () => {
    dispose = installUnloadGuard();
    useProjectStore.getState().setModified(true);
    useProjectStore.getState().setModified(false);

    expect(fireBeforeUnload()).toBe(false);
    expect(saveNow).not.toHaveBeenCalled();
  });

  it('detaches on dispose even while modified', () => {
    dispose = installUnloadGuard();
    useProjectStore.getState().setModified(true);
    dispose();
    dispose = null;

    expect(fireBeforeUnload()).toBe(false);
  });
});
