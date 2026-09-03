/**
 * The mixer store must accept the canonical §7.8 parameter addresses that the registry
 * builders produce — that is the grammar the Mixer, XYFX and Q-Link surfaces all address
 * parameters with (spec §7.8, §10.3). The store once parsed only a bare
 * `<channelId>.<field>` form, so canonical addresses silently no-opped and those controls
 * were dead (spec §3.4 forbids dead controls); these tests pin the regression shut.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  insertParamPath,
} from '@/core/audio/params/registry';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from './useMixerStore';
import { resetTransientChannel, subscribeTransientChannel } from './transientChannel';
import { useUndoStore } from './undo';

const CHANNEL = 'track:1';

/**
 * What the §4.1 transient channel published, in order (issue #27).
 *
 * A transient no longer writes the store: it is a §3.3 continuous value, so it goes straight
 * to the §4.3 sync layer and React never sees it. These tests therefore read what reached the
 * channel — which is what actually reaches the graph — rather than the store, which is where
 * the same value used to be asserted while it re-rendered every consumer of `channels`.
 */
let published: { path: string; value: number }[] = [];
let unsubscribe: (() => void) | null = null;

function seed() {
  published = [];
  resetTransientChannel();
  unsubscribe?.();
  unsubscribe = subscribeTransientChannel((path, value) => published.push({ path, value }));
  const strip = createDefaultChannelStrip(CHANNEL);
  useMixerStore.getState().setChannels({
    [CHANNEL]: { ...strip, inserts: [{ ...strip.inserts[0]!, effectType: 'delay', enabled: true }] },
  });
}

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  resetTransientChannel();
});

const stripNow = () => useMixerStore.getState().channels[CHANNEL]!;
/** The last value published for `path`, or undefined when the address reached nothing. */
const publishedFor = (path: string) => published.filter((entry) => entry.path === path).at(-1)?.value;

describe('canonical registry addresses (spec §7.8)', () => {
  beforeEach(seed);

  it('applies a transient level change addressed by the registry builder', () => {
    useMixerStore.getState().setTransient(channelLevelPath(CHANNEL), 0.5);
    expect(publishedFor(channelLevelPath(CHANNEL))).toBe(0.5);
  });

  it('applies a transient pan change addressed by the registry builder', () => {
    useMixerStore.getState().setTransient(channelPanPath(CHANNEL), -0.75);
    expect(publishedFor(channelPanPath(CHANNEL))).toBe(-0.75);
  });

  it('applies a transient send change addressed by the registry builder', () => {
    useMixerStore.getState().setTransient(channelSendPath(CHANNEL, 2), 0.4);
    expect(publishedFor(channelSendPath(CHANNEL, 2))).toBe(0.4);
  });

  it('commits a canonical level change', () => {
    useMixerStore.getState().commit(channelLevelPath(CHANNEL), 0.25);
    expect(stripNow().level).toBe(0.25);
  });

  it('still accepts the bare channel-scoped form, canonicalised on the way out', () => {
    // The legacy address predates the §7.8 registry and a persisted Q-Link binding may still
    // carry one. It has to be rewritten before publishing: the §4.3 subscriber applies an
    // address through the registry's parser, which does not know this form (issue #27).
    useMixerStore.getState().setTransient(`${CHANNEL}.level`, 0.4);
    expect(publishedFor(channelLevelPath(CHANNEL))).toBe(0.4);
  });

  it('clamps a canonical address to the registry range', () => {
    useMixerStore.getState().setTransient(channelPanPath(CHANNEL), 5);
    expect(publishedFor(channelPanPath(CHANNEL))).toBe(1);
  });

  it('ignores an unregistered address', () => {
    useMixerStore.getState().setTransient('mixer.track:1.nonsense', 0.5);
    expect(published).toEqual([]);
    expect(stripNow().level).toBe(1);
  });

  it('ignores an address for a channel that does not exist', () => {
    useMixerStore.getState().setTransient(channelLevelPath('track:absent'), 0.5);
    expect(published).toEqual([]);
    expect(stripNow().level).toBe(1);
  });
});

describe('insert parameter addresses (spec §7.8 `insert:<channelId>:slot<N>.<param>`)', () => {
  beforeEach(seed);

  it('publishes an insert parameter at its slot address', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'feedback'), 0.5);
    expect(publishedFor(insertParamPath(CHANNEL, 1, 'feedback'))).toBe(0.5);
  });

  it('leaves the inserts array alone, so the chain is not rebuilt per frame (issue #27)', () => {
    // The §4.3 mixer subscriber diffs on `inserts` identity and rebuilds the WHOLE serial
    // chain when it changes, so a `set()` per pointer sample tore down and recreated every
    // effect on the strip sixty times a second. The transient reaches the graph as one
    // `setInsertParam` ramp instead, and the array is untouched until the commit.
    const before = stripNow().inserts;
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'feedback'), 0.5);
    expect(stripNow().inserts).toBe(before);
  });

  it('clamps an insert parameter to the effect range (spec §5.7)', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'feedback'), 5);
    expect(publishedFor(insertParamPath(CHANNEL, 1, 'feedback'))).toBe(0.95);
  });

  it('accepts the wrapper-level mix common to every effect', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'mix'), 0.3);
    expect(publishedFor(insertParamPath(CHANNEL, 1, 'mix'))).toBe(0.3);
  });

  it('commits an insert parameter, which DOES replace the array (spec §4.3 diffing)', () => {
    const before = stripNow().inserts;
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 1, 'feedback'), 0.6);
    expect(stripNow().inserts).not.toBe(before);
  });

  it('commits an insert parameter', () => {
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 1, 'feedback'), 0.6);
    expect(stripNow().inserts[0]!.params.feedback).toBe(0.6);
  });

  it('ignores a parameter the slot effect does not expose', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'cutoff'), 500);
    expect(published).toEqual([]);
    expect(stripNow().inserts[0]!.params.cutoff).toBeUndefined();
  });

  it('ignores an empty slot', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 2, 'feedback'), 0.5);
    expect(published).toEqual([]);
    expect(stripNow().inserts[1]).toBeUndefined();
  });
});

/**
 * Issue #27 and spec §3.3: a mid-gesture value MUST NOT reach React. `setTransient` used to
 * be an ordinary `set()`, which replaces the `channels` map's identity and so re-renders
 * every component selecting it — `MixerMode`, `MutingMode`, `XyfxMode` and `QLinkEditMode` —
 * on every pointer sample and every rAF-aligned CC frame.
 */
describe('a gesture never re-renders a React consumer (spec §3.3, issue #27)', () => {
  beforeEach(seed);

  it('leaves the channels map identical through a whole drag', () => {
    const before = useMixerStore.getState().channels;
    const path = channelLevelPath(CHANNEL);
    for (let sample = 0; sample < 60; sample += 1) {
      useMixerStore.getState().setTransient(path, sample / 60);
    }
    expect(useMixerStore.getState().channels).toBe(before);
    expect(useMixerStore.getState().channels[CHANNEL]).toBe(before[CHANNEL]);
  });

  it('notifies no store subscriber during the drag, and exactly once at the commit', () => {
    let notifications = 0;
    const stop = useMixerStore.subscribe(
      (state) => state.channels,
      () => {
        notifications += 1;
      },
    );
    const path = channelLevelPath(CHANNEL);
    for (let sample = 0; sample < 60; sample += 1) {
      useMixerStore.getState().setTransient(path, sample / 60);
    }
    expect(notifications).toBe(0);
    useMixerStore.getState().commit(path, 0.75);
    expect(notifications).toBe(1);
    stop();
  });

  it('still lands the gesture on the graph, sample by sample', () => {
    const path = channelLevelPath(CHANNEL);
    useMixerStore.getState().setTransient(path, 0.25);
    useMixerStore.getState().setTransient(path, 0.5);
    expect(published.map((entry) => entry.value)).toEqual([0.25, 0.5]);
  });

  it('publishes the COMMITTED value, which need not be where the gesture left off', () => {
    // XYFX's release-return commits where the axis RESTED, not where the pointer let go. The
    // store never moved during the gesture, so a §4.3 diff sees no change and would leave the
    // graph on the gesture's last position — the commit has to say so explicitly (issue #27).
    const path = channelLevelPath(CHANNEL);
    useMixerStore.getState().setTransient(path, 0.2);
    useMixerStore.getState().commit(path, 1);
    expect(published.at(-1)).toEqual({ path, value: 1 });
  });

  it('records one undo entry back to the PRE-gesture value, not to the last sample', () => {
    const path = channelLevelPath(CHANNEL);
    useMixerStore.getState().setTransient(path, 0.2);
    useMixerStore.getState().setTransient(path, 0.3);
    useMixerStore.getState().commit(path, 0.4);
    expect(stripNow().level).toBe(0.4);
    useUndoStore.getState().undo();
    expect(stripNow().level).toBe(1);
  });
});
