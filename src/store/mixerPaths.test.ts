/**
 * The mixer store must accept the canonical §7.8 parameter addresses that the registry
 * builders produce — that is the grammar the Mixer, XYFX, and (Phase 8) Q-Link surfaces
 * all address parameters with (spec §7.8, §10.3). Before Phase 8 the store parsed only a
 * bare `<channelId>.<field>` form, so canonical addresses silently no-opped and those
 * controls were dead (spec §3.4 forbids dead controls).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  channelLevelPath,
  channelPanPath,
  channelSendPath,
  insertParamPath,
} from '@/core/audio/params/registry';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from './useMixerStore';

const CHANNEL = 'track:1';

function seed() {
  const strip = createDefaultChannelStrip(CHANNEL);
  useMixerStore.getState().setChannels({
    [CHANNEL]: { ...strip, inserts: [{ ...strip.inserts[0]!, effectType: 'delay', enabled: true }] },
  });
}

const stripNow = () => useMixerStore.getState().channels[CHANNEL]!;

describe('canonical registry addresses (spec §7.8)', () => {
  beforeEach(seed);

  it('applies a transient level change addressed by the registry builder', () => {
    useMixerStore.getState().setTransient(channelLevelPath(CHANNEL), 0.5);
    expect(stripNow().level).toBe(0.5);
  });

  it('applies a transient pan change addressed by the registry builder', () => {
    useMixerStore.getState().setTransient(channelPanPath(CHANNEL), -0.75);
    expect(stripNow().pan).toBe(-0.75);
  });

  it('applies a transient send change addressed by the registry builder', () => {
    useMixerStore.getState().setTransient(channelSendPath(CHANNEL, 2), 0.4);
    expect(stripNow().sendLevels[2]).toBe(0.4);
  });

  it('commits a canonical level change', () => {
    useMixerStore.getState().commit(channelLevelPath(CHANNEL), 0.25);
    expect(stripNow().level).toBe(0.25);
  });

  it('still accepts the bare channel-scoped form', () => {
    useMixerStore.getState().setTransient(`${CHANNEL}.level`, 0.4);
    expect(stripNow().level).toBe(0.4);
  });

  it('clamps a canonical address to the registry range', () => {
    useMixerStore.getState().setTransient(channelPanPath(CHANNEL), 5);
    expect(stripNow().pan).toBe(1);
  });

  it('ignores an unregistered address', () => {
    useMixerStore.getState().setTransient('mixer.track:1.nonsense', 0.5);
    expect(stripNow().level).toBe(1);
  });

  it('ignores an address for a channel that does not exist', () => {
    useMixerStore.getState().setTransient(channelLevelPath('track:absent'), 0.5);
    expect(stripNow().level).toBe(1);
  });
});

describe('insert parameter addresses (spec §7.8 `insert:<channelId>:slot<N>.<param>`)', () => {
  beforeEach(seed);

  it('writes an insert parameter into the owning slot', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'feedback'), 0.5);
    expect(stripNow().inserts[0]!.params.feedback).toBe(0.5);
  });

  it('replaces the inserts array so the sync layer sees the change (spec §4.3 diffing)', () => {
    const before = stripNow().inserts;
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'feedback'), 0.5);
    expect(stripNow().inserts).not.toBe(before);
  });

  it('clamps an insert parameter to the effect range (spec §5.7)', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'feedback'), 5);
    expect(stripNow().inserts[0]!.params.feedback).toBe(0.95);
  });

  it('accepts the wrapper-level mix common to every effect', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'mix'), 0.3);
    expect(stripNow().inserts[0]!.params.mix).toBe(0.3);
  });

  it('commits an insert parameter', () => {
    useMixerStore.getState().commit(insertParamPath(CHANNEL, 1, 'feedback'), 0.6);
    expect(stripNow().inserts[0]!.params.feedback).toBe(0.6);
  });

  it('ignores a parameter the slot effect does not expose', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 1, 'cutoff'), 500);
    expect(stripNow().inserts[0]!.params.cutoff).toBeUndefined();
  });

  it('ignores an empty slot', () => {
    useMixerStore.getState().setTransient(insertParamPath(CHANNEL, 2, 'feedback'), 0.5);
    expect(stripNow().inserts[1]).toBeUndefined();
  });
});
