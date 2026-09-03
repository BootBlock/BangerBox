/**
 * Sync-layer skeleton tests (spec §4.3, §3.5 lens 5). Subscribers forward only changed
 * fields to the bridge (diff-based), and the disposer leaves no live subscription.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from '../useMixerStore';
import { useTransportStore } from '../useTransportStore';
import { insertParamPath } from '@/core/audio/params/registry';
import { resetTransientChannel } from '../transientChannel';
import { registerSyncSubscribers, type SyncBridge } from './index';

/**
 * A bridge stub that grows its own spies on first access.
 *
 * The hand-listed version this replaces had already drifted: it was missing `removeChannel`
 * and `applyParam`, so a subscriber calling either threw rather than being asserted. That is
 * the same drift trap `sequencerSync.test.ts` records one layer up (issue #71) — and it is
 * what the §4.1 transient subscriber tripped over when it was added (issue #27).
 */
function fakeBridge(): SyncBridge & Record<string, ReturnType<typeof vi.fn>> {
  const spies = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get: (_target, property: string | symbol) => {
      if (typeof property !== 'string') return undefined;
      const existing = spies.get(property);
      if (existing) return existing;
      const spy = vi.fn();
      spies.set(property, spy);
      return spy;
    },
  }) as unknown as SyncBridge & Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  useMixerStore.getState().setChannels({});
  useTransportStore.getState().stop();
  resetTransientChannel();
});

describe('registerSyncSubscribers (spec §4.3)', () => {
  it('forwards only the changed mixer field to the bridge', () => {
    const bridge = fakeBridge();
    const dispose = registerSyncSubscribers(bridge);
    try {
      useMixerStore.getState().upsertChannel(createDefaultChannelStrip('track:1'));
      // Initial upsert applies every field once.
      expect(bridge.setChannelLevel).toHaveBeenCalledWith('track:1', 1);

      bridge.setChannelLevel.mockClear();
      bridge.setChannelPan.mockClear();
      useMixerStore.getState().commit('track:1.level', 0.5);
      expect(bridge.setChannelLevel).toHaveBeenCalledWith('track:1', 0.5);
      expect(bridge.setChannelPan).not.toHaveBeenCalled(); // pan unchanged — not touched
    } finally {
      dispose();
    }
  });

  it('forwards transport changes', () => {
    const bridge = fakeBridge();
    const dispose = registerSyncSubscribers(bridge);
    try {
      useTransportStore.getState().play();
      expect(bridge.setTransportPlaying).toHaveBeenCalledWith(true);
      useTransportStore.getState().setBpm(140);
      expect(bridge.setBpm).toHaveBeenCalledWith(140);
    } finally {
      dispose();
    }
  });

  it('leaves no live subscription after dispose (spec §3.5 lens 5)', () => {
    const bridge = fakeBridge();
    const dispose = registerSyncSubscribers(bridge);
    dispose();
    bridge.setBpm.mockClear();
    useTransportStore.getState().setBpm(99);
    useMixerStore.getState().upsertChannel(createDefaultChannelStrip('track:9'));
    useMixerStore.getState().setTransient('track:9.level', 0.2);
    expect(bridge.setBpm).not.toHaveBeenCalled();
    expect(bridge.setChannelLevel).not.toHaveBeenCalled();
    expect(bridge.applyParam).not.toHaveBeenCalled();
  });
});

/**
 * The §4.1 transient channel is the route a continuous gesture takes to the graph, now that
 * §3.3 forbids it going through a store write (issue #27).
 */
describe('the transient channel reaches the graph (spec §4.1, §4.3)', () => {
  it('applies a mid-gesture value through the registry address', () => {
    const bridge = fakeBridge();
    const dispose = registerSyncSubscribers(bridge);
    try {
      useMixerStore.getState().upsertChannel(createDefaultChannelStrip('track:1'));
      bridge.applyParam.mockClear();
      useMixerStore.getState().setTransient('mixer.track:1.level', 0.5);
      expect(bridge.applyParam).toHaveBeenCalledWith('mixer.track:1.level', 0.5);
    } finally {
      dispose();
    }
  });

  it('does NOT rebuild the insert chain per gesture frame (issue #27)', () => {
    const bridge = fakeBridge();
    const dispose = registerSyncSubscribers(bridge);
    try {
      const strip = createDefaultChannelStrip('track:1');
      useMixerStore.getState().upsertChannel({
        ...strip,
        inserts: [{ ...strip.inserts[0]!, effectType: 'delay', enabled: true }],
      });
      bridge.setChannelInserts.mockClear();
      const path = insertParamPath('track:1', 1, 'feedback');
      for (let sample = 0; sample < 10; sample += 1) {
        useMixerStore.getState().setTransient(path, sample / 20);
      }
      // Ten pointer samples used to be ten full teardown-and-rebuild passes over every
      // effect on the strip, because the mixer subscriber diffs on `inserts` identity.
      expect(bridge.setChannelInserts).not.toHaveBeenCalled();
      expect(bridge.applyParam).toHaveBeenCalledTimes(10);
    } finally {
      dispose();
    }
  });
});
