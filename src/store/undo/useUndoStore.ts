/**
 * Reactive undo/redo store (spec §4.5). Wraps a single {@link CommandStack} so the UI
 * (undo/redo toolbar buttons + Ctrl+Z/Ctrl+Y, spec §4.5) can subscribe to `canUndo`/
 * `canRedo`/labels, while store commit actions push commands imperatively via
 * {@link pushUndo}. The pure stack holds the logic; this is only the reactive shell.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { CommandStack, type UndoCommand, type UndoSnapshot } from './commandStack';

/** The single application undo history (spec §4.5 — one project, one timeline). */
const stack = new CommandStack();

interface UndoState extends UndoSnapshot {
  /** Record an undoable command (the change is already applied by the caller). */
  push: (command: UndoCommand) => void;
  undo: () => void;
  redo: () => void;
  /** Seal the current coalescing gesture (spec §3.3, gesture end). */
  endGesture: () => void;
  /** Drop all history — project load/close (spec §4.4). */
  clearHistory: () => void;
}

export const useUndoStore = create<UndoState>()(
  subscribeWithSelector((set) => {
    const refresh = () => set(stack.snapshot());
    return {
      ...stack.snapshot(),
      push: (command) => {
        stack.push(command);
        refresh();
      },
      undo: () => {
        stack.undo();
        refresh();
      },
      redo: () => {
        stack.redo();
        refresh();
      },
      endGesture: () => {
        stack.endCoalescing();
      },
      clearHistory: () => {
        stack.clear();
        refresh();
      },
    };
  }),
);

// --- Imperative helpers for non-React callers (store commit actions) --------------
export function pushUndo(command: UndoCommand): void {
  useUndoStore.getState().push(command);
}

export function endUndoGesture(): void {
  useUndoStore.getState().endGesture();
}

export function clearUndoHistory(): void {
  useUndoStore.getState().clearHistory();
}
