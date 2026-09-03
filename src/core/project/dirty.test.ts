/**
 * Describing unsaved work in words a user can act on (spec §4.4 — issue #103).
 *
 * A project switch that refuses has to say what it is refusing over, and a dirty key is
 * `sequence:<uuid>`. A raw id tells the user nothing; the count per kind tells them how much
 * work is at stake and whether it is worth exporting for.
 */
import { describe, expect, it } from 'vitest';
import { describeDirtyKeys, dirtyKey } from './dirty';

describe('describeDirtyKeys (spec §4.4)', () => {
  it('names a single entity in the singular', () => {
    expect(describeDirtyKeys([dirtyKey.sequence('a')])).toBe('1 sequence');
  });

  it('counts each kind and pluralises it', () => {
    const keys = [dirtyKey.sequence('a'), dirtyKey.sequence('b'), dirtyKey.track('c')];
    expect(describeDirtyKeys(keys)).toBe('2 sequences and 1 track');
  });

  it('lists three or more kinds in the §4.4 dirty-key order, not iteration order', () => {
    const keys = [dirtyKey.events('t'), dirtyKey.project('p'), dirtyKey.program('g')];
    expect(describeDirtyKeys(keys)).toBe('1 project setting, 1 program and 1 track of notes');
  });

  it('counts an unrecognised kind rather than dropping it', () => {
    // Unsaved work is unsaved work; a kind this table has not caught up with must still be
    // reported, or the refusal understates what is at stake.
    expect(describeDirtyKeys(['nonsense:1', 'nonsense:2'])).toBe('2 other changes');
  });

  it('falls back to a plain phrase for an empty set', () => {
    expect(describeDirtyKeys([])).toBe('unsaved changes');
  });
});
