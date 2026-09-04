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
    const pad = graph.ensurePadChannel('pad:prog1:0', track.input);
    expect(graph.getChannel('track:t1')).toBe(track);
    expect(graph.getChannel('pad:prog1:0')).toBe(pad);
    expect(graph.getChannel('master')).toBe(graph.master);
    expect(graph.getChannel('return:2')).toBe(graph.returns[2]);
    // ensure* is idempotent.
    expect(graph.ensureTrackChannel('t1')).toBe(track);
    graph.destroy();
  });

  it('tears the whole graph down leaving no connected nodes (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const graph = new MixerGraph(context);
    const track = graph.ensureTrackChannel('t1');
    graph.ensurePadChannel('pad:prog1:0', track.input);
    graph.destroy();
    expect(liveNodeCount(fake)).toBe(0);
  });

  it('leaves no param holding automation after teardown (spec §3.2)', () => {
    const { context, fake } = createFakeAudioContext();
    const graph = new MixerGraph(context);
    const track = graph.ensureTrackChannel('t1');
    const pad = graph.ensurePadChannel('pad:prog1:0', track.input);
    pad.setLevel(0.5, 0);
    pad.setPan(0.3, 0);
    track.setSendGain(0, 0.6, 0);
    graph.master.setMuted(true, 0);
    graph.destroy();
    expect(pendingParamCount(fake)).toBe(0);
  });
});
