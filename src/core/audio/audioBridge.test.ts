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
    // The shape matters, not just the count: `null` marks a slot that holds no effect.
    setInserts: (inserts: unknown[]) => calls.push(['setInserts', inserts.map((i) => i !== null)]),
    insertLatencySamples: () => 0,
  } as unknown as ChannelHandle;
  return { handle, calls };
}

/**
 * A §4.2 id may name SEVERAL graph channels — a pad channel is realised once per track
 * playing its program (issue #141) — so the fake resolves an id to a list, like the real
 * {@link MixerGraph.channelsFor}. An entry may be one stub or an array of them.
 */
type FakeChannels = Record<
  string,
  ReturnType<typeof recordingChannel> | Array<ReturnType<typeof recordingChannel>>
>;

function fakeGraph(channels: FakeChannels) {
  return {
    channelsFor: (id: string) => {
      const entry = channels[id];
      if (entry === undefined) return [];
      return (Array.isArray(entry) ? entry : [entry]).map((stub) => stub.handle);
    },
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

  // Issue #141: two tracks playing one program each hold their own realisation of the pad
  // channel, and the §4.2 strip that supplies its values is still one strip. Every write the
  // bridge makes therefore addresses the STRIP and must reach both, or the fix would trade
  // "the second track's fader is bypassed" for "the pad's own fader only moves one track".
  it('fans a pad strip write out to every realisation of it (issue #141)', () => {
    const padOnA = recordingChannel('pad:prog1:0');
    const padOnB = recordingChannel('pad:prog1:0');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({
      graph: fakeGraph({ 'pad:prog1:0': [padOnA, padOnB] }),
      context,
    });

    bridge.setChannelLevel('pad:prog1:0', 0.4);
    bridge.setChannelPan('pad:prog1:0', -0.25);
    bridge.setChannelSend('pad:prog1:0', 2, 0.7);
    // A §7.8 lane on the same address is the same statement, applied at schedule time.
    bridge.applyAutomation('mixer.pad:prog1:0.level', 0.9, 1, 1);

    for (const [name, stub] of [
      ['the first track', padOnA],
      ['the second track', padOnB],
    ] as const) {
      expect(stub.calls, name).toEqual([
        ['setLevel', 0.4, context.currentTime],
        ['setPan', -0.25, context.currentTime],
        ['setSendGain', 2, 0.7, context.currentTime],
        ['setLevel', 0.9, 1],
      ]);
    }
  });

  it('mutes every realisation of a muted pad strip (spec §5.2, issue #141)', () => {
    const padOnA = recordingChannel('pad:prog1:0');
    const padOnB = recordingChannel('pad:prog1:0');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({
      graph: fakeGraph({ 'pad:prog1:0': [padOnA, padOnB], 'pad:prog1:1': recordingChannel('pad:prog1:1') }),
      context,
    });
    useMixerStore.setState({
      channels: {
        'pad:prog1:0': createDefaultChannelStrip('pad:prog1:0'),
        'pad:prog1:1': { ...createDefaultChannelStrip('pad:prog1:1'), solo: true },
      },
    });

    bridge.setChannelSolo('pad:prog1:1', true);

    // Solo-in-place is judged across the whole pad group and applied to both realisations.
    expect(padOnA.calls).toEqual([['setMuted', true, context.currentTime]]);
    expect(padOnB.calls).toEqual([['setMuted', true, context.currentTime]]);
  });

  // A channel built after its strip was edited — a track's first note, or a pad realised for
  // a second track (issue #141) — is seeded from the store, not left at the §4.2 defaults
  // `createChannelStrip` gives it.
  it('seeds one freshly built channel from its strip and the §5.2 mutes', () => {
    const fresh = recordingChannel('pad:prog1:0');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({ graph: fakeGraph({}), context });
    useMixerStore.setState({
      channels: {
        'pad:prog1:0': { ...createDefaultChannelStrip('pad:prog1:0'), level: 0.35, pan: 0.5 },
        'pad:prog1:1': { ...createDefaultChannelStrip('pad:prog1:1'), solo: true },
      },
    });

    bridge.seedChannel(fresh.handle);

    expect(fresh.calls).toEqual([
      ['setLevel', 0.35, context.currentTime, false],
      ['setPan', 0.5, context.currentTime, false],
      ['setSendGain', 0, 0, context.currentTime, false],
      ['setSendGain', 1, 0, context.currentTime, false],
      ['setSendGain', 2, 0, context.currentTime, false],
      ['setSendGain', 3, 0, context.currentTime, false],
      // Another pad is soloed, so this channel is silent from its very first note.
      ['setMuted', true, context.currentTime],
    ]);
    // An empty §1.3.1 rack needs no chain, so nothing is deferred for it either.
    expect(fresh.calls.some(([method]) => method === 'setInserts')).toBe(false);
  });

  // The chain is wired on a MICROTASK: `seedChannel` runs on §7.6's audition path, where
  // `createInsert('reverb')` synthesises an impulse response on the main thread. Building it
  // before `voicePool.trigger` would spend §11.5's touch-to-sound budget on the first hit.
  it('defers a freshly built channel’s insert chain off the trigger path (spec §11.5)', async () => {
    const fresh = recordingChannel('pad:prog1:0');
    const { context } = createFakeAudioContext();
    const graph = fakeGraph({ 'pad:prog1:0': fresh });
    const bridge = createAudioBridge({ graph, context });
    useMixerStore.setState({
      channels: {
        'pad:prog1:0': {
          ...createDefaultChannelStrip('pad:prog1:0'),
          inserts: [
            { id: 'slot-1', effectType: 'filter', enabled: true, params: {} },
            ...createDefaultChannelStrip('pad:prog1:0').inserts.slice(1),
          ],
        },
      },
    });

    bridge.seedChannel(fresh.handle);
    expect(fresh.calls.some(([method]) => method === 'setInserts')).toBe(false);

    await Promise.resolve();
    expect(fresh.calls.at(-1)).toEqual(['setInserts', [true, false, false, false]]);
  });

  it('drops the deferred chain when the channel has gone (spec §3.2, §5.3)', async () => {
    const doomed = recordingChannel('pad:prog1:0');
    const { context } = createFakeAudioContext();
    // The graph no longer holds this handle — a program change or a track delete destroyed
    // it between the seed and the microtask.
    const bridge = createAudioBridge({ graph: fakeGraph({}), context });
    useMixerStore.setState({
      channels: {
        'pad:prog1:0': {
          ...createDefaultChannelStrip('pad:prog1:0'),
          inserts: [
            { id: 'slot-1', effectType: 'filter', enabled: true, params: {} },
            ...createDefaultChannelStrip('pad:prog1:0').inserts.slice(1),
          ],
        },
      },
    });

    bridge.seedChannel(doomed.handle);
    await Promise.resolve();

    expect(doomed.calls.some(([method]) => method === 'setInserts')).toBe(false);
  });

  it('seeds a channel with no strip from the §5.2 mutes alone (spec §6)', () => {
    const fresh = recordingChannel('pad:other:3');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({ graph: fakeGraph({}), context });
    useMixerStore.setState({ channels: {} });

    bridge.seedChannel(fresh.handle);

    // No strip: the §6 payload the caller already applied stands, and only the mute is written.
    expect(fresh.calls).toEqual([['setMuted', false, context.currentTime]]);
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

  // One handle per §4.2 slot, `null` where the slot is empty, so a §7.8 `slotN` address
  // means the same thing to the graph as it does to the store (issue #134).
  it('rebuilds a channel insert chain, one entry per slot (spec §5.7, §7.8)', () => {
    const t1 = recordingChannel('track:t1');
    const { context } = createFakeAudioContext();
    const bridge = createAudioBridge({ graph: fakeGraph({ 'track:t1': t1 }), context });
    bridge.setChannelInserts('track:t1', [
      { id: 'a', effectType: 'filter', enabled: true, params: {} },
      { id: 'b', effectType: null, enabled: false, params: {} }, // empty slot, still a slot
      { id: 'c', effectType: 'delay', enabled: true, params: {} },
    ]);
    expect(t1.calls).toEqual([['setInserts', [true, false, true]]]);
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
