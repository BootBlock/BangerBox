/**
 * Undo core tests (spec §4.5, §11.1) — including gesture coalescing (spec §3.3) and
 * the `UNDO_LIMIT` depth cap (spec §2.6), a Phase 2 exit criterion (spec §12).
 */
import { describe, expect, it } from 'vitest';
import { UNDO_LIMIT } from '@/core/constants';
import { CommandStack, type UndoCommand } from './commandStack';

/** A command that writes `value` into a shared cell on redo and `prev` on undo. */
function assign(cell: { v: number }, prev: number, next: number, coalesceKey?: string): UndoCommand {
  return {
    label: `set ${next}`,
    undo: () => {
      cell.v = prev;
    },
    redo: () => {
      cell.v = next;
    },
    coalesceKey,
  };
}

describe('CommandStack', () => {
  it('undoes and redoes single commands', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    cell.v = 5;
    stack.push(assign(cell, 0, 5));

    expect(stack.snapshot().canUndo).toBe(true);
    expect(stack.undo()).toBe('set 5');
    expect(cell.v).toBe(0);
    expect(stack.snapshot().canRedo).toBe(true);

    expect(stack.redo()).toBe('set 5');
    expect(cell.v).toBe(5);
  });

  it('coalesces consecutive commands under one key into a single undo step (spec §3.3)', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    // Simulate a fader drag: many commits, one gesture key.
    for (let step = 1; step <= 5; step += 1) {
      const prev = cell.v;
      cell.v = step * 10;
      stack.push(assign(cell, prev, cell.v, 'mixer:track:1:level'));
    }
    expect(cell.v).toBe(50);
    expect(stack.snapshot().undoDepth).toBe(1); // collapsed to one entry

    // One undo returns to the pre-gesture value, not the previous drag frame.
    expect(stack.undo()).toBe('set 50');
    expect(cell.v).toBe(0);
    // One redo restores the final value.
    stack.redo();
    expect(cell.v).toBe(50);
  });

  it('starts a fresh entry after the gesture is sealed', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    cell.v = 10;
    stack.push(assign(cell, 0, 10, 'g'));
    stack.endCoalescing();
    cell.v = 20;
    stack.push(assign(cell, 10, 20, 'g'));

    expect(stack.snapshot().undoDepth).toBe(2);
    stack.undo();
    expect(cell.v).toBe(10);
    stack.undo();
    expect(cell.v).toBe(0);
  });

  it('does not coalesce commands without a key', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    stack.push(assign(cell, 0, 1));
    stack.push(assign(cell, 1, 2));
    expect(stack.snapshot().undoDepth).toBe(2);
  });

  it('discards redo history when a new command is pushed', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    stack.push(assign(cell, 0, 1));
    stack.undo();
    expect(stack.snapshot().canRedo).toBe(true);
    stack.push(assign(cell, 0, 9));
    expect(stack.snapshot().canRedo).toBe(false);
  });

  it('caps depth at UNDO_LIMIT, dropping the oldest entries (spec §2.6)', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    for (let i = 0; i < UNDO_LIMIT + 25; i += 1) stack.push(assign(cell, i, i + 1));
    expect(stack.snapshot().undoDepth).toBe(UNDO_LIMIT);
  });

  it('clears all history', () => {
    const cell = { v: 0 };
    const stack = new CommandStack();
    stack.push(assign(cell, 0, 1));
    stack.clear();
    expect(stack.snapshot().canUndo).toBe(false);
    expect(stack.snapshot().canRedo).toBe(false);
  });
});
