import { describe, expect, it } from 'vitest';
import { createFakeAudioContext, liveNodeCount, pendingParamCount } from '@/test/mocks/audioContext';
import { createTrackChannel, SEND_COUNT } from './factory';
import { faderLevelToGain } from './params/faderLaw';
import { MixerGraph } from './graph';
import { createInsert } from './inserts/insert';

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
    channel.setInsertParam(0, 'feedback', 0.8, 0);
    channel.setInserts([]); // chain replaced — the old handles are disposed
    channel.destroy();
    expect(pendingParamCount(fake)).toBe(0);
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
