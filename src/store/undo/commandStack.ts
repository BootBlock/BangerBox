/**
 * Command-pattern undo core (spec §4.5). Each undoable action records an
 * {@link UndoCommand} — `{ label, undo(), redo() }` closures capturing minimal diffs,
 * never full snapshots. Depth is capped at `UNDO_LIMIT` (spec §2.6). Continuous
 * gestures coalesce into a single entry (spec §3.3): a knob/fader drag commits many
 * times under one `coalesceKey` but undoes as one step back to the pre-gesture value.
 *
 * Pure and framework-free so it is unit-testable in isolation (spec §11.1); the
 * reactive `useUndoStore` wraps a single instance for the UI (spec §4.5 exposure).
 */
import { UNDO_LIMIT } from '@/core/constants';

export interface UndoCommand {
  /** Human-readable label for the undo/redo affordance (e.g. "Set track level"). */
  readonly label: string;
  /** Revert the change. */
  readonly undo: () => void;
  /** Re-apply the change. */
  readonly redo: () => void;
  /**
   * Optional gesture key. Consecutive pushes sharing a key merge into one entry —
   * the first entry's `undo` (pre-gesture state) is kept and the latest `redo` wins
   * (spec §3.3). {@link CommandStack.endCoalescing} seals the run at gesture end.
   */
  readonly coalesceKey?: string;
}

/** Immutable view of the stack state, for driving reactive UI (spec §4.5). */
export interface UndoSnapshot {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export class CommandStack {
  private readonly undoStack: UndoCommand[] = [];
  private readonly redoStack: UndoCommand[] = [];
  /** The coalesce key of the current top entry, while a gesture is still open. */
  private openCoalesceKey: string | undefined = undefined;

  /**
   * Record a command. Executing the change itself is the caller's job (the store
   * action already applied it) — the stack only stores how to reverse/replay it.
   * Any pending redo history is discarded (a new edit forks the timeline).
   */
  push(command: UndoCommand): void {
    this.redoStack.length = 0;

    const top = this.undoStack[this.undoStack.length - 1];
    if (
      command.coalesceKey !== undefined &&
      command.coalesceKey === this.openCoalesceKey &&
      top !== undefined
    ) {
      // Merge into the open gesture: keep the pre-gesture undo, take the latest redo.
      this.undoStack[this.undoStack.length - 1] = {
        label: command.label,
        undo: top.undo,
        redo: command.redo,
        coalesceKey: command.coalesceKey,
      };
      return;
    }

    this.undoStack.push(command);
    this.openCoalesceKey = command.coalesceKey;

    // Enforce the depth cap by dropping the oldest entries (spec §2.6 UNDO_LIMIT).
    while (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }

  /**
   * Seal the current coalescing run so the next push — even with the same key —
   * starts a fresh entry. Called by the store on gesture end (spec §3.3).
   */
  endCoalescing(): void {
    this.openCoalesceKey = undefined;
  }

  /** Undo the most recent command; returns its label, or null when empty. */
  undo(): string | null {
    const command = this.undoStack.pop();
    if (command === undefined) return null;
    this.openCoalesceKey = undefined;
    command.undo();
    this.redoStack.push(command);
    return command.label;
  }

  /** Redo the most recently undone command; returns its label, or null when empty. */
  redo(): string | null {
    const command = this.redoStack.pop();
    if (command === undefined) return null;
    this.openCoalesceKey = undefined;
    command.redo();
    this.undoStack.push(command);
    return command.label;
  }

  /** Drop all history (project load/close — spec §4.4 hydration). */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.openCoalesceKey = undefined;
  }

  snapshot(): UndoSnapshot {
    const undoTop = this.undoStack[this.undoStack.length - 1];
    const redoTop = this.redoStack[this.redoStack.length - 1];
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: undoTop?.label ?? null,
      redoLabel: redoTop?.label ?? null,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
    };
  }
}
