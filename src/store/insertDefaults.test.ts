/**
 * A slot's params are complete for the effect in it — spec §3.4, issue #131.
 *
 * §3.4 requires that "the store value reflects the actual node state". `createInsert`
 * merges `defaultEffectParams` on the graph side, so a slot carrying `params: {}` SOUNDS at
 * the §5.7 defaults; every reader of the store — the §8.5.6 panel, the §4.1 gesture origin,
 * the §7.8 automation lane, an XYFX axis — falls back to the range FLOOR instead. A fresh
 * delay therefore ran at 350 ms and read as 1 ms.
 *
 * The completion belongs where a slot enters the store, and there are two such places: the
 * action that creates one, and the admission of one loaded from a project. Both are here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultEffectParams, EFFECT_PARAM_RANGES } from '@/core/audio/inserts/effectParams';
import { insertParamPath } from '@/core/audio/params/registry';
import { createDefaultChannelStrip, EFFECT_TYPES, type ChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from './useMixerStore';
import { resetTransientChannel } from './transientChannel';
import { clearUndoHistory, useUndoStore } from './undo';

const CHANNEL = 'track:1';

const stripNow = () => useMixerStore.getState().channels[CHANNEL]!;

/**
 * A strip with no slots, so the first `addInsert` lands on `slot1` and the §7.8 addresses
 * below read as they do in the panel. `createDefaultChannelStrip` opens four EMPTY slots
 * and `addInsert` appends past them (spec §1.3.1), which would put a fresh effect on slot 5.
 */
function emptyStrip(): ChannelStrip {
  return { ...createDefaultChannelStrip(CHANNEL), inserts: [] };
}

/** A strip as a project saved BEFORE this fix holds it: an effect, and no parameters. */
function stripWithEmptyParams(): ChannelStrip {
  const strip = createDefaultChannelStrip(CHANNEL);
  return {
    ...strip,
    inserts: [{ ...strip.inserts[0]!, effectType: 'delay', enabled: true, params: {} }],
  };
}

beforeEach(() => {
  resetTransientChannel();
  clearUndoHistory();
  useMixerStore.getState().setChannels({ [CHANNEL]: emptyStrip() });
});

describe('a slot the user creates (spec §5.7, issue #131)', () => {
  it('gives a freshly added insert the §5.7 defaults rather than an empty record', () => {
    useMixerStore.getState().addInsert(CHANNEL, 'delay');
    const slot = stripNow().inserts.at(-1)!;
    // §5.7's own default delay time, which is what `createInsert` already runs it at.
    expect(slot.params.time).toBe(350);
    expect(slot.params.feedback).toBe(0.35);
    expect(slot.params).toEqual(defaultEffectParams('delay'));
  });

  it('gives a replaced slot the INCOMING effect’s defaults and none of the outgoing values', () => {
    useMixerStore.getState().addInsert(CHANNEL, 'delay');
    const slotId = stripNow().inserts.at(-1)!.id;
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 1, 'feedback'), 0.9);

    useMixerStore.getState().replaceInsert(CHANNEL, slotId, 'reverb');

    const slot = stripNow().inserts[0]!;
    expect(slot.params).toEqual(defaultEffectParams('reverb'));
    // The rule `replaceInsert` already carried is unchanged: a name two effects share must
    // not import the old effect's taste. `feedback` is not a reverb parameter at all.
    expect(slot.params.feedback).toBeUndefined();
    expect(slot.params.size).toBe(1.8);
  });

  it('gives every §5.7 effect a value for every parameter its slot can address', () => {
    for (const effectType of EFFECT_TYPES) {
      useMixerStore.getState().setChannels({ [CHANNEL]: emptyStrip() });
      useMixerStore.getState().addInsert(CHANNEL, effectType);
      const params = stripNow().inserts.at(-1)!.params;
      for (const name of Object.keys(EFFECT_PARAM_RANGES[effectType])) {
        expect(params[name], `${effectType}.${name}`).toBeTypeOf('number');
      }
      // The wrapper's own dry/wet mix, which the §7.8 catalogue offers on EVERY slot even
      // where the per-effect table omits it — so a slot without one reads 0 (the MIX_RANGE
      // floor) while `createInsert` runs it fully wet.
      expect(params.mix, `${effectType}.mix`).toBeTypeOf('number');
    }
  });
});

describe('a slot loaded from a project saved before the fix (spec §4.4, issue #131)', () => {
  it('completes an empty params record on hydration', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: stripWithEmptyParams() });
    expect(stripNow().inserts[0]!.params.time).toBe(350);
  });

  it('completes one admitted through upsertChannel too', () => {
    useMixerStore.getState().upsertChannel(stripWithEmptyParams());
    expect(stripNow().inserts[0]!.params.time).toBe(350);
  });

  it('keeps the stored value wherever the project HAS one', () => {
    const stored = stripWithEmptyParams();
    useMixerStore.getState().setChannels({
      [CHANNEL]: {
        ...stored,
        inserts: [{ ...stored.inserts[0]!, params: { time: 20 } }],
      },
    });
    expect(stripNow().inserts[0]!.params.time).toBe(20);
    expect(stripNow().inserts[0]!.params.feedback).toBe(0.35);
  });

  it('leaves an EMPTY slot empty — there is no effect to default for', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: createDefaultChannelStrip(CHANNEL) });
    expect(stripNow().inserts[0]!.effectType).toBeNull();
    expect(stripNow().inserts[0]!.params).toEqual({});
  });

  /**
   * `mixerSync` diffs on `inserts` IDENTITY and rebuilds the whole serial chain when it
   * changes (spec §4.3). Completing a slot that is already complete must therefore hand back
   * the same objects, or every hydrate and every `upsertChannel` would tear the chain down.
   */
  it('does not change identity when there is nothing to complete', () => {
    useMixerStore.getState().setChannels({ [CHANNEL]: stripWithEmptyParams() });
    const completed = stripNow();
    useMixerStore.getState().upsertChannel(completed);
    expect(stripNow()).toBe(completed);
    expect(stripNow().inserts).toBe(completed.inserts);
    expect(stripNow().inserts[0]).toBe(completed.inserts[0]);
  });
});

describe('what the completion fixes downstream (spec §3.4, §4.1)', () => {
  it('takes the gesture origin from the running value, not from the range floor', () => {
    useMixerStore.getState().addInsert(CHANNEL, 'delay');
    const path = insertParamPath(CHANNEL, 1, 'time');

    // One drag: the store's pre-gesture value is what an undo has to return to.
    useMixerStore.getState().setTransient(path, 600);
    useMixerStore.getState().commit(path, 600);
    expect(stripNow().inserts[0]!.params.time).toBe(600);

    useUndoStore.getState().undo();
    // Without the completion the origin was `range[0]` — so undoing the first touch of a
    // fresh delay dropped it from 350 ms to 1 ms, a value it had never been set to.
    expect(stripNow().inserts[0]!.params.time).toBe(350);
  });

  it('reads the wrapper mix of an effect whose §5.7 row does not name one', () => {
    useMixerStore.getState().addInsert(CHANNEL, 'eq4');
    // `createInsert` runs a mix-less effect fully wet; the store used to read the 0 floor.
    expect(stripNow().inserts[0]!.params.mix).toBe(1);
  });
});
