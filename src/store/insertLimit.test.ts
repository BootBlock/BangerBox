/**
 * A channel's insert chain is bounded by the §1.3.1 slot limit — issue #135.
 *
 * §1.3.1 gives every channel 4 insert slots, "configurable 1–8 via `globalInsertLimit`", and
 * §9.3 carries that as the `projects.insert_limit` column. `addInsert` appended without
 * consulting it, so a chain grew without end — and past slot 8 the §7.8 address grammar stops
 * parsing (`GLOBAL_INSERT_LIMIT_RANGE` bounds `slotN` in the registry), which takes the
 * panel's own knobs, every automation lane and every Q-Link binding on that slot with it
 * while the effect goes on sounding.
 *
 * Both sides are pinned here, because the defect has two: the store lets an effect reach a
 * position the limit forbids, and a position past the limit is unreachable. The second is
 * asserted as the §3.4 invariant it really is — every slot the store holds an effect in can
 * be addressed — rather than as a fact about the registry, so it is the CHAIN that fails
 * against the unfixed code and not the grammar.
 *
 * The limit is applied where a slot is CREATED, which §14 (ap) settled is exactly two
 * actions: `addInsert` and `replaceInsert`. Admission (`setChannels`, `upsertChannel`) is
 * deliberately not bounded — see the last block.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { insertParamPath, isAutomatable } from '@/core/audio/params/registry';
import { channelAutomatableParams } from '@/core/audio/params/catalogue';
import {
  createDefaultChannelStrip,
  createEmptyInsertSlot,
  GLOBAL_INSERT_LIMIT_RANGE,
  type ChannelStrip,
} from '@/core/project/schemas';
import { useMixerStore } from './useMixerStore';
import { useProjectStore } from './useProjectStore';
import { resetTransientChannel } from './transientChannel';
import { clearUndoHistory } from './undo';

const CHANNEL = 'track:1';
const DEFAULT_LIMIT = 4;

const stripNow = (id = CHANNEL): ChannelStrip => useMixerStore.getState().channels[id]!;
const occupied = (id = CHANNEL): number =>
  stripNow(id).inserts.filter((slot) => slot.effectType !== null).length;

/** Set the §9.3 `projects.insert_limit` the open project carries. */
function setLimit(limit: number): void {
  useProjectStore.getState().applyProject({
    projectId: 'proj-limit',
    projectName: 'Insert limit',
    sampleRate: 48_000,
    bitDepth: '24',
    globalInsertLimit: limit,
    bpmDefault: 120,
  });
}

/** A strip carrying `count` slots, the first `filled` of them holding a delay. */
function strip(id: string, count: number, filled = 0): ChannelStrip {
  return {
    ...createDefaultChannelStrip(id, 0),
    inserts: Array.from({ length: count }, (_, index) =>
      index < filled
        ? { ...createEmptyInsertSlot(), effectType: 'delay' as const, enabled: true, params: {} }
        : createEmptyInsertSlot(),
    ),
  };
}

beforeEach(() => {
  resetTransientChannel();
  clearUndoHistory();
  setLimit(DEFAULT_LIMIT);
  useMixerStore.getState().setChannels({
    [CHANNEL]: createDefaultChannelStrip(CHANNEL),
    master: createDefaultChannelStrip('master'),
    'return:0': createDefaultChannelStrip('return:0'),
  });
});

describe('the limit bounds what `addInsert` may create (spec §1.3.1, issue #135)', () => {
  it('never grows a channel past its §1.3.1 slot limit, however many times it is asked', () => {
    for (let i = 0; i < 12; i += 1) useMixerStore.getState().addInsert(CHANNEL, 'delay');
    expect(stripNow().inserts.length).toBe(DEFAULT_LIMIT);
    expect(occupied()).toBe(DEFAULT_LIMIT);
  });

  it('refuses in words once every slot within the limit is occupied', () => {
    for (let i = 0; i < DEFAULT_LIMIT; i += 1) {
      expect(useMixerStore.getState().addInsert(CHANNEL, 'delay')).toEqual({ ok: true });
    }
    const refusal = useMixerStore.getState().addInsert(CHANNEL, 'reverb');
    expect(refusal.ok).toBe(false);
    // A finished sentence the §8.5.6 panel shows verbatim, as `AssignResult` carries — the
    // store is the only layer that knows which rule refused (spec §4.2).
    expect(refusal.ok === false && refusal.reason).toContain('4');
    expect(occupied()).toBe(DEFAULT_LIMIT);
  });

  /**
   * `createDefaultChannelStrip` opens the §1.3.1 rack of four EMPTY slots, so an `addInsert`
   * that appends put the very first effect a user added on slot 5 — already past the default
   * limit, on a channel showing four empty rows above it.
   */
  it('fills the first empty slot of the default rack rather than appending past it', () => {
    const idBefore = stripNow().inserts[0]!.id;
    useMixerStore.getState().addInsert(CHANNEL, 'delay');
    expect(stripNow().inserts.length).toBe(DEFAULT_LIMIT);
    expect(stripNow().inserts[0]!.effectType).toBe('delay');
    expect(stripNow().inserts[0]!.enabled).toBe(true);
    expect(stripNow().inserts[1]!.effectType).toBeNull();
    // The slot keeps its own id, exactly as `replaceInsert` does: the id is the slot's handle
    // — its React key, and what the panel passes back to remove or bypass it.
    expect(stripNow().inserts[0]!.id).toBe(idBefore);
  });

  it('appends while the chain is SHORTER than the limit and holds no empty slot', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 2, 2) });
    expect(useMixerStore.getState().addInsert(CHANNEL, 'reverb')).toEqual({ ok: true });
    expect(stripNow().inserts.length).toBe(3);
    expect(stripNow().inserts[2]!.effectType).toBe('reverb');
  });

  it('takes the limit from the OPEN PROJECT, so raising it admits more slots', () => {
    setLimit(GLOBAL_INSERT_LIMIT_RANGE[1]);
    for (let i = 0; i < 12; i += 1) useMixerStore.getState().addInsert(CHANNEL, 'delay');
    expect(stripNow().inserts.length).toBe(8);
    expect(occupied()).toBe(8);
  });

  it('bounds a limit of 1 to one slot', () => {
    setLimit(1);
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 1) });
    expect(useMixerStore.getState().addInsert(CHANNEL, 'delay')).toEqual({ ok: true });
    expect(useMixerStore.getState().addInsert(CHANNEL, 'reverb').ok).toBe(false);
    expect(stripNow().inserts.length).toBe(1);
  });

  /**
   * §1.3.1 names "per pad, per track, and on the master" and §5.2 gives the returns their own
   * strips, which §8.5.6 edits on its own tab. One rule for every channel: a second one would
   * be a second thing to forget, and a `insert:return:0:slot9.mix` address goes dead in
   * exactly the same way a track's does.
   */
  it('bounds the master and the returns by the same rule', () => {
    for (const id of ['master', 'return:0']) {
      for (let i = 0; i < 12; i += 1) useMixerStore.getState().addInsert(id, 'delay');
      expect(stripNow(id).inserts.length, id).toBe(DEFAULT_LIMIT);
    }
  });

  it('refuses a channel that has no strip at all, rather than inventing one', () => {
    expect(useMixerStore.getState().addInsert('track:absent', 'delay').ok).toBe(false);
    expect(useMixerStore.getState().channels['track:absent']).toBeUndefined();
  });
});

describe('the limit bounds what `replaceInsert` may occupy (spec §1.3.1, §14 (ap))', () => {
  it('refuses to put an effect in a slot the limit forbids', () => {
    // A chain a project already on disk can carry: six slots, all empty (see the last block).
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 6) });
    const beyond = stripNow().inserts[5]!.id;
    const refusal = useMixerStore.getState().replaceInsert(CHANNEL, beyond, 'delay');
    expect(refusal.ok).toBe(false);
    expect(stripNow().inserts[5]!.effectType).toBeNull();
  });

  it('still replaces a slot INSIDE the limit', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 6, 1) });
    const inside = stripNow().inserts[0]!.id;
    expect(useMixerStore.getState().replaceInsert(CHANNEL, inside, 'reverb')).toEqual({ ok: true });
    expect(stripNow().inserts[0]!.effectType).toBe('reverb');
  });

  it('names the SLOT rather than a full chain, because the chain need not be full', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 6) });
    const refusal = useMixerStore.getState().replaceInsert(CHANNEL, stripNow().inserts[5]!.id, 'delay');
    // "All 4 insert slots are in use" would name the wrong rule: five of the six are empty.
    expect(refusal.ok === false && refusal.reason).toContain('Slot 6');
    expect(refusal.ok === false && refusal.reason).not.toContain('in use');
  });

  it('refuses a slot id the channel does not hold', () => {
    expect(useMixerStore.getState().replaceInsert(CHANNEL, 'not-a-slot', 'delay').ok).toBe(false);
  });
});

describe('an out-of-range limit from a project (spec §4.1, §9.3, §9.6)', () => {
  /**
   * §9.3 declares no CHECK on `projects.insert_limit`, `rowToProjectSettings` copies the
   * column straight through and §9.6's manifest types it as a bare number — so a hand-edited
   * row or an imported project can carry any value at all. Enforcing the limit is what made
   * that matter: `20` would build chains no §7.8 address can reach, and `0` would lock every
   * channel out of inserts entirely.
   */
  it('clamps a hydrated limit above the §1.3.1 range, and still bounds the chain by it', () => {
    setLimit(20);
    expect(useProjectStore.getState().globalInsertLimit).toBe(GLOBAL_INSERT_LIMIT_RANGE[1]);
    for (let i = 0; i < 12; i += 1) useMixerStore.getState().addInsert(CHANNEL, 'delay');
    expect(stripNow().inserts.length).toBe(GLOBAL_INSERT_LIMIT_RANGE[1]);
  });

  it('clamps one below it, so a channel is never locked out of inserts', () => {
    setLimit(0);
    expect(useProjectStore.getState().globalInsertLimit).toBe(GLOBAL_INSERT_LIMIT_RANGE[0]);
    expect(useMixerStore.getState().addInsert(CHANNEL, 'delay').ok).toBe(true);
  });
});

describe('every slot the store holds an effect in is ADDRESSABLE (spec §3.4, §7.8)', () => {
  /**
   * The §3.4 invariant, stated the way the user meets it: an effect that sounds but cannot be
   * reached by a §7.8 address is a dead control on every surface at once — the §8.5.6 panel's
   * own knobs, a §8.5.2 automation lane, an §8.5.10 XY axis and a §10.3 Q-Link binding.
   */
  it('leaves no occupied slot the §7.8 grammar refuses, however hard the chain is grown', () => {
    for (let i = 0; i < 12; i += 1) useMixerStore.getState().addInsert(CHANNEL, 'delay');
    stripNow().inserts.forEach((slot, index) => {
      if (slot.effectType === null) return;
      const path = insertParamPath(CHANNEL, index + 1, 'time');
      expect(isAutomatable(path), path).toBe(true);
    });
  });

  it('offers every occupied slot to the §7.8 catalogue a picker reads', () => {
    for (let i = 0; i < 12; i += 1) useMixerStore.getState().addInsert(CHANNEL, 'delay');
    const offered = channelAutomatableParams(CHANNEL, stripNow(), 'Drums');
    for (let index = 0; index < stripNow().inserts.length; index += 1) {
      if (stripNow().inserts[index]!.effectType === null) continue;
      const path = insertParamPath(CHANNEL, index + 1, 'time');
      expect(
        offered.some((param) => param.path === path),
        path,
      ).toBe(true);
    }
  });

  /**
   * The other half of the same statement, and the reason the limit matters at all: a
   * `mixer.commit` on an address the grammar refuses writes NOTHING, so the knob turns and
   * the effect does not move.
   */
  it('writes nothing through a slot address past the grammar’s own bound', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 9, 9) });
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 9, 'time'), 600);
    // Still the §5.7 default the completion gave it — the write reached nothing at all.
    expect(stripNow().inserts[8]!.params.time).toBe(350);
    // Slot 8 — the last the §7.8 grammar admits — takes the same write.
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 8, 'time'), 600);
    expect(stripNow().inserts[7]!.params.time).toBe(600);
  });
});

describe('a chain that is ALREADY over the limit (spec §4.4, §9.6, §9.8, §14 (ap))', () => {
  /**
   * A §9.6 import, a §9.8 pack or a project saved before this fix can carry a chain longer
   * than the limit. Three answers were available — refuse the project, truncate it, or keep
   * it — and this is §14 (ap)'s "the stored value always wins and nothing is repaired" one
   * level up: refusing makes a project unopenable over an insert slot, and truncating deletes
   * audio the user made without being asked. The chain is admitted WHOLE and it sounds. What
   * is past the limit stays unaddressable, which is the pre-existing §7.8 consequence and is
   * not made worse; nothing the app itself builds can reach that state after this fix.
   */
  it('admits an over-long chain through setChannels without truncating it', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 9, 9) });
    expect(stripNow().inserts.length).toBe(9);
    expect(occupied()).toBe(9);
  });

  it('admits one through upsertChannel too', () => {
    useMixerStore.getState().upsertChannel(strip(CHANNEL, 9, 9));
    expect(stripNow().inserts.length).toBe(9);
  });

  it('refuses to make an over-long chain any longer', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 9, 9) });
    expect(useMixerStore.getState().addInsert(CHANNEL, 'reverb').ok).toBe(false);
    expect(stripNow().inserts.length).toBe(9);
  });

  /**
   * Lowering the limit does not repair a chain either — same rule, read the other way. It
   * bounds what may be created NEXT, and the effects already there go on sounding.
   */
  it('leaves an existing chain alone when the limit is lowered under it', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: strip(CHANNEL, 6, 6) });
    setLimit(2);
    useMixerStore.getState().upsertChannel(stripNow());
    expect(occupied()).toBe(6);
    expect(useMixerStore.getState().addInsert(CHANNEL, 'reverb').ok).toBe(false);
  });
});
