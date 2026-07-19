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

/**
 * The open {@link commitAsOne} transaction, collecting commits instead of pushing them.
 * Module-level rather than passed through every action: the actions being grouped are
 * ordinary store actions that know nothing about being composed (spec §3.1).
 */
let openTransaction: CommitOptions[] | null = null;

/** Apply a change and record it for undo + autosave (spec §4.1, §4.4, §4.5). */
export function commit(options: CommitOptions): void {
  options.apply();
  if (openTransaction !== null) {
    openTransaction.push(options);
  } else {
    pushUndo({
      label: options.label,
      undo: options.revert,
      redo: options.apply,
      ...(options.coalesceKey !== undefined ? { coalesceKey: options.coalesceKey } : {}),
    });
  }
  // Autosave is independent of the undo grouping: a grouped change is as dirty as an
  // ungrouped one, and holding the keys back would lose them if `body` threw.
  for (const key of options.dirtyKeys) markDirty(key);
}

/**
 * Run `body` so every {@link commit} inside it undoes as ONE entry labelled `label`
 * (spec §4.5). For a compound structural edit — duplicating a sequence copies the
 * sequence, each of its tracks and each track's events — where the user performed one
 * action and expects one Ctrl+Z, not one per row the operation happened to touch.
 *
 * This is not `coalesceKey`, and the two are not interchangeable. Coalescing keeps the
 * first entry's `undo` and the *latest* `redo`, which is right for a drag streaming
 * absolute values at one target and wrong here: redo would replay only the last of the
 * grouped commits. This composes all of them — undo in reverse, redo in order.
 *
 * A throw part-way still records what already applied, so a half-finished operation is
 * reversible rather than stranded on screen with no undo entry behind it.
 */
export function commitAsOne(label: string, body: () => void): void {
  // A nested call joins the outer transaction: the outermost caller names the action the
  // user actually took, and an inner group re-pushing its own entry would split it in two.
  if (openTransaction !== null) {
    body();
    return;
  }
  const collected: CommitOptions[] = [];
  openTransaction = collected;
  try {
    body();
  } finally {
    openTransaction = null;
    if (collected.length > 0) {
      pushUndo({
        label,
        undo: () => {
          for (let i = collected.length - 1; i >= 0; i--) collected[i]!.revert();
        },
        redo: () => {
          for (const options of collected) options.apply();
        },
      });
    }
  }
}
