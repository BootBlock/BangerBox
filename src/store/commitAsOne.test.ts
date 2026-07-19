/**
 * `commitAsOne` — grouping several commits into one undo entry (spec §4.5, §3.3).
 *
 * The distinction worth pinning is against `coalesceKey`, which looks like it would do
 * the same job and does not: coalescing keeps the LATEST redo, so replaying a group
 * through it would re-apply only the final step. These assert composition in both
 * directions, and that autosave is unaffected by the grouping.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AutosaveQueue } from '@/core/project/autosave';
import { registerAutosave, unregisterAutosave } from '@/core/project/dirty';
import { commit, commitAsOne } from './commit';
import { clearUndoHistory, useUndoStore } from './undo';

let queue: AutosaveQueue;
let dirty: MockInstance<(key: string) => void>;

/** A commit that appends to `log` on apply and removes the mark on revert. */
function step(log: string[], name: string) {
  return () =>
    commit({
      label: `Step ${name}`,
      apply: () => log.push(name),
      revert: () => {
        const index = log.lastIndexOf(name);
        if (index >= 0) log.splice(index, 1);
      },
      dirtyKeys: [`track:${name}`],
    });
}

beforeEach(() => {
  clearUndoHistory();
  queue = new AutosaveQueue({ flush: async () => {} });
  dirty = vi.spyOn(queue, 'markDirty');
  registerAutosave(queue);
});
afterEach(() => {
  unregisterAutosave();
  queue.dispose();
});

describe('commitAsOne', () => {
  it('records one undo entry for several commits, labelled by the group', () => {
    const log: string[] = [];
    commitAsOne('Duplicate sequence', () => {
      step(log, 'a')();
      step(log, 'b')();
    });

    expect(log).toEqual(['a', 'b']);
    expect(useUndoStore.getState().undoDepth).toBe(1);
    expect(useUndoStore.getState().undoLabel).toBe('Duplicate sequence');
  });

  it('undoes the group in reverse order', () => {
    const order: string[] = [];
    commitAsOne('Group', () => {
      commit({ label: 'a', apply: () => {}, revert: () => order.push('a'), dirtyKeys: [] });
      commit({ label: 'b', apply: () => {}, revert: () => order.push('b'), dirtyKeys: [] });
    });
    useUndoStore.getState().undo();
    expect(order).toEqual(['b', 'a']);
  });

  it('redoes every step, not only the last (what coalescing would get wrong)', () => {
    const log: string[] = [];
    commitAsOne('Group', () => {
      step(log, 'a')();
      step(log, 'b')();
    });
    useUndoStore.getState().undo();
    expect(log).toEqual([]);

    useUndoStore.getState().redo();
    expect(log).toEqual(['a', 'b']);
  });

  it('still marks every step dirty — grouping is an undo concern, not a save one', () => {
    commitAsOne('Group', () => {
      step([], 'a')();
      step([], 'b')();
    });
    expect(dirty.mock.calls.map(([key]) => key)).toEqual(['track:a', 'track:b']);
  });

  it('nests into the enclosing group rather than splitting it in two', () => {
    const log: string[] = [];
    commitAsOne('Outer', () => {
      step(log, 'a')();
      commitAsOne('Inner', () => step(log, 'b')());
    });
    expect(useUndoStore.getState().undoDepth).toBe(1);
    expect(useUndoStore.getState().undoLabel).toBe('Outer');
  });

  it('records what already applied when the body throws, so a partial edit is reversible', () => {
    const log: string[] = [];
    expect(() =>
      commitAsOne('Group', () => {
        step(log, 'a')();
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(log).toEqual(['a']);
    expect(useUndoStore.getState().undoDepth).toBe(1);
    useUndoStore.getState().undo();
    expect(log).toEqual([]);
  });

  it('records nothing when the body commits nothing', () => {
    commitAsOne('Group', () => {});
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('leaves later commits ungrouped once the transaction closes', () => {
    commitAsOne('Group', () => step([], 'a')());
    step([], 'b')();
    expect(useUndoStore.getState().undoDepth).toBe(2);
  });
});
