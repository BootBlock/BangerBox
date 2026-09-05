import { describe, expect, it } from 'vitest';
import { createFakeAudioContext, liveNodeCount, pendingParamCount } from '@/test/mocks/audioContext';
import { createTrackChannel, SEND_COUNT } from './factory';
import { faderLevelToGain } from './params/faderLaw';
import { MixerGraph } from './graph';
import { createInsert } from './inserts/insert';
import type { InsertHandle } from './types';
import type { EffectType } from '@/core/project/schemas';

describe('channel strip factory (spec §5.3)', () => {
  it('builds a strip with the fader at unity and closed sends', () => {
    const { context } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    expect(channel.id).toBe('track:t1');
    expect(channel.sends).toHaveLength(SEND_COUNT);
    channel.destroy();
  });

  it('applies the fader law when levels are set without dezipper', () => {
    const { context, fake } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    channel.setLevel(1.2, 0, false);
    // Some GainNode now carries the +6 dB gain the fader law maps 1.2 to (spec §8.5.6).
    const gains = fake.nodes.filter((n) => n.nodeType === 'gain') as unknown as Array<{
      gain: { value: number };
    }>;
    expect(gains.some((g) => Math.abs(g.gain.value - faderLevelToGain(1.2)) < 1e-9)).toBe(true);
    channel.destroy();
  });

  it('disconnects every node it created on destroy (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    channel.destroy();
    // None of the strip's own nodes retain an outbound connection.
    expect(liveNodeCount(fake)).toBe(0);
  });

  it('cancels scheduled param events on destroy (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    // Every automatable stage of the strip left holding automation, including the
    // open-ended `setTargetAtTime` the pan dezipper writes.
    channel.setLevel(0.7, 0);
    channel.setPan(-0.4, 0);
    channel.setMuted(true, 0);
    for (let i = 0; i < SEND_COUNT; i++) channel.setSendGain(i, 0.5, 0);
    expect(pendingParamCount(fake)).toBeGreaterThan(0);
    channel.destroy();
    expect(pendingParamCount(fake)).toBe(0);
  });

  it('cancels the params of an insert chain it disposes (spec §3.2, §5.7)', () => {
    const { context, fake } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    channel.setInserts([createInsert(context, 'delay')]);
    // §7.8 addresses a slot 1-based, so slot 1 is the first one (issue #134).
    channel.setInsertParam(1, 'feedback', 0.8, 0);
    channel.setInserts([]); // chain replaced — the old handles are disposed
    channel.destroy();
    expect(pendingParamCount(fake)).toBe(0);
  });
});

/**
 * A §7.8 `slotN` address means the same thing to the graph as it does to the store
 * (issue #134). The chain used to be COMPACTED, so the index a §7.8 address carries and the
 * index of the handle it reached were two different numbers whenever a slot was empty — and
 * they were off by one even when none was.
 */
describe('insert slot addressing (spec §5.7, §7.8)', () => {
  /** An insert that records the parameter writes the channel routes to it. */
  function watched(context: BaseAudioContext, effectType: EffectType) {
    const inner = createInsert(context, effectType);
    const writes: string[] = [];
    const handle: InsertHandle = {
      ...inner,
      setParam: (name, value, when) => {
        writes.push(`${name}=${value}`);
        inner.setParam(name, value, when);
      },
    };
    return { handle, writes };
  }

  /** Whether the fake graph carries an edge from `from` to `to`. */
  function connects(from: AudioNode, to: AudioNode): boolean {
    return (from as unknown as { outputs: unknown[] }).outputs.includes(to);
  }

  it('reaches the effect in the slot the §7.8 address names', () => {
    const { context } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    const only = watched(context, 'delay');
    channel.setInserts([only.handle]);
    channel.setInsertParam(1, 'time', 500, 0);
    expect(only.writes).toEqual(['time=500']);
  });

  it('holds an empty slot open, so the effect behind it keeps its own address', () => {
    const { context } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    // Slot 1 empty, slot 2 a delay — what `applyInserts` builds for a strip whose user put
    // the effect in the second slot. Compacted, `slot2` addressed nothing at all.
    const second = watched(context, 'delay');
    channel.setInserts([null, second.handle]);
    channel.setInsertParam(2, 'time', 500, 0);
    channel.setInsertParam(1, 'time', 900, 0); // the empty slot addresses nothing
    expect(second.writes).toEqual(['time=500']);
  });

  it('sends each address to its own effect when two slots are occupied', () => {
    const { context } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    const one = watched(context, 'filter');
    const two = watched(context, 'delay');
    channel.setInserts([one.handle, two.handle]);
    channel.setInsertParam(1, 'cutoff', 300, 0);
    channel.setInsertParam(2, 'time', 500, 0);
    expect(one.writes).toEqual(['cutoff=300']);
    expect(two.writes).toEqual(['time=500']);
  });

  it('wires only the occupied slots, in order', () => {
    const { context } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    const first = createInsert(context, 'delay');
    const second = createInsert(context, 'filter');
    channel.setInserts([null, first, null, second]);
    // input → first → second → the rest of the strip; an empty slot adds no node.
    expect(connects(channel.input, first.input)).toBe(true);
    expect(connects(first.output, second.input)).toBe(true);
  });

  it('sums only the occupied slots' + "' PDC latency (spec §5.7.3)", () => {
    const { context } = createFakeAudioContext();
    const channel = createTrackChannel(context, 't1');
    channel.setInserts([null, createInsert(context, 'delay'), null]);
    expect(channel.insertLatencySamples()).toBe(0); // native effects report none
  });
});

describe('mixer graph topology (spec §5.2)', () => {
  it('wires returns and monitor bus into the master/destination', () => {
    const { context, fake } = createFakeAudioContext();
    const graph = new MixerGraph(context);
    expect(graph.returns).toHaveLength(4);
    // master output → destination, monitor bus → destination.
    const toDestination = fake.nodes.filter((n) => n.outputs.includes(fake.destination));
    expect(toDestination.length).toBeGreaterThanOrEqual(2);
    // returns carry no sends (feedback-safe, spec §5.2).
    for (const ret of graph.returns) expect(ret.sends).toHaveLength(0);
    graph.destroy();
  });

  it('creates track and pad channels on demand and routes pad→track→master', () => {
    const { context } = createFakeAudioContext();
    const graph = new MixerGraph(context);
    const track = graph.ensureTrackChannel('t1');
    const pad = graph.ensurePadChannel('pad:prog1:0', 't1', track.channel.input);
    expect(track.created).toBe(true);
    expect(pad.created).toBe(true);
    expect(graph.channelsFor('track:t1')).toEqual([track.channel]);
    expect(graph.channelsFor('pad:prog1:0')).toEqual([pad.channel]);
    expect(graph.channelsFor('master')).toEqual([graph.master]);
    expect(graph.channelsFor('return:2')).toEqual([graph.returns[2]]);
    expect(graph.channelsFor('track:nothing')).toEqual([]);
    // ensure* is idempotent, and only the first call reports having built anything — which
    // is what tells a caller to seed the channel from its §4.2 strip exactly once.
    const trackAgain = graph.ensureTrackChannel('t1');
    expect(trackAgain.channel).toBe(track.channel);
    expect(trackAgain.created).toBe(false);
    const again = graph.ensurePadChannel('pad:prog1:0', 't1', track.channel.input);
    expect(again.channel).toBe(pad.channel);
    expect(again.created).toBe(false);
    graph.destroy();
  });

  it('tears the whole graph down leaving no connected nodes (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const graph = new MixerGraph(context);
    const track = graph.ensureTrackChannel('t1').channel;
    graph.ensurePadChannel('pad:prog1:0', 't1', track.input);
    graph.destroy();
    expect(liveNodeCount(fake)).toBe(0);
  });

  // Two tracks that play ONE program (issue #141). §5.2 stage 5 places "all pad outputs of
  // the program on a track" at that track's input, and a `pad:<prog>:<idx>` id carries no
  // track — so a graph that keys the channel by the id alone wires the pad to whichever
  // track triggered it first, and the second track's whole strip is bypassed for that pad.
  describe('two tracks on one program (issue #141)', () => {
    /** Whether the fake graph carries an edge from `from` to `to`. */
    const connects = (from: AudioNode, to: AudioNode): boolean =>
      (from as unknown as { outputs: unknown[] }).outputs.includes(to);

    it('gives each track its own realisation of the pad channel, into its own input', () => {
      const { context } = createFakeAudioContext();
      const graph = new MixerGraph(context);
      const trackA = graph.ensureTrackChannel('a').channel;
      const trackB = graph.ensureTrackChannel('b').channel;
      const padA = graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input);
      const padB = graph.ensurePadChannel('pad:prog1:0', 'b', trackB.input);

      expect(padA.created).toBe(true);
      expect(padB.created).toBe(true);
      expect(padB.channel).not.toBe(padA.channel);
      // Each realisation reaches its OWN track's input and nothing else (spec §5.2 stage 5).
      expect(connects(padA.channel.output, trackA.input)).toBe(true);
      expect(connects(padA.channel.output, trackB.input)).toBe(false);
      expect(connects(padB.channel.output, trackB.input)).toBe(true);
      expect(connects(padB.channel.output, trackA.input)).toBe(false);
      // Both carry the same §4.2 id: one strip, one §7.8 address, one §6 record.
      expect(padA.channel.id).toBe('pad:prog1:0');
      expect(padB.channel.id).toBe('pad:prog1:0');
      graph.destroy();
    });

    it('resolves the §4.2 id to every realisation, so one strip write reaches them all', () => {
      const { context } = createFakeAudioContext();
      const graph = new MixerGraph(context);
      const trackA = graph.ensureTrackChannel('a').channel;
      const trackB = graph.ensureTrackChannel('b').channel;
      const padA = graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input).channel;
      const padB = graph.ensurePadChannel('pad:prog1:0', 'b', trackB.input).channel;

      const resolved = graph.channelsFor('pad:prog1:0');
      expect(resolved).toHaveLength(2);
      expect(new Set(resolved)).toEqual(new Set([padA, padB]));
      // A track id still resolves to exactly one channel.
      expect(graph.channelsFor('track:a')).toEqual([trackA]);
      graph.destroy();
    });

    it('sends the tempo fan-out to every realisation (spec §7.2)', () => {
      const { context } = createFakeAudioContext();
      const graph = new MixerGraph(context);
      const trackA = graph.ensureTrackChannel('a').channel;
      const trackB = graph.ensureTrackChannel('b').channel;
      graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input);
      graph.ensurePadChannel('pad:prog1:0', 'b', trackB.input);
      // Master, four returns, two tracks and BOTH pad realisations.
      expect(graph.allChannels()).toHaveLength(9);
      graph.destroy();
    });

    it('takes a deleted track’s pad realisation with it and leaves the other sounding', () => {
      const { context, fake } = createFakeAudioContext();
      const graph = new MixerGraph(context);
      const trackA = graph.ensureTrackChannel('a').channel;
      const trackB = graph.ensureTrackChannel('b').channel;
      graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input);
      const padB = graph.ensurePadChannel('pad:prog1:0', 'b', trackB.input).channel;
      const before = liveNodeCount(fake);

      graph.removeTrackChannel('a');

      // Track A's realisation is gone; track B's is untouched and still reaches its input.
      expect(graph.channelsFor('pad:prog1:0')).toEqual([padB]);
      expect(graph.channelsFor('track:a')).toEqual([]);
      expect(connects(padB.output, trackB.input)).toBe(true);
      // §3.2: the deleted track's pad realisation is not left connected to a dead input.
      expect(liveNodeCount(fake)).toBeLessThan(before);
      graph.destroy();
      expect(liveNodeCount(fake)).toBe(0);
    });

    it('destroys every realisation when the §4.2 strip itself leaves (spec §5.3)', () => {
      const { context, fake } = createFakeAudioContext();
      const graph = new MixerGraph(context);
      const trackA = graph.ensureTrackChannel('a').channel;
      const trackB = graph.ensureTrackChannel('b').channel;
      graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input);
      graph.ensurePadChannel('pad:prog1:0', 'b', trackB.input);

      graph.removePadChannel('pad:prog1:0');

      expect(graph.channelsFor('pad:prog1:0')).toEqual([]);
      // Rebuilding after a removal reports `created` again, so the caller re-seeds it.
      expect(graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input).created).toBe(true);
      graph.destroy();
      expect(liveNodeCount(fake)).toBe(0);
    });

    it('tears down both realisations on a full teardown (spec §3.2)', () => {
      const { context, fake } = createFakeAudioContext();
      const graph = new MixerGraph(context);
      const trackA = graph.ensureTrackChannel('a').channel;
      const trackB = graph.ensureTrackChannel('b').channel;
      graph.ensurePadChannel('pad:prog1:0', 'a', trackA.input).channel.setLevel(0.5, 0);
      graph.ensurePadChannel('pad:prog1:0', 'b', trackB.input).channel.setPan(0.3, 0);
      graph.destroy();
      expect(liveNodeCount(fake)).toBe(0);
      expect(pendingParamCount(fake)).toBe(0);
    });
  });

  it('leaves no param holding automation after teardown (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const graph = new MixerGraph(context);
    const track = graph.ensureTrackChannel('t1').channel;
    const pad = graph.ensurePadChannel('pad:prog1:0', 't1', track.input).channel;
    pad.setLevel(0.5, 0);
    pad.setPan(0.3, 0);
    track.setSendGain(0, 0.6, 0);
    graph.master.setMuted(true, 0);
    graph.destroy();
    expect(pendingParamCount(fake)).toBe(0);
  });
});
