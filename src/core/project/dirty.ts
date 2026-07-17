/**
 * Autosave dirty-tracking bridge (spec §4.4). Store commit actions call
 * {@link markDirty} without importing the autosave queue or the project store —
 * this indirection is registered by the project-load layer once a project is open,
 * and is a no-op before hydration or in unit tests (keeping the stores cycle-free).
 */
import type { AutosaveQueue } from './autosave';

interface AutosaveHooks {
  /** Called on every mutation so the project store can raise its unsaved dot (spec §4.4). */
  readonly onDirty: () => void;
}

let activeQueue: AutosaveQueue | null = null;
let hooks: AutosaveHooks | null = null;

/** Wire the active project's autosave queue (project load — spec §4.4). */
export function registerAutosave(queue: AutosaveQueue, autosaveHooks: AutosaveHooks): void {
  activeQueue = queue;
  hooks = autosaveHooks;
}

/** Unwire on project close (spec §4.4). */
export function unregisterAutosave(): void {
  activeQueue = null;
  hooks = null;
}

/** Canonical dirty-key builders — one entity, one key, coalesced by the queue (spec §4.4). */
export const dirtyKey = {
  project: (id: string) => `project:${id}`,
  sequence: (id: string) => `sequence:${id}`,
  track: (id: string) => `track:${id}`,
  program: (id: string) => `program:${id}`,
  events: (trackId: string) => `events:${trackId}`,
  automation: (scope: string, ownerId: string, targetPath: string) =>
    `automation:${scope}:${ownerId}:${targetPath}`,
  song: (projectId: string) => `song:${projectId}`,
  settings: (key: string) => `settings:${key}`,
} as const;

/** Mark an entity dirty for write-behind autosave, and raise the unsaved dot (spec §4.4). */
export function markDirty(key: string): void {
  activeQueue?.markDirty(key);
  hooks?.onDirty();
}
