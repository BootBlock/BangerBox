/**
 * Reactive undo store tests (spec §4.5) — the snapshot fields track the underlying
 * stack, and the imperative helpers reach the same single history.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearUndoHistory, endUndoGesture, pushUndo, useUndoStore } from './useUndoStore';

beforeEach(() => {
  clearUndoHistory();
});

describe('useUndoStore', () => {
  it('reflects canUndo/undoLabel after a push and canRedo after an undo', () => {
    const cell = { v: 0 };
    pushUndo({
      label: 'set 1',
      undo: () => {
        cell.v = 0;
      },
      redo: () => {
        cell.v = 1;
      },
    });
    expect(useUndoStore.getState().canUndo).toBe(true);
    expect(useUndoStore.getState().undoLabel).toBe('set 1');

    useUndoStore.getState().undo();
    expect(cell.v).toBe(0);
    expect(useUndoStore.getState().canRedo).toBe(true);
    expect(useUndoStore.getState().redoLabel).toBe('set 1');
  });

  it('coalesces a gesture and seals it on endGesture', () => {
    const cell = { v: 0 };
    for (let step = 1; step <= 3; step += 1) {
      const prev = cell.v;
      cell.v = step;
      pushUndo({
        label: `set ${step}`,
        undo: () => {
          cell.v = prev;
        },
        redo: () => {
          cell.v = step;
        },
        coalesceKey: 'gesture',
      });
    }
    expect(useUndoStore.getState().undoDepth).toBe(1);
    endUndoGesture();
    expect(cell.v).toBe(3);
  });
});
