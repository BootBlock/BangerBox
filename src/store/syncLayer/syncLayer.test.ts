/**
 * Sync-layer skeleton tests (spec §4.3, §3.5 lens 5). Subscribers forward only changed
 * fields to the bridge (diff-based), and the disposer leaves no live subscription.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from '../useMixerStore';
import { useTransportStore } from '../useTransportStore';
import { registerSyncSubscribers, type SyncBridge } from './index';

function fakeBridge(): SyncBridge {
  return {
    setChannelLevel: vi.fn(),
    setChannelPan: vi.fn(),
    setChannelMute: vi.fn(),
    setChannelSolo: vi.fn(),
    setChannelSend: vi.fn(),
    setChannelInserts: vi.fn(),
    setTransportPlaying: vi.fn(),
    setTransportRecording: vi.fn(),
    setBpm: vi.fn(),
    onActiveProgramChanged: vi.fn(),
    onQLinkModeChanged: vi.fn(),
  };
}

beforeEach(() => {
  useMixerStore.getState().setChannels({});
  useTransportStore.getState().stop();
});

describe('registerSyncSubscribers (spec §4.3)', () => {
  it('forwards only the changed mixer field to the bridge', () => {
    const bridge = fakeBridge();
    const dispose = registerSyncSubscribers(bridge);
    try {
      useMixerStore.getState().upsertChannel(createDefaultChannelStrip('track:1'));
      // Initial upsert applies every field once.
      expect(bridge.setChannelLevel).toHaveBeenCalledWith('track:1', 1);

      (bridge.setChannelLevel as ReturnType<typeof vi.fn>).mockClear();
      (bridge.setChannelPan as ReturnType<typeof vi.fn>).mockClear();
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
    (bridge.setBpm as ReturnType<typeof vi.fn>).mockClear();
    useTransportStore.getState().setBpm(99);
    useMixerStore.getState().upsertChannel(createDefaultChannelStrip('track:9'));
    expect(bridge.setBpm).not.toHaveBeenCalled();
    expect(bridge.setChannelLevel).not.toHaveBeenCalled();
  });
});
