import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultChannelStrip } from '@/core/project/schemas';
import { useMixerStore } from '@/store';
import { createFakeAudioContext } from '@/test/mocks/audioContext';
import { createAudioBridge } from './audioBridge';
import type { ChannelHandle } from './factory';
import type { MixerGraph } from './graph';

/** A recording channel stub so we assert bridge → channel calls directly. */
function recordingChannel(id: string) {
  const calls: Array<[string, ...unknown[]]> = [];
  const handle = {
    id,
    setLevel: (...a: unknown[]) => calls.push(['setLevel', ...a]),
    setPan: (...a: unknown[]) => calls.push(['setPan', ...a]),
    setMuted: (...a: unknown[]) => calls.push(['setMuted', ...a]),
    setSendGain: (...a: unknown[]) => calls.push(['setSendGain', ...a]),
    setInserts: (inserts: unknown[]) => calls.push(['setInserts', inserts.length]),
    insertLatencySamples: () => 0,
  } as unknown as ChannelHandle;
  return { handle, calls };
}

function fakeGraph(channels: Record<string, ReturnType<typeof recordingChannel>>) {
  return {
    getChannel: (id: string) => channels[id]?.handle,
  } as unknown as MixerGraph;
}

afterEach(() => useMixerStore.setState({ channels: {} }));

describe('audio bridge (spec §4.3, §5.2)', () => {
  it('ramps the addressed channel level and pan', () => {
    const t1 = recordingChannel('track:t1');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({ graph: fakeGraph({ 'track:t1': t1 }), context });
    bridge.setChannelLevel('track:t1', 1.2);
    bridge.setChannelPan('track:t1', -0.5);
    expect(t1.calls).toEqual([
      ['setLevel', 1.2, context.currentTime],
      ['setPan', -0.5, context.currentTime],
    ]);
  });

  it('applies solo-in-place computed mutes across every channel (spec §5.2)', () => {
    const t1 = recordingChannel('track:t1');
    const t2 = recordingChannel('track:t2');
    const master = recordingChannel('master');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({
      graph: fakeGraph({ 'track:t1': t1, 'track:t2': t2, master }),
      context,
    });
    useMixerStore.setState({
      channels: {
        'track:t1': { ...createDefaultChannelStrip('track:t1'), solo: true },
        'track:t2': createDefaultChannelStrip('track:t2'),
        master: createDefaultChannelStrip('master'),
      },
    });
    bridge.setChannelSolo('track:t1', true);

    const mutedOf = (c: typeof t1) => c.calls.find(([m]) => m === 'setMuted')?.[1];
    expect(mutedOf(t1)).toBe(false); // soloed → audible
    expect(mutedOf(t2)).toBe(true); // not soloed → muted
    expect(mutedOf(master)).toBe(false); // master unaffected by solo
  });

  it('rebuilds a channel insert chain from enabled slot state (spec §5.7)', () => {
    const t1 = recordingChannel('track:t1');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({ graph: fakeGraph({ 'track:t1': t1 }), context });
    bridge.setChannelInserts('track:t1', [
      { id: 'a', effectType: 'filter', enabled: true, params: {} },
      { id: 'b', effectType: null, enabled: false, params: {} }, // empty slot skipped
    ]);
    expect(t1.calls).toEqual([['setInserts', 1]]);
  });

  it('resyncAll flushes existing strips into the graph without throwing', () => {
    const master = recordingChannel('master');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({ graph: fakeGraph({ master }), context });
    useMixerStore.setState({ channels: { master: createDefaultChannelStrip('master') } });
    expect(() => bridge.resyncAll()).not.toThrow();
    expect(master.calls.some(([m]) => m === 'setLevel')).toBe(true);
  });
});
