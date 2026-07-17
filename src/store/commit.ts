/**
 * The commit seam shared by store actions (spec §4.1). A *commit* finalises a change:
 * it applies the new state, records one undo entry (spec §4.5), and marks the owning
 * entities dirty for autosave (spec §4.4) — all through the same sync layer, because
 * `apply` performs the `set` that the `subscribeWithSelector` subscribers react to.
 *
 * A *transient* update (continuous gesture) bypasses this entirely — it only `set`s,
 * so subscribers still update the graph but no undo/autosave is produced (spec §4.1);
 * the gesture's single commit lands here on release.
 */
import { markDirty } from '@/core/project/dirty';
import { pushUndo } from './undo';

export interface CommitOptions {
  /** Undo/redo affordance label (spec §4.5). */
  readonly label: string;
  /** Apply the change (the absolute new state) — also used as the redo closure. */
  readonly apply: () => void;
  /** Revert to the prior state. */
  readonly revert: () => void;
  /** Entities to mark dirty for autosave (dirtyKey builders — spec §4.4). */
  readonly dirtyKeys: readonly string[];
  /** Gesture key: consecutive same-key commits coalesce to one undo step (spec §3.3). */
  readonly coalesceKey?: string;
}

/** Apply a change and record it for undo + autosave (spec §4.1, §4.4, §4.5). */
export function commit(options: CommitOptions): void {
  options.apply();
  pushUndo({
    label: options.label,
    undo: options.revert,
    redo: options.apply,
    ...(options.coalesceKey !== undefined ? { coalesceKey: options.coalesceKey } : {}),
  });
  for (const key of options.dirtyKeys) markDirty(key);
}
