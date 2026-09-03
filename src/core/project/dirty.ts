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

/** Human plural of a dirty-key kind, for a message a user reads (spec §4.4). */
const KIND_NOUNS: Record<string, readonly [string, string]> = {
  project: ['project setting', 'project settings'],
  sequence: ['sequence', 'sequences'],
  track: ['track', 'tracks'],
  program: ['program', 'programs'],
  events: ['track of notes', 'tracks of notes'],
  automation: ['automation lane', 'automation lanes'],
  song: ['song arrangement', 'song arrangement'],
  settings: ['setting', 'settings'],
};

/**
 * Describe a set of dirty keys as something a user can read — "2 sequences and 1 track"
 * (spec §4.4, issue #103).
 *
 * A refusal has to name what it is refusing over, and a key is `sequence:<uuid>`: a raw id
 * tells the user nothing they can act on, while the COUNT per kind tells them how much work
 * is at stake. Kinds are listed in the §4.4 dirty-key order so the phrasing is stable rather
 * than following iteration order.
 */
export function describeDirtyKeys(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const kind = key.slice(0, key.indexOf(':'));
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const kind of Object.keys(KIND_NOUNS)) {
    const count = counts.get(kind);
    if (count === undefined) continue;
    const [one, many] = KIND_NOUNS[kind]!;
    parts.push(`${count} ${count === 1 ? one : many}`);
  }
  // An unrecognised kind is still real unsaved work; count its keys rather than dropping them.
  let other = 0;
  for (const [kind, count] of counts) if (!(kind in KIND_NOUNS)) other += count;
  if (other > 0) parts.push(`${other} other change${other === 1 ? '' : 's'}`);

  if (parts.length === 0) return 'unsaved changes';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
