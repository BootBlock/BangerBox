/**
 * Removing an insert EMPTIES its slot; it never drops the slot from the rack — issue #142.
 *
 * §14 (ar) made a §7.8 `slotN` address 1-based over the §4.2 slot ARRAY, on both sides of the
 * graph, so `insert:track:<id>:slot3.cutoff` means "whatever is in slot 3". `removeInsert`
 * wrote `prev.inserts.filter(...)`, which drops the slot — so every address BEHIND the removed
 * one shifted onto a different effect: the filter that was in slot 3 started answering to
 * `slot2`, and every §7.8 lane, §8.5.10 axis and §10.3 binding on those slots moved with it.
 * The §1.3.1 rack also got one slot shorter on every removal, so a channel that had lost three
 * effects could hold only one more.
 *
 * This is the editing-side half of what §14 (ar) fixed for the wiring side, and it is settled
 * the way §14 (au) settled `addInsert`: the rack is `globalInsertLimit` slots long, an empty
 * slot is a first-class thing rather than an absence, and a slot's identity is its POSITION.
 * A removal therefore changes exactly one slot and nothing else in the array.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { insertParamPath } from '@/core/audio/params/registry';
import {
  createDefaultChannelStrip,
  createEmptyInsertSlot,
  type ChannelStrip,
  type EffectType,
} from '@/core/project/schemas';
import { useMixerStore } from './useMixerStore';
import { useProjectStore } from './useProjectStore';
import { resetTransientChannel } from './transientChannel';
import { clearUndoHistory, useUndoStore } from './undo';

const CHANNEL = 'track:1';
const DEFAULT_LIMIT = 4;

const stripNow = (id = CHANNEL): ChannelStrip => useMixerStore.getState().channels[id]!;
const typesNow = (id = CHANNEL): (EffectType | null)[] => stripNow(id).inserts.map((slot) => slot.effectType);

/** Set the §9.3 `projects.insert_limit` the open project carries. */
function setLimit(limit: number): void {
  useProjectStore.getState().applyProject({
    projectId: 'proj-remove',
    projectName: 'Insert remove',
    sampleRate: 48_000,
    bitDepth: '24',
    globalInsertLimit: limit,
    bpmDefault: 120,
  });
}

/** A strip of `count` slots holding `types` in order, the rest empty. */
function strip(id: string, count: number, types: readonly (EffectType | null)[]): ChannelStrip {
  return {
    ...createDefaultChannelStrip(id, 0),
    inserts: Array.from({ length: count }, (_, index) => {
      const effectType = types[index] ?? null;
      return effectType === null
        ? createEmptyInsertSlot()
        : { ...createEmptyInsertSlot(), effectType, enabled: true, params: {} };
    }),
  };
}

/** Fill the default four-slot rack with an eq4, a delay and a filter, leaving slot 4 empty. */
function threeInFour(): void {
  useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 4, ['eq4', 'delay', 'filter']) });
}

beforeEach(() => {
  resetTransientChannel();
  clearUndoHistory();
  setLimit(DEFAULT_LIMIT);
  useMixerStore.getState().setChannels({ [CHANNEL]: createDefaultChannelStrip(CHANNEL) });
});

describe('a removal empties one slot and moves nothing (spec §5.2, §7.8, issue #142)', () => {
  it('keeps the §1.3.1 rack the same length', () => {
    threeInFour();
    const slotId = stripNow().inserts[1]!.id;
    useMixerStore.getState().removeInsert(CHANNEL, slotId);
    expect(stripNow().inserts.length).toBe(4);
  });

  it('empties the slot in place rather than dropping it', () => {
    threeInFour();
    const slotId = stripNow().inserts[1]!.id;
    useMixerStore.getState().removeInsert(CHANNEL, slotId);
    const emptied = stripNow().inserts[1]!;
    expect(emptied.effectType).toBeNull();
    // §14 (an): an empty slot reads as EMPTY, never as bypassed — `createEmptyInsertSlot`'s
    // own shape, so §8.5.6 draws an unpressed, disabled bypass rather than a lit one.
    expect(emptied.enabled).toBe(false);
    // The outgoing effect's §5.7 values have no meaning in an empty slot, and a later
    // `addInsert` here seeds the incoming effect's own defaults (§14 (ap)).
    expect(emptied.params).toEqual({});
  });

  /**
   * The defect as the user meets it. Slot 3 holds a filter; removing slot 2 used to slide it
   * onto the `slot2` address, where somebody else's lane already lived.
   */
  it('leaves every slot BEHIND the removed one at its own §7.8 address', () => {
    threeInFour();
    const slotId = stripNow().inserts[1]!.id;
    useMixerStore.getState().removeInsert(CHANNEL, slotId);
    expect(typesNow()).toEqual(['eq4', null, 'filter', null]);
  });

  /**
   * The same statement in the grammar the graph and the panel both speak: `slot3` still names
   * the filter, and the filter is still what `slot3` writes reach (spec §7.8, §14 (ar)).
   */
  it('keeps a §7.8 slot address pointing at the effect it named', () => {
    threeInFour();
    const slotId = stripNow().inserts[1]!.id;
    useMixerStore.getState().removeInsert(CHANNEL, slotId);
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 3, 'cutoff'), 800);
    const slot3 = stripNow().inserts[2]!;
    expect(slot3.effectType).toBe('filter');
    expect(slot3.params.cutoff).toBe(800);
  });

  /**
   * The id is the SLOT's handle, not the effect's — §14 (au)'s reading of `addInsert` and
   * `replaceInsert`, which both keep it. It is the panel's React key and what every control
   * in the row passes back, so minting a new one would remount a row that has not moved.
   */
  it('keeps the emptied slot’s own id', () => {
    threeInFour();
    const before = stripNow().inserts.map((slot) => slot.id);
    useMixerStore.getState().removeInsert(CHANNEL, before[1]!);
    expect(stripNow().inserts.map((slot) => slot.id)).toEqual(before);
  });

  it('frees the slot for the next add, which fills it (spec §1.3.1, §14 (au))', () => {
    threeInFour();
    useMixerStore.getState().removeInsert(CHANNEL, stripNow().inserts[1]!.id);
    expect(useMixerStore.getState().addInsert(CHANNEL, 'reverb')).toEqual({ ok: true });
    expect(typesNow()).toEqual(['eq4', 'reverb', 'filter', null]);
  });

  /**
   * The rack used to shrink by one on every removal, so a channel that had lost three effects
   * could hold only one more — §1.3.1's four slots quietly becoming one.
   */
  it('does not shrink the rack’s capacity across repeated add and remove cycles', () => {
    for (let i = 0; i < 3; i += 1) {
      const added = useMixerStore.getState().addInsert(CHANNEL, 'delay');
      expect(added).toEqual({ ok: true });
      const slot = stripNow().inserts.find((s) => s.effectType !== null)!;
      useMixerStore.getState().removeInsert(CHANNEL, slot.id);
    }
    expect(stripNow().inserts.length).toBe(DEFAULT_LIMIT);
    for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
      expect(useMixerStore.getState().addInsert(CHANNEL, 'delay').ok).toBe(true);
    }
    expect(typesNow()).toEqual(['delay', 'delay', 'delay', 'delay']);
  });

  it('restores the effect, in its own slot, on undo (spec §4.5)', () => {
    threeInFour();
    useMixerStore.getState().removeInsert(CHANNEL, stripNow().inserts[1]!.id);
    useUndoStore.getState().undo();
    expect(typesNow()).toEqual(['eq4', 'delay', 'filter', null]);
  });
});

describe('a removal that removes nothing does nothing (spec §4.5)', () => {
  /**
   * `removeInsert` used to commit an undo entry whatever it was handed: the filter simply
   * found no match, wrote the same array back, and left a "Remove insert" step in the history
   * that undid nothing. A no-op is not an edit.
   */
  it('records no undo entry for a slot id the channel does not hold', () => {
    threeInFour();
    useMixerStore.getState().removeInsert(CHANNEL, 'not-a-slot');
    expect(typesNow()).toEqual(['eq4', 'delay', 'filter', null]);
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('records no undo entry for a slot that is already empty', () => {
    threeInFour();
    useMixerStore.getState().removeInsert(CHANNEL, stripNow().inserts[3]!.id);
    expect(stripNow().inserts.length).toBe(4);
    expect(useUndoStore.getState().canUndo).toBe(false);
  });

  it('does nothing at all for a channel with no strip', () => {
    threeInFour();
    useMixerStore.getState().removeInsert('track:absent', stripNow().inserts[0]!.id);
    expect(typesNow()).toEqual(['eq4', 'delay', 'filter', null]);
  });
});

describe('a chain already OVER the §1.3.1 limit (spec §14 (ap), §14 (au))', () => {
  /**
   * §14 (au) admits an over-long chain WHOLE and repairs nothing. A removal is not the place
   * that repair arrives either: emptying slot 3 of nine leaves nine slots, so the six effects
   * behind it keep the addresses the project saved them under. Truncating to the limit here
   * would delete five effects the user made — exactly what admission refuses to do.
   */
  it('empties a slot inside an over-long chain without shortening it', () => {
    useMixerStore.getState().setChannels({
      [CHANNEL]: strip(
        CHANNEL,
        9,
        Array.from({ length: 9 }, () => 'filter' as const),
      ),
    });
    useMixerStore.getState().removeInsert(CHANNEL, stripNow().inserts[2]!.id);
    expect(stripNow().inserts.length).toBe(9);
    expect(typesNow()[2]).toBeNull();
    expect(typesNow()[8]).toBe('filter');
  });

  /**
   * And the limit still bounds what may be created afterwards: the freed slot is inside it, so
   * the add lands there rather than growing the chain to ten (§14 (au)).
   */
  it('lets the next add fill the freed slot rather than lengthen the chain', () => {
    useMixerStore.getState().setChannels({
      [CHANNEL]: strip(
        CHANNEL,
        9,
        Array.from({ length: 9 }, () => 'filter' as const),
      ),
    });
    useMixerStore.getState().removeInsert(CHANNEL, stripNow().inserts[1]!.id);
    expect(useMixerStore.getState().addInsert(CHANNEL, 'reverb')).toEqual({ ok: true });
    expect(stripNow().inserts.length).toBe(9);
    expect(typesNow()[1]).toBe('reverb');
  });
});
